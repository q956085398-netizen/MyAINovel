import "./helpers/installDom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import GlobalSearch from "../src/GlobalSearch";
import { LibrarySessionContext } from "../src/librarySession";
import {
  applyTauriMock,
  deferred,
  flushDom,
  MockIpc,
  waitFor,
} from "./helpers/pageHarness.ts";
import { sharedWin } from "./helpers/installDom.ts";

const PATH_KEY = "gongbi.libraryPath";
const OLD_ROOT = "C:/创作/旧库";
const NEW_ROOT = "C:/创作/新库";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function bookAt(root: string, title: string) {
  return {
    name: title,
    layout: "folder-book",
    primaryMd: `${root}/《${title}》/拆书.md`,
    mdCount: 1,
    chapterCount: 1,
    wordCount: 20,
    meta: { title, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null },
    tropes: [],
    cover: null,
    coverDir: "",
  };
}

function click(container: HTMLElement, selector: string, name: string) {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`页面上找不到${name}`);
  node.click();
}

async function openLibrarySettings(container: HTMLElement): Promise<HTMLButtonElement> {
  click(container, '[aria-label="设置"]', "设置入口");
  await waitFor(() => !!container.querySelector(".settings-page"), "设置页出现");
  const tab = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "库与数据",
  );
  if (!tab) throw new Error("页面上找不到库与数据页签");
  tab.click();
  const button = Array.from(container.querySelectorAll(".settings-content button")).find(
    (item) => item.textContent?.trim() === "更改库位置",
  );
  if (!button) throw new Error("页面上找不到更改库位置按钮");
  return button as HTMLButtonElement;
}

