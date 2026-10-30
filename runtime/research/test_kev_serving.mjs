import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENCODING_LIMITS, HASH_CONTRACT, KEV_COMMIT, SERVING_ENV, emitKevServing, encodingProbeWire, pythonBootstrap } from './kev-serving.mts'

const upstream = process.env.KEV_UPSTREAM_ROOT ?? '/home/admin/harness-engineering-platform-data/.local/medium-security-transfer/kev'
const python = process.env.KEV_TEST_PYTHON ?? '/usr/bin/python3.10'
const hasApi = existsSync(join(upstream, 'kev/api.py'))
const digest = value => createHash('sha256').update(value).digest('hex')
const serving = { run: '/models/locked-unit-checkpoint', base: 'Qwen/Qwen3.5-0.8B-Base', temperature: 1.25, dtype: 'float32', backend: 'torch', device: 'cuda' }
const questions = Object.fromEntries(['route', 'evidence', 'priority'].map(key => [key, { type: 'choice', instructions: '固定测试问题', criteria: { a: '甲', b: '乙' } }]))

function fixture(t) {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/kev-serving-test-'))
  writeFileSync(join(root, 'bootstrap.py'), pythonBootstrap())
  const config = { schema_version: 'kev-serving-admission/v1', encoder_revision: KEV_COMMIT,
    encoder_source_sha256: 'a'.repeat(64), admission_source_sha256: digest(pythonBootstrap()),
    limits: ENCODING_LIMITS, hash_contract: HASH_CONTRACT, serving }
  writeFileSync(join(root, 'config.json'), JSON.stringify(config))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    config,
    run(body, input = {}) {
      const result = spawnSync(python, ['-c', PYTHON_FIXTURE + '\n' + body, root, upstream], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
      })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return JSON.parse(result.stdout)
    },
  }
}

// 执行真实生成物、FastAPI和官方api.to_record；仅模型编码/前向与原生认证服务边界使用测试替身。
// 这些测试不构成真实tokenizer、GPU或业务效果验证。
const PYTHON_FIXTURE = String.raw`
import importlib.util, json, pathlib, sys, types
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])
spec = importlib.util.spec_from_file_location("admission", root/"bootstrap.py")
admission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admission)
config = json.loads((root/"config.json").read_text())
data = json.load(sys.stdin)
from kev.api import SystemOneRequest

class Model:
    def __init__(self):
        self.calls = []
        self.counts = (3, [4, 4, 4])
        self.error = None
        self.truncated = False
    def encode(self, tok, rec, **kwargs):
        self.calls.append({"same_tokenizer": tok is tokenizer, "record": rec, "kwargs": kwargs})
        if self.error is not None: raise self.error
        state, branches = self.counts
        seg = [0] * state
        for index, count in enumerate(branches, 1): seg += [index] * count
        return {"seg": seg, "ids": list(range(len(seg))), "state_tokens": state, "state_truncated": self.truncated}

tokenizer = object()
def native_service(api_key=""):
    model = Model()
    stats = {"forwards": 0}
    app = FastAPI()
    server = types.SimpleNamespace(model=model, tok=tokenizer, truncate_states=False)
    app.state.server = server
    card = {"name": "kev-latest", **config["serving"], "truncate_states": False, "cuda_graphs": None}
    def models(): return {"models": [card]}
    @app.middleware("http")
    async def native_auth(request, call_next):
        if api_key and request.url.path.startswith("/v1") and request.headers.get("authorization") != "Bearer " + api_key:
            response = JSONResponse({"detail": "native test authentication rejected"}, status_code=401, headers={"www-authenticate": "Bearer"})
        else: response = await call_next(request)
        response.headers["x-typesafe-request-id"] = request.headers.get("x-typesafe-request-id", "native-generated-id")
        response.headers["server-timing"] = "app;dur=0.1"
        return response
    @app.get("/v1/models")
    def list_models(): return models()
    @app.post("/v1/systemone")
    def forward(req: SystemOneRequest):
        stats["forwards"] += 1
        return JSONResponse({"model": req.model, "answers": {"a": "fixture-forward"}, "usage": {"input_tokens": 15, "output_tokens": 7}, "latency_ms": 0.25}, status_code=stats.get("status", 200))
    @app.get("/native")
    def untouched(): return {"native": True}
    serve = types.SimpleNamespace(app=app, models=models, API_KEY=api_key, DATE_FACTS=False, TRUNCATE_STATES=False)
    return serve, model, stats, card
`

