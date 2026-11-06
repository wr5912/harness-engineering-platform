import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCompositions, writeCompositions, compositionConfig, publishCompositionVersion, compositionReferences, assertPublishedDependencies } from '../src/mcp/compositions.ts'

test('包定义独立保存，撤下保留固定历史，引用阻止删除，删除保留代码文档', t => {
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
  assert.equal(existsSync(join(root,'compositions/child/composition.json')),false)
  assert.equal(readFileSync(join(root,'compositions/child/docs/README.md'),'utf8'),'入口')
})