test("切到空新库后，迟到的旧库扫描不能把旧拆书稿带回来", async () => {
  sharedWin.localStorage.clear();
  sharedWin.localStorage.setItem(PATH_KEY, OLD_ROOT);
  sharedWin.localStorage.setItem("gongbi.settingsTab", "library");

  const oldScan = deferred<ReturnType<typeof bookAt>[]>();
  const oldAiSession = {
    id: "old-library-chat",
    title: "旧库对话",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ role: "assistant", content: "旧库 AI 建议", meta: { kind: "梳理", endLine: 1 } }],
  };
  const legacyAiSession = {
    ...oldAiSession,
    id: "legacy-unscoped-chat",
    title: "未记录库归属的历史对话",
    messages: [{ role: "assistant", content: "未归属的历史建议", meta: { kind: "梳理", endLine: 1 } }],
  };
  sharedWin.localStorage.setItem(
    "gongbi.ai.sessionRoots",
    JSON.stringify({ [oldAiSession.id]: OLD_ROOT }),
  );
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open":
        return NEW_ROOT;
      case "plugin:event|listen":
        return 1;
      case "scan_library":
        return args.root === OLD_ROOT ? oldScan.promise : [];
      case "scan_projects":
      case "scan_inspirations":
        return [];
      case "list_chat_sessions":
        return [oldAiSession, legacyAiSession].map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: 1,
          messageCount: 1,
        }));
      case "load_chat_session":
        return args.id === legacyAiSession.id ? legacyAiSession : oldAiSession;
      case "load_ai_config":
        return { providers: [], activeProviderId: null };
      case "load_assistant_presets":
        return null;
      default:
        return null;
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    root.render(createElement(App));
    await waitFor(() => ipc.calls.some((c) => c.cmd === "scan_library" && c.args.root === OLD_ROOT), "旧库扫描开始");
    const aiSessionSelect = container.querySelector<HTMLSelectElement>(".ai-session-select");
    assert.ok(aiSessionSelect, "AI 会话选择器出现");
    await waitFor(
      () => !!aiSessionSelect.querySelector(`option[value="${oldAiSession.id}"]`),
      "旧库 AI 会话载入列表",
    );
    await act(async () => {
      aiSessionSelect.value = oldAiSession.id;
      aiSessionSelect.dispatchEvent(new sharedWin.Event("change", { bubbles: true }));
      await flushDom(30);
    });
    await waitFor(() => container.textContent?.includes("旧库 AI 建议"), "旧库 AI 对话打开");
    assert.ok(container.querySelector(".ai-adopt"), "同库历史消息在切库前仍可采纳");

    (await openLibrarySettings(container)).click();

    for (const key of [
      "gongbi.lastBook",
      "gongbi.ideation.project",
      "gongbi.writing.project",
      "gongbi.currentProject",
    ]) sharedWin.localStorage.setItem(key, `${OLD_ROOT}/旧对象`);

    await waitFor(() => ipc.calls.some((c) => c.cmd === "scan_library" && c.args.root === NEW_ROOT), "新库扫描开始");
    await waitFor(() => container.textContent?.includes("没有找到拆书稿"), "新库空态出现");
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), NEW_ROOT);
    assert.equal(container.textContent?.includes("旧库 AI 建议"), false, "切库后旧对话不留在活动采纳上下文");
    const switchedAiSelect = container.querySelector<HTMLSelectElement>(".ai-session-select");
    assert.ok(switchedAiSelect, "切库后 AI 会话选择器仍保留历史");
    await waitFor(
      () => !!switchedAiSelect.querySelector(`option[value="${oldAiSession.id}"]`),
      "历史会话在新库中仍可查看",
    );
    await act(async () => {
      switchedAiSelect.value = oldAiSession.id;
      switchedAiSelect.dispatchEvent(new sharedWin.Event("change", { bubbles: true }));
      await flushDom(30);
    });
    await waitFor(() => container.textContent?.includes("旧库 AI 建议"), "重新打开旧库 AI 历史");
    assert.equal(container.querySelector(".ai-adopt"), null, "旧库建议在新库中只读，不能回写");
    assert.match(container.textContent ?? "", /历史对话未记录当前库归属/);
    const historicalInput = container.querySelector<HTMLTextAreaElement>(".ai-input");
    const sendButton = container.querySelector<HTMLButtonElement>(".ai-composer-actions .btn.primary");
    assert.ok(historicalInput && sendButton);
    assert.equal(historicalInput.disabled, true, "跨库历史的输入框禁用");
    assert.equal(sendButton.disabled, true, "跨库历史不能继续发送");
    const savedSessionsBeforeAttempt = ipc.calls.filter((call) => call.cmd === "save_chat_session").length;
    await act(async () => {
      historicalInput.disabled = false;
      const setter = Object.getOwnPropertyDescriptor(sharedWin.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(historicalInput, "尝试在新库继续旧对话");
      historicalInput.dispatchEvent(new sharedWin.Event("input", { bubbles: true }));
      await flushDom(10);
    });
    await act(async () => {
      // 强制触发按钮处理器，验证 UI 禁用之外的发送守卫也不会重标会话归属。
      sendButton.disabled = false;
      sendButton.click();
      await flushDom(30);
    });
    assert.equal(
      ipc.calls.filter((call) => call.cmd === "save_chat_session").length,
      savedSessionsBeforeAttempt,
      "旧会话没有写入新库归属或继续保存",
    );
    assert.equal(container.querySelector(".ai-adopt"), null, "发送尝试后旧建议仍不可采纳");
    await act(async () => {
      switchedAiSelect.value = legacyAiSession.id;
      switchedAiSelect.dispatchEvent(new sharedWin.Event("change", { bubbles: true }));
      await flushDom(30);
    });
    await waitFor(() => container.textContent?.includes("未归属的历史建议"), "打开未记录库归属的历史");
    assert.equal(container.querySelector(".ai-adopt"), null, "未记录库归属的历史也保持只读");
    for (const key of [
      "gongbi.lastBook",
      "gongbi.ideation.project",
      "gongbi.writing.project",
      "gongbi.currentProject",
    ]) assert.equal(sharedWin.localStorage.getItem(key), null, `${key} 已随切库清除`);

    oldScan.release([bookAt(OLD_ROOT, "旧库遗留书")]);
    await flushDom(60);

    assert.equal(container.textContent?.includes("旧库遗留书"), false);
    assert.match(container.textContent ?? "", /没有找到拆书稿/);
  } finally {
    root.unmount();
    container.remove();
    await flushDom(40);
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});