test('生成物固定官方出处与FP32部署身份，原始探针JSON字节可直接发送', { skip: !hasApi }, t => {
  const emitted = emitKevServing({ kevRoot: upstream, runtimeKevRoot: '/remote/official-kev', serving })
  assert.equal(emitted.config.encoder_revision, KEV_COMMIT)
  assert.equal(emitted.config.kev_root, '/remote/official-kev')
  assert.deepEqual(emitted.config.limits, ENCODING_LIMITS)
  assert.equal(emitted.config.hash_contract, HASH_CONTRACT)
  assert.equal(emitted.config.bootstrap_sha256, digest(emitted.bootstrap))
  assert.equal(emitted.config.upstream_files['kev/model.py'], digest(readFileSync(join(upstream, 'kev/model.py'))))
  assert.deepEqual(emitted.config.serving, serving)
  assert.throws(() => emitKevServing({ kevRoot: upstream, runtimeKevRoot: '/remote/official-kev', serving: { ...serving, dtype: 'bfloat16' } }), /ACTUAL_FP32_SERVING_IDENTITY_REQUIRED/)
  const f = fixture(t), request = { model: 'kev-latest', state: { text: '真实字节😀', number: 1e-7 }, questions }
  const wire = encodingProbeWire(request)
  assert.equal(wire.request_wire_body, JSON.stringify(request))
  const result = f.run('value, hashes = admission.wire_request(data["request_wire_body"].encode("utf-8"))\nprint(json.dumps(hashes))', wire)
  assert.deepEqual(result, { state_sha256: wire.state_sha256, questions_sha256: wire.questions_sha256 })
})

test('Node数值与Unicode原token跨Python解析仍保留完全相同的SHA', { skip: !hasApi }, t => {
  const f = fixture(t)
  const cases = [null, false, -0, 1, 1e21, 1e-7, Number.MIN_VALUE, { text: '中文😀\u2028e\u0301', escaped: '\\"\n', list: [1e21, 1e-7, -0, false] }]
    .map(state => encodingProbeWire({ state, questions }))
  const hashes = f.run(String.raw`
result = []
for item in data:
    value, hashes = admission.wire_request(item["request_wire_body"].encode("utf-8"))
    admission.valid_unicode(value)
    result.append(hashes)
print(json.dumps(result))`, cases)
  assert.deepEqual(hashes, cases.map(({ state_sha256, questions_sha256 }) => ({ state_sha256, questions_sha256 })))
})

test('只读编码端点使用同进程模型公开encoder，零forward且精确报告边界预算', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ model: 'kev-latest', state: { facts: '字段保持原文' }, questions })
  const result = f.run(String.raw`
serve, model, stats, card = native_service()
model.counts = (384, [640, 640, 384])
admission.install(serve, config)
with TestClient(serve.app) as client:
    response = client.post("/v1/harness/encoding", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json", "x-typesafe-request-id": "probe-id"})
    result = {"status": response.status_code, "body": response.json(), "id": response.headers["x-typesafe-request-id"], "calls": model.calls, "forwards": stats["forwards"], "length": int(response.headers["content-length"]), "actual_length": len(response.content)}
print(json.dumps(result))`, request)
  assert.equal(result.status, 200)
  assert.equal(result.forwards, 0)
  assert.equal(result.body.model_invocation, false)
  assert.equal(result.body.harness_encoding.model_invocation, false)
  assert.equal(result.body.harness_encoding.admitted, true)
  assert.equal(result.body.harness_encoding.state_tokens, 384)
  assert.equal(result.body.harness_encoding.max_branch_tokens, 1024)
  assert.equal(result.body.harness_encoding.packed_tokens, 2048)
  assert.equal(result.body.harness_encoding.state_sha256, request.state_sha256)
  assert.equal(result.body.harness_encoding.questions_sha256, request.questions_sha256)
  assert.deepEqual(result.calls[0].kwargs, { max_state: 384, max_branch: 1024, strict: true })
  assert.equal(result.calls[0].same_tokenizer, true)
  assert.equal(result.calls[0].record.state, 'facts: 字段保持原文')
  assert.equal(result.id, 'probe-id')
  assert.equal(result.length, result.actual_length)
})

