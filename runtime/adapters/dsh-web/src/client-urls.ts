import ts from 'typescript'

interface Scope { names: Set<string>; parent?: Scope; functionScope: boolean }

/** 只转换最终网络目标；不触及 OpenAPI 参数、文件路径或浏览器 Origin 的语义。 */
export function transformClientUrls(source: string): string {
  const file = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const scopes = new WeakMap<ts.Node, Scope>()
  const root: Scope = { names: new Set(), functionScope: true }
  function bind(name: ts.BindingName, scope: Scope): void {
    if (ts.isIdentifier(name)) scope.names.add(name.text)
    else for (const item of name.elements) if (ts.isBindingElement(item)) bind(item.name, scope)
  }
  function visit(node: ts.Node, scope: Scope): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) scope.names.add(node.name.text)
    if (ts.isFunctionLike(node)) {
      scope = { names: new Set(), parent: scope, functionScope: true }
      for (const parameter of node.parameters) bind(parameter.name, scope)
      if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) scope.names.add(node.name.text)
    } else if (ts.isBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node)
      || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCaseBlock(node)) {
      scope = { names: new Set(), parent: scope, functionScope: false }
    }
    scopes.set(node, scope)
    if (ts.isVariableDeclaration(node)) {
      let owner = scope
      if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        while (!owner.functionScope && owner.parent) owner = owner.parent
      }
      bind(node.name, owner)
    }
    if (ts.isImportClause(node) && node.name) scope.names.add(node.name.text)
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) scope.names.add(node.name.text)
    ts.forEachChild(node, child => visit(child, scope))
  }
  visit(file, root)
  const globalName = (node: ts.Node, name: string): boolean => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.names.has(name)) return false
    return true
  }
  const globalMember = (expression: ts.Expression, name: string): boolean => {
    if (ts.isIdentifier(expression)) return expression.text === name && globalName(expression, name)
    return ts.isPropertyAccessExpression(expression) && expression.name.text === name
      && ts.isIdentifier(expression.expression) && ['window', 'globalThis'].includes(expression.expression.text)
      && globalName(expression, expression.expression.text)
  }
  let helper = '__harnessSiteUrl'
  while (source.includes(helper)) helper += '_'
  const edits: { position: number; text: string }[] = []
  function targets(node: ts.Node): void {
    let argument: ts.Expression | undefined
    if (ts.isCallExpression(node) && (globalMember(node.expression, 'fetch')
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addModule'
        && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'audioWorklet'))) argument = node.arguments[0]
    if (ts.isNewExpression(node) && globalMember(node.expression, 'Worker')) argument = node.arguments?.[0]
    if (argument && !ts.isSpreadElement(argument)) {
      edits.push({ position: argument.getStart(file), text: `${helper}(` }, { position: argument.end, text: ')' })
    }
    ts.forEachChild(node, targets)
  }
  targets(file)
  if (!edits.length) return source
  for (const edit of edits.sort((a, b) => b.position - a.position)) source = source.slice(0, edit.position) + edit.text + source.slice(edit.position)
  source = source.replace(/^\s*\/\/[#@] sourceMappingURL=[^\r\n]*$/gm, '')
  // 私有闭包避免组合资源和 HMR 再次装载时产生顶层声明冲突。
  return `((browser)=>{function ${helper}(input){
    const {URL,Request,document}=browser;
    const base=new URL(document.baseURI);
    const text=input instanceof Request?input.url:input instanceof URL?input.href:input;
    if(typeof text!=='string')return input;
    const url=new URL(text,base);
    if(url.origin!==base.origin||!/^\\/(?:api|mcp|plugins|voice-mode)(?:\\/|$)/.test(url.pathname))return input;
    url.pathname=base.pathname.replace(/\\/$/,'')+url.pathname;
    return input instanceof Request?new Request(url,input):url.href;
  }\n(()=>{\n${source}\n})();\n})(globalThis);\n`
}
