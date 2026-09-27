import "./helpers/installDom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { sharedWin } from "./helpers/installDom.ts";
import { applyTauriMock, deferred, flushDom, MockIpc } from "./helpers/pageHarness.ts";
import { emptyProjectMeta, type ExpectationView } from "../src/types.ts";
import type { GlobalSearchReport } from "../src/globalSearchNavigation.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LIBRARY_KEY = "gongbi.libraryPath";
const originalLibrary = "C:/整合验收/旧库副本";
const otherLibrary = "C:/整合验收/另一库";
const bookPath = `${originalLibrary}/《拆书样本》/拆书.md`;
const projectDir = `${otherLibrary}/项目/《构思样本》`;

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(found, `页面应有「${text}」按钮`);
  return found;
}

async function interact(action: () => void) {
  await act(async () => { action(); await flushDom(25); });
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `等待超时：${description}`);
    await interact(() => {});
  }
}

async function changeLibrary(container: HTMLElement) {
  await interact(() => container.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click());
  await waitFor(() => !!container.querySelector(".settings-page"), "库设置出现");
  await interact(() => button(container, "库与数据").click());
  await interact(() => button(container, "更改库位置").click());
}

async function query(container: HTMLElement, text: string) {
  await interact(() => sharedWin.dispatchEvent(new sharedWin.KeyboardEvent("keydown", {
    key: "k", ctrlKey: true, bubbles: true,
  })));
  await waitFor(() => !!container.querySelector(".global-search-label input"), "全局搜索出现");
  await interact(() => {
    const input = container.querySelector<HTMLInputElement>(".global-search-label input")!;
    Object.getOwnPropertyDescriptor(sharedWin.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new sharedWin.Event("input", { bubbles: true }));
  });
}

function editor(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>(".editor-page .cm-editor");
  assert.ok(element, "拆书编辑器应在页面上");
  const view = EditorView.findFromDOM(element);
  assert.ok(view);
  return view;
}