test('模型请求保留官方usage、响应ID和HTTP语义，追加proof后重算长度', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ model: 'kev-latest', state: '测试', questions })
  const result = f.run(String.raw`
serve, model, stats, card = native_service()
admission.install(serve, config)
with TestClient(serve.app) as client:
    listing = client.get("/v1/models")
    response = client.post("/v1/systemone", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json", "x-typesafe-request-id": "decision-id"})
    untouched = client.get("/native")
    result = {"status": response.status_code, "body": response.json(), "id": response.headers["x-typesafe-request-id"], "timing": response.headers["server-timing"], "forwards": stats["forwards"], "length": int(response.headers["content-length"]), "actual_length": len(response.content), "listing": listing.json(), "native": untouched.json()}
print(json.dumps(result))`, request)
  assert.equal(result.status, 200)
  assert.equal(result.forwards, 1)
  assert.deepEqual(result.body.usage, { input_tokens: 15, output_tokens: 7 })
  assert.equal(result.body.latency_ms, 0.25)
  assert.deepEqual(result.body.answers, { a: 'fixture-forward' })
  assert.equal(result.id, 'decision-id')
  assert.equal(result.timing, 'app;dur=0.1')
  assert.equal(result.length, result.actual_length)
  assert.equal(result.body.harness_encoding.admitted, true)
  assert.equal(result.listing.harness_encoding.encoder_revision, KEV_COMMIT)
  assert.deepEqual(result.listing.harness_encoding.limits, ENCODING_LIMITS)
  assert.deepEqual(result.native, { native: true })
})

test('state、branch、packed及截断拒绝均在业务forward之前并保留实际测量', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ model: 'kev-latest', state: '预算拒绝', questions })
  const result = f.run(String.raw`
out = []
for state, branches, truncated in [(385, [4,4,4], False), (3, [1022,4,4], False), (384, [640,640,385], False), (3, [4,4,4], True)]:
    serve, model, stats, card = native_service()
    model.counts = (state, branches)
    model.truncated = truncated
    admission.install(serve, config)
    with TestClient(serve.app) as client:
        response = client.post("/v1/systemone", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json", "x-typesafe-request-id": "reject-id"})
        out.append({"status": response.status_code, "body": response.json(), "forwards": stats["forwards"], "id": response.headers["x-typesafe-request-id"]})
print(json.dumps(out))`, request)
  for (const row of result) {
    assert.equal(row.status, 422)
    assert.equal(row.forwards, 0)
    assert.equal(row.id, 'reject-id')
    assert.equal(row.body.harness_encoding.admitted, false)
    assert.equal(row.body.harness_encoding.model_invocation, false)
    assert.equal(row.body.harness_encoding.state_sha256, request.state_sha256)
    assert.equal(row.body.harness_encoding.rejection, 'KEV_ENCODING_NOT_ADMITTED')
  }
  assert.equal(result[0].body.harness_encoding.state_tokens, 385)
  assert.equal(result[1].body.harness_encoding.max_branch_tokens, 1025)
  assert.equal(result[2].body.harness_encoding.packed_tokens, 2049)
})

test('非法JSON、重复键、非finite及孤立surrogate拒绝，不进入编码或forward', { skip: !hasApi }, t => {
  const f = fixture(t)
  const raw = [
    '{"state":{},"state":{},"questions":{}}', '{"state":{"x":1,"x":2},"questions":{}}',
    '{"state":NaN,"questions":{}}', '{"state":1e400,"questions":{}}',
    '{"state":{},"questions":{},}', '{"state":{},"questions":{}} trailing',
    JSON.stringify({ state: '\ud800', questions }),
  ]
  const result = f.run(String.raw`
serve, model, stats, card = native_service()
admission.install(serve, config)
with TestClient(serve.app) as client:
    responses = [client.post("/v1/systemone", content=raw.encode("utf-8"), headers={"content-type": "application/json"}) for raw in data]
    print(json.dumps({"status": [response.status_code for response in responses], "admitted": [response.json()["harness_encoding"]["admitted"] for response in responses], "encodes": len(model.calls), "forwards": stats["forwards"]}))`, raw)
  assert.deepEqual(result.status, raw.map(() => 422))
  assert.deepEqual(result.admitted, raw.map(() => false))
  assert.equal(result.encodes, 0)
  assert.equal(result.forwards, 0)
})

test('原生Bearer认证拒绝保持401，编码端点也不能绕过；合法认证正常预检', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ state: '认证测试', questions })
  const result = f.run(String.raw`
serve, model, stats, card = native_service("UNIT_ONLY_NOT_REAL_CREDENTIAL")
admission.install(serve, config)
with TestClient(serve.app) as client:
    rejected = [client.post(path, content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json"}) for path in ("/v1/systemone", "/v1/harness/encoding")]
    listing = client.get("/v1/models")
    before = len(model.calls)
    accepted = client.post("/v1/harness/encoding", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json", "authorization": "Bearer UNIT_ONLY_NOT_REAL_CREDENTIAL"})
    print(json.dumps({"status": [response.status_code for response in rejected] + [listing.status_code], "authenticate": rejected[0].headers["www-authenticate"], "rejected_encodes": before, "accepted": accepted.status_code, "encodes": len(model.calls), "forwards": stats["forwards"]}))`, request)
  assert.deepEqual(result.status, [401, 401, 401])
  assert.equal(result.authenticate, 'Bearer')
  assert.equal(result.rejected_encodes, 0)
  assert.equal(result.accepted, 200)
  assert.equal(result.encodes, 1)
  assert.equal(result.forwards, 0)
})

