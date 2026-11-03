import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from '../../platform/plugin/node_modules/esbuild/lib/main.js'

const require = createRequire('/home/admin/work/harness-engineering-platform/platform/plugin/package.json')
const compiled = (await build({ entryPoints: ['/home/admin/work/harness-engineering-platform/platform/plugin/src/mcp/client.tsx'], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', 'harness-mcp-manager-client', '@deepseek-ai/dsh-client-ui-primitives'] })).outputFiles[0].text
const oldId = 'a'.repeat(64), currentId = 'b'.repeat(64)
const oldConfig = { toolName: 'find_asset', title: '旧发布标题', description: '旧版说明', connectionId: 'source-one' }
const currentConfig = { ...oldConfig, title: '当前发布标题', description: '当前说明' }

function workbench(initialTarget = { page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: oldId }, { execute, action, readCatalog, source, extraCompositions = [] } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], navigations = [], copied = []
  let cursor, effects, changed, tree, listener
  let catalog = { revision: 'r1', connections: [{ kind: 'openapi', id: 'source-one' }], extension: {stages:{}},
    compositions: [{ id: 'composition-one', published: { ...currentConfig, publishedAt: '2026-10-20T00:00:00Z' }, publishedVersionId: currentId,
      versions: [{ versionId: oldId, config: oldConfig, publishedAt: '2026-10-19T00:00:00Z' }, { versionId: currentId, config: currentConfig, publishedAt: '2026-10-20T00:00:00Z' }],
      graphs: { published: { nodes: [], edges: [] } } }, ...extraCompositions] }
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
      return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) {
      dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(`${compiled}\nmodule.exports.CompositionPage = CompositionPage;`, {
    module, exports: module.exports, URL, structuredClone, requestAnimationFrame: callback => callback(),
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: element => element }
      : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: props => props.children } : name === 'harness-mcp-manager-client' ? { Manager: () => null } : require(name),
    window: { addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { async writeText(value) { copied.push(value) } } },
    document: { baseURI: 'http://localhost:3090/hep/' },
  })
  const props = { target: initialTarget, active: true, configuration: { status: 'ready' }, onCatalogChange() {}, onContext() {},
    onNavigate(value) { navigations.push(value); props.target = value; changed = true },
    updates: { subscribe(value) { listener = value; return () => { listener = undefined } }, getSnapshot: () => ({ domains: ['mcp'] }), invalidate() {} },
    rpc: { async call(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      if (endpoint === 'mcp/list') return readCatalog ? readCatalog(catalog) : { ok: true, value: structuredClone(catalog) }
      if (endpoint === 'mcp/compositionSource' && source) return source(payload)
      if (action && ['mcp/dryRunComposition', 'mcp/publishComposition', 'mcp/executeComposition'].includes(endpoint)) return action(endpoint, payload)
      if (endpoint === 'mcp/saveCompositionDraft') {
        if (payload.revision !== catalog.revision) return { ok: false, error: { message: '编排目录已变化，请刷新后重试' } }
        catalog = { ...catalog, revision: 'r3', compositions: catalog.compositions.map(entry => entry.id === payload.compositionId ? { ...entry, draft: payload.draft } : entry) }
        return { ok: true, value: structuredClone(catalog) }
      }
      if (endpoint === 'mcp/executeComposition' && execute) return execute(payload)
      throw new Error(`未处理的 RPC ${endpoint}`)
    } },
  }
  function render() { let count = 0; do { if (++count > 30) throw new Error('渲染未收敛'); cursor = 0; effects = []; changed = false; tree = module.exports.CompositionPage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 5; index++) { render(); await new Promise(setImmediate) }; render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []
    return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(item => text(item)).join(''); return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  render()
  return { render, settle, nodes, text, button, calls, navigations, copied,
    setActive(value) { props.active = value; render() }, setTarget(value) { props.target = value; render() }, externalUpdate(value) { catalog = value; listener?.(); render() } }
}


const target={ page:'mcp',tab:'composition',composition_id:'stage-collect',version:'published',version_id:currentId };
const stageConfig={ ...currentConfig,kind:'threat-stage',stage:'collect',bindings:{socConnectionId:'source-one',reportConnectionId:'source-one'} };
let accepted=0; const sent=[];
const ui=workbench(target,{ extraCompositions:[{id:'stage-collect',published:stageConfig,publishedVersionId:currentId,versions:[{versionId:currentId,config:stageConfig}],graphs:{published:{nodes:[],edges:[]}}}],
  action:async(endpoint,payload)=>{ assert.equal(endpoint,'mcp/executeComposition'); accepted++;sent.push(structuredClone(payload));throw new Error('fixture: accepted upstream but RPC response lost'); } });
await ui.settle();
const input=ui.nodes().find(node=>node.props?.['aria-label']==='组合事件 ID');

assert.ok(input,'incident input exists'); input.props.onChange({target:{value:'incident-probe'}});ui.render();
assert.equal(ui.button('实际执行组合工具').props.disabled,false);
ui.button('实际执行组合工具').props.onClick();await ui.settle();
const textAfterLoss=ui.text();
assert.match(textAfterLoss,/操作失败，请检查连接并重试/);
assert.equal(ui.button('实际执行组合工具').props.disabled,false);
ui.button('实际执行组合工具').props.onClick();await ui.settle();
const result={ accepted, statusAfterLoss:'操作失败，请检查连接并重试。', retryEnabled:ui.button('实际执行组合工具').props.disabled===false, payloads:sent, samePayload:JSON.stringify(sent[0])===JSON.stringify(sent[1]), confirmed:accepted===2 };
console.log(JSON.stringify(result,null,2));
