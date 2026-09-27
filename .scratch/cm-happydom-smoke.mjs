/** 冒烟:CodeMirror 6 能否在 happy-dom 里挂载并 dispatch 事务。 */
import { Window } from "happy-dom";

const win = new Window();
const g = globalThis;
for (const key of [
  "window", "document", "navigator", "localStorage", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver",
  "ResizeObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent",
  "Node", "Element", "HTMLElement", "Range", "Selection", "CSS",
]) {
  const v = (win)[key];
  if (v !== undefined && !(key in g)) g[key] = v;
}
g.window = win;
g.document = win.document;
g.requestAnimationFrame = (cb) => win.requestAnimationFrame(cb);
g.cancelAnimationFrame = (id) => win.cancelAnimationFrame(id);

win.__TAURI_INTERNALS__ = {
  invoke: async (cmd) => { console.log("invoke:", cmd); return null; },
  transformCallback: () => 0,
  unregisterCallback: () => {},
};

const { EditorView } = await import("@codemirror/view");
const { EditorState } = await import("@codemirror/state");
const { basicSetup } = await import("codemirror");
const { markdown } = await import("@codemirror/lang-markdown");

const parent = win.document.createElement("div");
win.document.body.appendChild(parent);
let view;
try {
  view = new EditorView({
    parent,
    state: EditorState.create({ doc: "第一章正文", extensions: [basicSetup, markdown()] }),
  });
  console.log("mounted ok; text =", JSON.stringify(view.state.doc.toString()));
  view.dispatch({ changes: { from: view.state.doc.length, insert: "【新增】" } });
  console.log("after dispatch =", JSON.stringify(view.state.doc.toString()));
  const found = EV.findFromDOM(parent.querySelector(".cm-editor"));
  console.log("findFromDOM:", found === view ? "same view" : String(found));
  view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
  console.log("selection/scrollIntoView ok");
  view.destroy();
  console.log("SMOKE OK");
} catch (e) {
  console.error("SMOKE FAIL:", e && e.stack || e);
  process.exitCode = 1;
}