test('通过预检后的原生HTTP失败保留实际状态和usage，不伪造未调用', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ state: '原生失败', questions })
  const result = f.run(String.raw`
serve, model, stats, card = native_service()
stats["status"] = 503
admission.install(serve, config)
with TestClient(serve.app) as client:
    response = client.post("/v1/systemone", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json", "x-typesafe-request-id": "failed-native-id"})
    print(json.dumps({"status": response.status_code, "body": response.json(), "forwards": stats["forwards"], "id": response.headers["x-typesafe-request-id"], "length": int(response.headers["content-length"]), "actual_length": len(response.content)}))`, request)
  assert.equal(result.status, 503)
  assert.equal(result.forwards, 1)
  assert.deepEqual(result.body.usage, { input_tokens: 15, output_tokens: 7 })
  assert.equal(result.body.harness_encoding.admitted, true)
  assert.notEqual(result.body.harness_encoding.model_invocation, false)
  assert.equal(result.id, 'failed-native-id')
  assert.equal(result.length, result.actual_length)
})

test('固定官方ContextOverflow保留已知state量且不执行forward', { skip: !hasApi }, t => {
  const f = fixture(t), request = encodingProbeWire({ state: '原生严格编码拒绝', questions })
  const result = f.run(String.raw`
import ast
# 原样加载官方公开异常类；本测试不安装或替换Torch，也不声称执行真实模型encoder。
source = pathlib.Path(sys.argv[2])/"kev/model.py"
parsed = ast.parse(source.read_text(), filename=str(source))
exception = next(node for node in parsed.body if isinstance(node, ast.ClassDef) and node.name == "ContextOverflow")
scope = {}
exec(compile(ast.Module(body=[exception], type_ignores=[]), str(source), "exec"), scope)
serve, model, stats, card = native_service()
model.error = scope["ContextOverflow"]("state exceeds 384 tokens: 385", state_tokens=385, max_state=384)
admission.install(serve, config)
with TestClient(serve.app) as client:
    response = client.post("/v1/systemone", content=data["request_wire_body"].encode("utf-8"), headers={"content-type": "application/json"})
    print(json.dumps({"status": response.status_code, "body": response.json(), "forwards": stats["forwards"], "encodes": len(model.calls)}))`, request)
  assert.equal(result.status, 422)
  assert.equal(result.forwards, 0)
  assert.equal(result.encodes, 1)
  assert.equal(result.body.harness_encoding.state_tokens, 385)
  assert.equal(result.body.harness_encoding.max_branch_tokens, null)
  assert.equal(result.body.harness_encoding.packed_tokens, null)
  assert.equal(result.body.harness_encoding.model_invocation, false)
})

test('禁止输入变换和截断配置；实际加载身份不符时启动失败', { skip: !hasApi }, t => {
  const f = fixture(t)
  const result = f.run(String.raw`
rejected = []
for option in ("DATE_FACTS", "TRUNCATE_STATES"):
    serve, model, stats, card = native_service()
    setattr(serve, option, True)
    try: admission.install(serve, config)
    except ValueError: rejected.append(option)
    else: raise AssertionError("unsafe transform accepted")
serve, model, stats, card = native_service()
card["base"] = "wrong-base"
admission.install(serve, config)
try:
    with TestClient(serve.app): pass
except ValueError: rejected.append("loaded-identity")
else: raise AssertionError("wrong checkpoint identity accepted")
print(json.dumps(rejected))`)
  assert.deepEqual(result, ['DATE_FACTS', 'TRUNCATE_STATES', 'loaded-identity'])
})

test('probe CLI保存可原样发送的请求正文，stdout仅摘要且不能覆盖或重复flag', t => {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/kev-serving-cli-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const request = { model: 'kev-latest', state: { text: 'CLI原始字节😀', number: 1e-7 }, questions }
  const input = join(root, 'request.json'), output = join(root, 'wire.json')
  writeFileSync(input, JSON.stringify(request, null, 2))
  const cli = (...args) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('runtime/research/kev-serving.mts'), 'probe', ...args], { encoding: 'utf8', timeout: 10000 })
  const result = cli('--request', input, '--out', output)
  assert.equal(result.status, 0, result.stderr)
  const saved = readFileSync(output, 'utf8'), wire = JSON.parse(saved), receipt = JSON.parse(result.stdout)
  assert.deepEqual(wire, encodingProbeWire(request))
  assert.equal(receipt.status, 'probe_prepared')
  assert.equal(receipt.request_wire_sha256, digest(wire.request_wire_body))
  assert.equal(receipt.model_loaded, false)
  assert.equal(Object.hasOwn(receipt, 'request_wire_body'), false)
  assert.equal(result.stdout.includes('CLI原始字节'), false)
  assert.equal(cli('--request', input, '--out', output).status, 1)
  assert.equal(cli('--request', input, '--request', input, '--out', output).status, 1)
  assert.equal(readFileSync(output, 'utf8'), saved)
})