test("取消选择或旧稿保存失败时，库偏好与拆书编辑器都留在原库", async () => {
  sharedWin.localStorage.clear();
  sharedWin.localStorage.setItem(PATH_KEY, OLD_ROOT);
  sharedWin.localStorage.setItem("gongbi.lastBook", bookAt(OLD_ROOT, "旧书").primaryMd);
  sharedWin.localStorage.setItem("gongbi.settingsTab", "library");
  const alerts: string[] = [];
  sharedWin.alert = (message?: unknown) => alerts.push(String(message));
  const selections: (string | null)[] = [null, NEW_ROOT, NEW_ROOT];
  let saveMode: "failed" | "conflict" = "failed";
  const oldBook = bookAt(OLD_ROOT, "旧书");
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open":
        return selections.shift() ?? null;
      case "plugin:event|listen":
        return 1;
      case "scan_library":
        return args.root === OLD_ROOT ? [oldBook] : [];
      case "scan_projects":
      case "scan_inspirations":
      case "list_chat_sessions":
        return [];
      case "load_ai_config":
        return { providers: [], activeProviderId: null };
      case "load_assistant_presets":
        return null;
      case "migrate_book_header":
        return true;
      case "read_book_md":
        return { content: "旧稿正文", fingerprint: "old-fingerprint" };
      case "read_book_meta":
        return { title: null, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null };
      case "save_book_md":
        if (saveMode === "failed") throw new Error("磁盘暂时不可写");
        return { status: "conflict" };
      default:
        return null;
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    root.render(createElement(App));
    await waitFor(() => !!container.querySelector(".cm-editor"), "旧拆书稿编辑器就绪");

    const changeFolder = await openLibrarySettings(container);
    changeFolder.click();
    await flushDom(30);
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), OLD_ROOT);
    assert.ok(container.querySelector(".editor-page"), "取消后仍留在旧拆书稿");

    const editor = container.querySelector(".cm-editor");
    assert.ok(editor);
    const view = EditorView.findFromDOM(editor as HTMLElement);
    assert.ok(view);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "未保存的新字" },
    });
    changeFolder.click();

    await waitFor(() => alerts.length >= 2, "编辑器保存失败和切库拦截提示");
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), OLD_ROOT);
    assert.match(container.textContent ?? "", /旧库/);
    assert.ok(container.querySelector(".editor-page"), "保存失败后原编辑器仍可用");
    assert.equal(view.state.doc.toString(), "旧稿正文未保存的新字");
    assert.equal(ipc.calls.some((call) => call.cmd === "scan_library" && call.args.root === NEW_ROOT), false);

    saveMode = "conflict";
    changeFolder.click();
    await waitFor(() => alerts.length >= 3, "未裁决的保存冲突阻止切库");
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), OLD_ROOT);
    assert.ok(container.querySelector(".editor-page"), "冲突未裁决时仍留在原拆书稿");
    assert.equal(view.state.doc.toString(), "旧稿正文未保存的新字");
    assert.equal(ipc.calls.some((call) => call.cmd === "scan_library" && call.args.root === NEW_ROOT), false);
  } finally {
    root.unmount();
    container.remove();
    await flushDom(40);
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});

test("切库等待中的拆书稿保存完成后，仍写回旧库再进入新库", async () => {
  sharedWin.localStorage.clear();
  const book = bookAt(OLD_ROOT, "需要保存的书");
  sharedWin.localStorage.setItem(PATH_KEY, OLD_ROOT);
  sharedWin.localStorage.setItem("gongbi.lastBook", book.primaryMd);
  sharedWin.localStorage.setItem("gongbi.settingsTab", "library");
  const alerts: string[] = [];
  sharedWin.alert = (message?: unknown) => alerts.push(String(message));
  const saveGate = deferred<{ status: string; fingerprint: string }>();
  const saveRequests: { path: string; content: string }[] = [];
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open":
        return NEW_ROOT;
      case "plugin:event|listen":
        return 1;
      case "scan_library":
        return args.root === OLD_ROOT ? [book] : [];
      case "scan_projects":
      case "scan_inspirations":
      case "list_chat_sessions":
        return [];
      case "load_ai_config":
        return { providers: [], activeProviderId: null };
      case "load_assistant_presets":
        return null;
      case "migrate_book_header":
        return true;
      case "read_book_md":
        return { content: "原有文字", fingerprint: "before" };
      case "read_book_meta":
        return { title: null, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null };
      case "save_book_md":
        saveRequests.push({ path: String(args.path), content: String(args.content) });
        return saveGate.promise;
      default:
        return null;
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    root.render(createElement(App));
    await waitFor(() => !!container.querySelector(".cm-editor"), "旧拆书稿编辑器就绪");
    const editor = container.querySelector(".cm-editor");
    assert.ok(editor);
    const view = EditorView.findFromDOM(editor as HTMLElement);
    assert.ok(view);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "切库前补充" } });

    (await openLibrarySettings(container)).click();
    await waitFor(() => saveRequests.length > 0, "切库触发旧稿保存");
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), OLD_ROOT, "保存未完成前不改偏好");
    assert.ok(container.querySelector(".editor-page"), "保存等待期间仍保留旧编辑器");
    assert.deepEqual(saveRequests[0], {
      path: book.primaryMd,
      content: "原有文字切库前补充",
    });

    saveGate.release({ status: "saved", fingerprint: "after" });
    await waitFor(() => sharedWin.localStorage.getItem(PATH_KEY) === NEW_ROOT, "保存后提交切库");
    await waitFor(() => ipc.calls.some((call) => call.cmd === "scan_library" && call.args.root === NEW_ROOT), "新库扫描");
    assert.equal(container.querySelector(".editor-page"), null);
    assert.equal(alerts.length, 0);
  } finally {
    root.unmount();
    container.remove();
    await flushDom(40);
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});

