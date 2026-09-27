const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'app/node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'app/src/WritingPage.tsx'), 'utf8');
const ast = ts.createSourceFile('WritingPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set(['openChapter', 'saveNow']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, 2);
const compiled = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function reproduce(typeDuringSave) {
  let text = '第一章已有修改';
  let release;
  const saved = [];
  const view = { state: { doc: { toString: () => text } } };
  const dirtyRef = { current: true };
  const currentRef = { current: { path: '第一章.md' } };
  const context = {
    currentRef, dirtyRef, viewRef: { current: view },
    fingerprintRef: { current: 'initial' }, savingRef: { current: false },
    conflictRef: { current: false }, baselineRef: { current: 0 },
    project: { dir: '临时项目' }, setCurrent() {}, setConflict() {}, setSaveStatus() {},
    setChapters() {}, addTodayWords() {}, loadIntent: async () => {},
    chapterKey: () => 'chapter', localStorage: { setItem() {} },
    chapterStats: value => ({ wordCount: value.length, hanCount: value.length }),
    readChapterStatus: () => '草稿',
    loadContent(value) { text = value; dirtyRef.current = false; },
    window: { alert(message) { throw new Error(message); } }, console,
    async invoke(command, args) {
      if (command === 'save_chapter_md') {
        saved.push(args.content);
        await new Promise(resolve => { release = resolve; });
        return { status: 'saved', fingerprint: 'saved' };
      }
      if (command === 'read_book_md') return { content: '第二章正文', fingerprint: 'second' };
      throw new Error(command);
    },
  };
  vm.createContext(context);
  vm.runInContext(compiled, context);
  const navigation = context.openChapter({ path: '第二章.md' });
  assert.equal(typeof release, 'function');
  if (typeDuringSave) text += '【保存等待期间新输入】';
  release();
  const result = await navigation;
  assert.equal(result, true);
  assert.equal(currentRef.current.path, '第二章.md');
  assert.equal(saved[0], '第一章已有修改');
  assert.equal(text, '第二章正文');
  return { navigationSucceeded: result, savedFirstChapter: saved[0], currentEditor: text,
    typingDuringSave: typeDuringSave, additionalTextSaved: saved.some(value => value.includes('保存等待期间新输入')) };
}
(async () => {
  console.log(JSON.stringify({ normalNavigation: await reproduce(false), concurrentTyping: await reproduce(true),
    scope: 'Runs the actual extracted frontend saveNow/openChapter functions with a delayed IPC response; not native UI acceptance.' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