test('探针构造拒绝非无损JSON及不完整请求，不用序列化悄悄改写输入', () => {
  const cyclic = {}; cyclic.self = cyclic
  for (const state of [NaN, Infinity, undefined, new Date(), new Array(2), { value: undefined }, { value: () => 1 }, cyclic]) {
    assert.throws(() => encodingProbeWire({ state, questions }), /LOSSLESS_JSON_REQUEST_REQUIRED/)
  }
  assert.throws(() => encodingProbeWire({ state: {} }), /REQUEST_FIELDS_REQUIRED/)
  assert.throws(() => encodingProbeWire({ state: {}, questions, label: 'not-an-input-field' }), /REQUEST_FIELDS_REQUIRED/)
})

test('生成bootstrap的摘要、环境、来源与argv漂移均在上游模型导入前拒绝', { skip: !hasApi }, t => {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/kev-serving-main-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = join(root, 'actual-run'), guard = join(root, 'import-guard'), marker = join(root, 'model-imported')
  mkdirSync(run); mkdirSync(guard)
  writeFileSync(join(run, 'head.pt'), 'UNIT_ONLY_NO_REAL_CHECKPOINT')
  // 即使前置校验回归，也必须在导入kev/Torch/Transformers之前停止此测试。
  writeFileSync(join(guard, 'sitecustomize.py'), `import sys, pathlib\nclass NoModelImport:\n    def find_spec(self, fullname, path=None, target=None):\n        if fullname.split('.')[0] in ('kev', 'torch', 'transformers'):\n            pathlib.Path(${JSON.stringify(marker)}).write_text(fullname)\n            raise RuntimeError('MODEL_IMPORT_FORBIDDEN_IN_NEGATIVE_TEST')\nsys.meta_path.insert(0, NoModelImport())\n`)
  const emitted = emitKevServing({ kevRoot: upstream, runtimeKevRoot: upstream, serving: { ...serving, run } })
  const normal = ['--run', run, '--device', 'cuda']
  const cases = [
    { name: 'bootstrap-bytes', source: emitted.bootstrap + '\n# changed bytes\n', error: 'bootstrap bytes changed' },
    { name: 'bootstrap-identity', mutate(config) { config.admission_source_sha256 = 'f'.repeat(64) }, error: 'bootstrap bytes changed' },
    { name: 'missing-env', missing: 'KEV_DTYPE', error: 'explicit native FP32 serving environment required' },
    { name: 'manifest-drift', mutate(config) { config.upstream_files['kev/api.py'] = 'f'.repeat(64) }, error: 'official encoder source changed' },
    { name: 'wrong-run', args: ['--run', join(root, 'other-run'), '--device', 'cuda'], error: 'actual local checkpoint and device required; no fallback' },
    { name: 'wrong-fallback', args: [...normal, '--fallback', join(root, 'other-run')], error: 'actual local checkpoint and device required; no fallback' },
    { name: 'equals-option', args: [`--run=${run}`, '--device', 'cuda'], error: 'use canonical official serve options' },
    { name: 'duplicate-option', args: [...normal, '--run', run], error: 'use canonical official serve options' },
  ]
  for (const item of cases) {
    const script = join(root, item.name + '.py'), configPath = join(root, item.name + '.json'), config = structuredClone(emitted.config)
    item.mutate?.(config)
    writeFileSync(script, item.source ?? emitted.bootstrap)
    writeFileSync(configPath, JSON.stringify(config))
    const env = { ...process.env, ...SERVING_ENV, PYTHONPATH: guard }
    if (item.missing) delete env[item.missing]
    const result = spawnSync(python, [script, '--harness-config', configPath, ...(item.args ?? normal)], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1, item.name + ': ' + result.stderr)
    assert.ok(result.stderr.includes(item.error), item.name + ': ' + result.stderr)
    assert.equal(result.stdout, '', item.name)
    assert.equal(existsSync(marker), false, item.name + ' attempted to import the model')
  }
})