test("整合流程：切库保存新增文字、待打磨编辑与搜索、迟到结果隔离、切回重读", async () => {
  sharedWin.localStorage.clear();
  sharedWin.localStorage.setItem(LIBRARY_KEY, originalLibrary);
  sharedWin.localStorage.setItem("gongbi.lastBook", bookPath);
  const disk = new Map([[bookPath, "旧库原稿"]]);
  const book = {
    name: "拆书样本", layout: "folder-book", primaryMd: bookPath,
    mdCount: 1, chapterCount: 1, wordCount: 5, tropes: [], cover: null, coverDir: "",
    meta: { title: null, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null },
  };
  const project = {
    dir: projectDir, name: "《构思样本》", title: "构思样本", chapterCount: 1, wordCount: 10,
    unitCount: 0, contradictionCount: 0, characterCount: 0, worldviewCount: 0,
    openingCount: 0, foreshadowCount: 0, expectationExpectCount: 1, expectationGoalCount: 0,
    cover: null, coverDir: "",
  };
  const line: ExpectationView = {
    name: "找到证人", kind: "期待", horizon: "长", state: "已埋", pending: true,
    planted: [{ chapter: 1, quote: "证人仍在城内", stale: false }], fulfilled: [],
    unadvancedChapters: 0, overdue: false,
  };
  const pendingHit = {
    kind: "期待线", title: line.name, path: `${projectDir}/三线.yaml`,
    projectDir, projectTitle: project.title, category: "期待", matches: [],
  };
  const saveGate = deferred();
  const lateSearch = deferred<GlobalSearchReport>();
  const picked = [otherLibrary, originalLibrary, otherLibrary];
  const saved: { path: string; content: string }[] = [];
  let version = 1;
  const ipc = new MockIpc(async (cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open": return picked.shift();
      case "plugin:event|listen": return 1;
      case "plugin:event|unlisten":
      case "grant_asset_scope": return null;
      case "scan_library": return args.root === originalLibrary ? [book] : [];
      case "scan_projects": return args.root === otherLibrary ? [project] : [];
      case "scan_inspirations":
      case "list_chat_sessions":
      case "scan_notes":
      case "read_arrangement": return [];
      case "load_ai_config": return { providers: [], activeProviderId: null };
      case "load_assistant_presets": return null;
      case "migrate_book_header": return true;
      case "read_book_md": {
        assert.equal(args.path, bookPath);
        return { content: disk.get(bookPath), fingerprint: `book-${version}` };
      }
      case "read_book_meta": return book.meta;
      case "save_book_md": {
        assert.equal(args.path, bookPath, "切库中的旧稿仍写入旧库路径");
        saved.push({ path: String(args.path), content: String(args.content) });
        if (saved.length === 1) await saveGate.promise;
        disk.set(bookPath, String(args.content));
        return { status: "saved", fingerprint: `book-${++version}` };
      }
      case "read_project_meta": return emptyProjectMeta();
      case "read_map_workspace": return { maps: [], regions: [] };
      case "load_vocab": return { types: [], solutions: [] };
      case "global_search": {
        if (args.query === "迟到查询") return lateSearch.promise;
        return { hits: args.root === otherLibrary ? [pendingHit] : [{
          kind: "拆书", title: book.name, path: bookPath, projectDir: null,
          projectTitle: null, category: null, matches: [],
        }], warnings: [], truncated: false };
      }
      case "global_search_preview": {
        const valid = args.root === otherLibrary ? args.path === pendingHit.path : args.path === bookPath;
        assert.ok(valid, "搜索目的地必须属于当前库");
        return args.root === otherLibrary ? line.name : disk.get(bookPath);
      }
      case "expectation_board": {
        assert.equal(args.project, projectDir, "期待线从其所属库的项目重读");
        return { maxChapter: 3, tableFingerprint: `line-${version}`, items: [structuredClone(line)] };
      }
      case "set_expectation_meta": {
        assert.equal(args.project, projectDir);
        assert.equal(args.name, line.name);
        line.kind = String(args.kind);
        line.horizon = String(args.horizon);
        version += 1;
        return [structuredClone(line)];
      }
      case "set_expectation_pending": {
        assert.equal(args.project, projectDir);
        assert.equal(args.fingerprint, `line-${version}`);
        line.pending = Boolean(args.pending);
        return { status: "saved", fingerprint: `line-${++version}` };
      }
      default: throw new Error(`整合流程未预期的外部调用：${cmd}`);
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  const alerts: string[] = [];
  sharedWin.alert = (message?: unknown) => alerts.push(String(message));
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.append(container);
  const root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    await interact(() => root.render(createElement(App)));
    await waitFor(() => !!container.querySelector(".editor-page .cm-editor"), "原库拆书稿打开");
    const view = editor(container);
    await interact(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "，切库前输入" } }));
    await changeLibrary(container);
    await waitFor(() => saved.length === 1, "切库保护发起保存");
    assert.equal(sharedWin.localStorage.getItem(LIBRARY_KEY), originalLibrary);
    await interact(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "，保存等待中又输入" } }));
    assert.equal(disk.get(bookPath), "旧库原稿", "保存等待中不提前宣称落盘");
    await interact(() => saveGate.release());
    await waitFor(() => sharedWin.localStorage.getItem(LIBRARY_KEY) === otherLibrary, "最新文字保存后进入另一库");
    assert.equal(disk.get(bookPath), "旧库原稿，切库前输入，保存等待中又输入");
    assert.equal(container.querySelector(".editor-page"), null);

    await query(container, line.name);
    await waitFor(() => !!container.querySelector(".global-search-open"), "新库期待线搜索命中");
    await interact(() => container.querySelector<HTMLButtonElement>(".global-search-open")!.click());
    await waitFor(() => !!container.querySelector(".exp-pending-note.is-search-hit"), "跳到构思期待感的完整便笺");
    assert.equal(container.querySelector('[aria-label="构思"]')?.getAttribute("aria-current"), "page");
    assert.equal(sharedWin.localStorage.getItem("gongbi.currentProject"), projectDir);
    assert.match(container.querySelector(".exp-pending-note")!.textContent!, /证人仍在城内/);
    await interact(() => {
      const select = container.querySelector<HTMLSelectElement>('.exp-pending-note select[title="档位（时间线网格的行）"]')!;
      select.value = "短";
      select.dispatchEvent(new sharedWin.Event("change", { bubbles: true }));
    });
    await waitFor(() => /档位：短/.test(container.querySelector(".exp-pending-note")?.textContent ?? ""), "便笺显示已编辑档位");
    assert.equal(line.pending, true, "编辑不退出待打磨");

    await query(container, "迟到查询");
    await waitFor(() => ipc.calls.some((c) => c.cmd === "global_search" && c.args.query === "迟到查询"), "另一库搜索挂起");
    await changeLibrary(container);
    await waitFor(() => sharedWin.localStorage.getItem(LIBRARY_KEY) === originalLibrary, "切回原库");
    await interact(() => lateSearch.release({ hits: [pendingHit], warnings: [], truncated: false }));
    assert.equal(container.querySelector(".exp-pending-note"), null, "旧库构思对象已退出");
    assert.equal(container.querySelector(".global-search"), null, "迟到搜索不重开旧目的地");
    assert.equal(sharedWin.localStorage.getItem("gongbi.currentProject"), null);
    await query(container, book.name);
    await waitFor(() => !!container.querySelector(".global-search-open"), "原库拆书搜索命中");
    await interact(() => container.querySelector<HTMLButtonElement>(".global-search-open")!.click());
    await waitFor(() => !!container.querySelector(".editor-page .cm-editor"), "原库拆书重新打开");
    assert.equal(editor(container).state.doc.toString(), "旧库原稿，切库前输入，保存等待中又输入");

    await changeLibrary(container);
    await waitFor(() => sharedWin.localStorage.getItem(LIBRARY_KEY) === otherLibrary, "再次进入期待线所在库");
    await query(container, line.name);
    await waitFor(() => !!container.querySelector(".global-search-open"), "编辑后的期待线仍可搜索");
    await interact(() => container.querySelector<HTMLButtonElement>(".global-search-open")!.click());
    await waitFor(() => !!container.querySelector(".exp-pending-note.is-search-hit"), "便笺重新从所属项目载入");
    assert.match(container.querySelector(".exp-pending-note")!.textContent!, /档位：短/);
    await interact(() => button(container.querySelector(".exp-pending-note")!, "整理完成").click());
    await waitFor(() => !container.querySelector(".exp-pending-note"), "整理完成后空区消失");
    assert.equal(line.kind, "期待");
    assert.equal(line.horizon, "短");
    assert.equal(line.pending, false);
    assert.equal(alerts.length, 0, alerts.join("\n"));
  } finally {
    saveGate.release();
    lateSearch.release({ hits: [], warnings: [], truncated: false });
    await interact(() => root.unmount());
    container.remove();
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});
