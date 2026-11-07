import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCompositions, writeCompositions, compositionConfig, publishCompositionVersion, compositionReferences, assertPublishedDependencies } from '../src/mcp/compositions.ts'

test('包定义独立保存，撤下保留固定历史，引用阻止删除，删除清理整个资产包', t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-packages-'))
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const file = join(root, 'compositions.json')
  const config = compositionConfig({kind:'workflow',workflow:'child',toolName:'child',title:'子检查',description:''})
  const child = {id:'child'}; publishCompositionVersion(child,config)
  mkdirSync(join(root,'compositions/child/docs'),{recursive:true})
  writeFileSync(join(root,'compositions/child/docs/README.md'),'入口')
  writeFileSync(join(root,'compositions/child/composition.json'),JSON.stringify(child))
  writeFileSync(file,JSON.stringify({schema_version:'2.0',compositions:[{id:'child',path:'compositions/child/composition.json'}]}))
  let {catalog,revision}=readCompositions(file)
  const parent={id:'parent',draft:compositionConfig({kind:'composite',workflow:'parent',toolName:'parent',title:'父检查',description:'',steps:[{id:'child',compositionId:'child',versionId:child.publishedVersionId,inputMap:{scope:'$input.scope'}}]})}
  catalog.compositions.push(parent);writeCompositions(file,catalog,revision)
  assert.equal(compositionReferences(catalog,'child').length,1)
  ;({catalog,revision}=readCompositions(file));delete catalog.compositions[0].published;delete catalog.compositions[0].publishedVersionId
  writeCompositions(file,catalog,revision)
  assert.throws(()=>assertPublishedDependencies(catalog,parent.draft),/下架|未发布/)
  assert.equal(catalog.compositions[0].versions.length,1)
  const before=readCompositions(file);writeFileSync(join(root,'compositions/child/composition.json'),JSON.stringify({...catalog.compositions[0],draft:config}))
  assert.throws(()=>writeCompositions(file,before.catalog,before.revision),/已变化/)
  ;({catalog,revision}=readCompositions(file));catalog.compositions=catalog.compositions.filter(item=>item.id!=='parent');writeCompositions(file,catalog,revision,'parent')
  ;({catalog,revision}=readCompositions(file));catalog.compositions=[];writeCompositions(file,catalog,revision,'child')
  assert.equal(existsSync(join(root,'compositions/child')),false)
})

test('其他编排复用包内工作流源码时计为直接引用', () => {
  for (const kind of ['workflow','composite']) {
    const draft = compositionConfig({kind,workflow:'child',toolName:'alias',title:'复用子检查',description:'',steps:[{id:'step',compositionId:'other',versionId:'v1',inputMap:{}}]})
    const catalog = {schema_version:'1.0',compositions:[{id:'child',draft},{id:'alias',draft,published:draft}]}
    assert.deepEqual(compositionReferences(catalog,'child'),[{id:'alias',title:'复用子检查'}])
    assert.deepEqual(compositionReferences(catalog,'child',true),[])
  }
})

test('未引用的历史父版本不阻止下架，当前入口固定的旧版本仍检查传递依赖', () => {
  const leaf = { id: 'leaf' }, parent = { id: 'parent' }, root = { id: 'root' }
  const single = id => compositionConfig({kind:'workflow',workflow:id,toolName:id,title:id,description:''})
  const childOf = (id, entry) => compositionConfig({kind:'composite',workflow:id,toolName:id,title:id,description:'',steps:[{id:'child',compositionId:entry.id,versionId:entry.publishedVersionId,inputMap:{}}]})
  publishCompositionVersion(leaf, single('leaf'))
  publishCompositionVersion(parent, childOf('parent', leaf))
  const old = parent.published
  const oldVersionId = parent.publishedVersionId
  publishCompositionVersion(root, childOf('root', parent))
  publishCompositionVersion(parent, single('parent'))
  const catalog = {schema_version:'1.0',compositions:[leaf,parent,root]}
  assert.deepEqual(compositionReferences(catalog,'leaf',true),[{id:'root',title:'root'}])
  publishCompositionVersion(root, childOf('root', parent))
  assert.deepEqual(compositionReferences(catalog,'leaf'),[])
  delete leaf.published
  assert.throws(() => assertPublishedDependencies(catalog,old),/下架|删除/)
  assert.doesNotThrow(() => assertPublishedDependencies(catalog,root.published))
  assert.ok(parent.versions.some(version => version.versionId === oldVersionId))
})
