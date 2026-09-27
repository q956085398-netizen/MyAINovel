const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'app/node_modules/typescript'));
function extract(file, name) {
  const raw = fs.readFileSync(path.join(root, 'app/src', file), 'utf8');
  const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found);
  return 'const ' + found + ';';
}
const code = ts.transpileModule(extract('App.tsx', 'chooseLibraryFolder') + '\n' + extract('Writing.tsx', 'scan'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const state = { library: '临时旧库', open: { project: { dir: '临时旧库/项目/《旧书》', title: '旧书' }, seq: 0 }, projects: [] };
const context = {
  useCallback: fn => fn, PATH_KEY: 'library', localStorage: { setItem() {} },
  pickLibraryFolder: async () => '临时新库',
  setLibraryPath: value => { state.library = value; },
  setScanning() {}, setError() {}, setProjects: value => { state.projects = value; },
  setOpen: value => { state.open = typeof value === 'function' ? value(state.open) : value; },
  autoOpenRef: { current: false }, remember() {}, errMsg: String,
  invoke: async () => [],
};
vm.createContext(context);
vm.runInContext(code + '\nglobalThis.runSwitch = chooseLibraryFolder; globalThis.runScan = scan;', context);
(async () => {
  await context.runSwitch();
  await context.runScan(state.library);
  assert.equal(state.library, '临时新库');
  assert.equal(state.projects.length, 0);
  assert.equal(state.open.project.dir, '临时旧库/项目/《旧书》');
  console.log(JSON.stringify({ ...state, scope: 'Actual App folder callback and Writing scan, with simulated file-picker/IPC and state setters. No creative files touched; not native UI acceptance.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