test("在两个已有库之间切换后只显示新库拆书稿", async () => {
  sharedWin.localStorage.clear();
  sharedWin.localStorage.setItem(PATH_KEY, OLD_ROOT);
  sharedWin.localStorage.setItem("gongbi.settingsTab", "library");
  const oldBook = bookAt(OLD_ROOT, "甲库的书");
  const newBook = bookAt(NEW_ROOT, "乙库的书");
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open":
        return NEW_ROOT;
      case "plugin:event|listen":
        return 1;
      case "scan_library":
        return args.root === OLD_ROOT ? [oldBook] : [newBook];
      case "scan_projects":
      case "scan_inspirations":
      case "list_chat_sessions":
        return [];
      case "load_ai_config":
        return { providers: [], activeProviderId: null };
      case "load_assistant_presets":
        return null;
      default:
        return null;
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    root.render(createElement(App));
    await waitFor(() => container.textContent?.includes("甲库的书") ?? false, "旧库书目出现");

    (await openLibrarySettings(container)).click();
    await waitFor(() => container.textContent?.includes("乙库的书") ?? false, "新库书目出现");
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), NEW_ROOT);
    assert.equal(container.textContent?.includes("甲库的书"), false);
    assert.ok(container.textContent?.includes("乙库的书"));
  } finally {
    root.unmount();
    container.remove();
    await flushDom(40);
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});

test("旧拆书稿读取在切库后返回时，不再读取书档或装回编辑器", async () => {
  sharedWin.localStorage.clear();
  sharedWin.localStorage.setItem(PATH_KEY, OLD_ROOT);
  sharedWin.localStorage.setItem("gongbi.lastBook", bookAt(OLD_ROOT, "迟到的书").primaryMd);
  sharedWin.localStorage.setItem("gongbi.settingsTab", "library");
  const oldRead = deferred<{ content: string; fingerprint: string }>();
  let readMetaCalls = 0;
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "plugin:dialog|open":
        return NEW_ROOT;
      case "plugin:event|listen":
        return 1;
      case "scan_library":
        return args.root === OLD_ROOT ? [bookAt(OLD_ROOT, "迟到的书")] : [];
      case "scan_projects":
      case "scan_inspirations":
      case "list_chat_sessions":
        return [];
      case "load_ai_config":
        return { providers: [], activeProviderId: null };
      case "load_assistant_presets":
        return null;
      case "migrate_book_header":
        return true;
      case "read_book_md":
        return oldRead.promise;
      case "read_book_meta":
        readMetaCalls += 1;
        return { title: null, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null };
      default:
        return null;
    }
  });
  applyTauriMock(ipc);
  const internals = (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = { currentWindow: { label: "main" } };
  (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    const { default: App } = await import("../src/App.tsx");
    root.render(createElement(App));
    await waitFor(() => ipc.calls.some((call) => call.cmd === "read_book_md"), "旧拆书稿读取挂起");

    (await openLibrarySettings(container)).click();
    await waitFor(() => ipc.calls.some((call) => call.cmd === "scan_library" && call.args.root === NEW_ROOT), "新库已切换");
    oldRead.release({ content: "不应装回来的正文", fingerprint: "late" });
    await flushDom(50);

    assert.equal(readMetaCalls, 0, "迟到正文返回后不继续读取旧书档");
    assert.equal(container.querySelector(".cm-editor"), null, "旧编辑器没有在新库重现");
    assert.equal(container.textContent?.includes("不应装回来的正文"), false);
    assert.equal(sharedWin.localStorage.getItem(PATH_KEY), NEW_ROOT);
  } finally {
    root.unmount();
    container.remove();
    await flushDom(40);
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  }
});

