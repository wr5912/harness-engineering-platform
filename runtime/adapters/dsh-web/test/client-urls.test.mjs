import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { transformClientUrls } from '../lib/index.mjs'

const require = createRequire(new URL('../../../../platform/plugin/package.json', import.meta.url))
const yaml = require('js-yaml')

function execute(source, basePath = '/assistant/') {
  const calls = []
  const context = {
    URL, Request, document: { baseURI: `http://fixture.local${basePath}` },
    fetch: (input, init) => { calls.push({ kind: 'fetch', input, init }); return Promise.resolve({}) },
    Worker: class { constructor(input, options) { calls.push({ kind: 'worker', input, options }) } },
    context: { audioWorklet: { addModule(input) { calls.push({ kind: 'worklet', input }) } } },
  }
  context.window = context
  vm.runInNewContext(transformClientUrls(source), context)
  return calls
}

for (const base of ['/assistant/', '/hep/']) test(`${base} 统一处理最终请求、Worker 和 Worklet，保留外部地址和请求属性`, async () => {
  const calls = execute(`
    fetch('/api/overview?limit=2', {method:'POST',body:'payload'});
    fetch(new URL('/voice-mode/config','http://fixture.local'));
    window.fetch(new Request('http://fixture.local/api/request',{method:'POST',body:'request body'}));
    fetch('${base}api/already');
    fetch('api/relative');
    fetch('https://external.invalid/api/spec');
    fetch('/v1/models');
    new Worker('/voice-mode/kws/worker.js',{type:'classic'});
    context.audioWorklet.addModule('http://fixture.local/voice-mode/worklet.js');
    context.audioWorklet.addModule('blob:http://fixture.local/example');
  `, base)
  assert.equal(calls[0].input, `http://fixture.local${base}api/overview?limit=2`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, 'payload')
  assert.equal(calls[1].input, `http://fixture.local${base}voice-mode/config`)
  assert.ok(calls[2].input instanceof Request)
  assert.equal(calls[2].input.url, `http://fixture.local${base}api/request`)
  assert.equal(calls[2].input.method, 'POST')
  assert.equal(await calls[2].input.text(), 'request body')
  assert.equal(calls[3].input, `${base}api/already`)
  assert.equal(calls[4].input, 'api/relative')
  assert.equal(calls[5].input, 'https://external.invalid/api/spec')
  assert.equal(calls[6].input, '/v1/models')
  assert.equal(calls[7].input, `http://fixture.local${base}voice-mode/kws/worker.js`)
  assert.equal(calls[7].options.type, 'classic')
  assert.equal(calls[8].input, `http://fixture.local${base}voice-mode/worklet.js`)
  assert.equal(calls[9].input, 'blob:http://fixture.local/example')
})

test('不把局部同名 fetch 当作浏览器 fetch，也不保留修改前的 sourceMappingURL', () => {
  const source = `const values=[]; function local(fetch){ fetch('/api/local') }
    local(value=>values.push(value)); fetch('/api/global');
    //# sourceMappingURL=old.js.map`
  const calls = execute(source)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, 'http://fixture.local/assistant/api/global')
  assert.ok(!transformClientUrls(source).includes('sourceMappingURL'))
  const shadowed = `const fetch=(url)=>url; fetch('/api/local')`
  assert.equal(transformClientUrls(shadowed), shadowed)
})

test('插件账号与代理请求跟随站点基址，保留外部和已挂载路径', () => {
  const calls = execute(`
    const path='/plugins/dsh-openai-codex/auth/status';
    fetch(path);
    fetch('/plugins/dsh-openai-codex/proxy/test?proxyUrl=http%3A%2F%2F127.0.0.1%3A7897', {method:'POST'});
    fetch('/hep/plugins/dsh-openai-codex/auth/accounts');
    fetch('https://external.invalid/plugins/auth');
    fetch('/plugins-other/status');
  `, '/hep/')
  assert.equal(calls[0].input, 'http://fixture.local/hep/plugins/dsh-openai-codex/auth/status')
  assert.equal(calls[1].input, 'http://fixture.local/hep/plugins/dsh-openai-codex/proxy/test?proxyUrl=http%3A%2F%2F127.0.0.1%3A7897')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[2].input, '/hep/plugins/dsh-openai-codex/auth/accounts')
  assert.equal(calls[3].input, 'https://external.invalid/plugins/auth')
  assert.equal(calls[4].input, '/plugins-other/status')
})

test('循环与 switch 的局部绑定不阻止后续全局请求转换', () => {
  const calls = execute(`
    for (let fetch of [value=>value]) { fetch('/api/local'); }
    for (let fetch in {}) { fetch; }
    for (let fetch=0;fetch<0;fetch++) {}
    switch (1) {case 1: const fetch=value=>value; fetch('/api/case'); break;}
    fetch('/api/global');
  `)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, 'http://fixture.local/assistant/api/global')
})

test('保留原脚本严格模式，URL helper 不受原脚本局部变量遮蔽', () => {
  const calls = execute(`'use strict';
    const document={baseURI:'https://external.invalid/'};
    const URL=null, Request=null;
    if ((function(){return this})()!==undefined) throw new Error('strict mode lost');
    fetch('/api/global');
  `)
  assert.equal(calls[0].input, 'http://fixture.local/assistant/api/global')
})

test('当前三个业务客户端制品可转换并作为浏览器脚本解析', () => {
  const assetRoot = resolve(process.env.HARNESS_ASSET_ROOT || join(homedir(), 'harness-engineering-platform-data'))
  const { active_experiment } = yaml.load(readFileSync(join(assetRoot, 'agents/security-operations-expert/manifest.yaml'), 'utf8'))
  const root = join(assetRoot, 'evolution/experiments', active_experiment, 'candidate/dsh/managed')
  for (const file of ['security-operations-ui/client.js', 'mcp-manager/client.js', 'dsh-voice-hub/lib/client.js']) {
    const source = readFileSync(join(root, file), 'utf8')
    const transformed = transformClientUrls(source)
    assert.notEqual(transformed, source)
    new vm.Script(transformed, { filename: file })
  }
})