test("搜索结果跨库迟到时，不会把旧库命中重新显示出来", async () => {
  sharedWin.localStorage.clear();
  const oldResult = deferred<{ hits: { kind: string; title: string; path: string; projectDir: null; projectTitle: null; category: null; matches: [] }[]; warnings: string[]; truncated: boolean }>();
  let activeSession = 1;
  const ipc = new MockIpc((cmd, args) => {
    if (cmd !== "global_search") return null;
    if (args.root === OLD_ROOT) return oldResult.promise;
    return { hits: [], warnings: [], truncated: false };
  });
  applyTauriMock(ipc);
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const renderSearch = (id: number, library: string) =>
    root.render(
      createElement(
        LibrarySessionContext.Provider,
        { value: { id, isCurrent: (session) => session === activeSession } },
        createElement(GlobalSearch, { root: library, onClose: () => {}, onOpen: async () => {} }),
      ),
  );
  try {
    await act(async () => {
      renderSearch(1, OLD_ROOT);
      await flushDom(25);
    });
    await waitFor(() => !!container.querySelector(".global-search"), "搜索框出现");
    const input = container.querySelector<HTMLInputElement>(".global-search-label input");
    assert.ok(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(sharedWin.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "旧词");
      input.dispatchEvent(new sharedWin.Event("input", { bubbles: true }));
      await flushDom(20);
    });
    await waitFor(() => ipc.calls.some((call) => call.cmd === "global_search" && call.args.root === OLD_ROOT), "旧库搜索发出");

    await act(async () => {
      activeSession = 2;
      renderSearch(2, NEW_ROOT);
      await flushDom(20);
    });
    await act(async () => {
      oldResult.release({
        hits: [{ kind: "拆书", title: "旧库搜索命中", path: `${OLD_ROOT}/旧.md`, projectDir: null, projectTitle: null, category: null, matches: [] }],
        warnings: [],
        truncated: false,
      });
      await flushDom(60);
    });

    assert.equal(container.textContent?.includes("旧库搜索命中"), false);
  } finally {
    await act(async () => {
      root.unmount();
      await flushDom(20);
    });
    container.remove();
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});

test("切库后迟到的旧项目跳转不会打开旧书写项目", async () => {
  sharedWin.localStorage.clear();
  const oldProject = {
    dir: `${OLD_ROOT}/项目/《旧书》`,
    name: "《旧书》",
    title: "旧书",
    chapterCount: 1,
    wordCount: 20,
    unitCount: 0,
    contradictionCount: 0,
    characterCount: 0,
    worldviewCount: 0,
    openingCount: 0,
    foreshadowCount: 0,
    expectationExpectCount: 0,
    expectationGoalCount: 0,
    cover: null,
    coverDir: "",
  };
  const oldProjects = deferred<typeof oldProject[]>();
  let activeSession = 1;
  let consumed = 0;
  const ipc = new MockIpc((cmd, args) => {
    if (cmd === "scan_projects") return args.root === OLD_ROOT ? oldProjects.promise : [];
    return null;
  });
  applyTauriMock(ipc);
  const { default: Writing } = await import("../src/Writing.tsx");
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const renderWriting = (id: number, library: string, jump: object | null) =>
    root.render(
      createElement(
        LibrarySessionContext.Provider,
        { value: { id, isCurrent: (session) => session === activeSession } },
        createElement(Writing, {
          libraryPath: library,
          active: true,
          onChooseFolder: () => {},
          onCreateLibrary: () => {},
          jump: jump as never,
          onJumpConsumed: () => { consumed += 1; },
          onAiCommand: () => {},
          registerBridge: () => {},
          onManuscriptChange: () => {},
        }),
      ),
    );
  try {
    await act(async () => {
      renderWriting(1, OLD_ROOT, { projectDir: oldProject.dir, locate: null });
      await flushDom(25);
    });
    await waitFor(() => ipc.calls.some((call) => call.cmd === "scan_projects" && call.args.root === OLD_ROOT), "旧项目跳转扫描开始");

    await act(async () => {
      activeSession = 2;
      renderWriting(2, NEW_ROOT, null);
      await flushDom(25);
    });
    oldProjects.release([oldProject]);
    await flushDom(60);

    assert.equal(consumed, 0, "旧跳转没有被消费");
    assert.equal(sharedWin.localStorage.getItem("gongbi.currentProject"), null);
    assert.equal(container.querySelector(".writing-page"), null);
    assert.equal(container.textContent?.includes("旧书"), false);
  } finally {
    await act(async () => {
      root.unmount();
      await flushDom(20);
    });
    container.remove();
    sharedWin.localStorage.clear();
    delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});
