/**
 * 页面回归夹具（工单 #77）：真实页面组件 + 外部 IPC 边界替身。
 *  保存、结算、导航守卫、冲突横幅全部走生产代码路径；只有
 *  window.__TAURI_INTERNALS__（IPC）被换成可控替身——与真实 Tauri
 *  应用只差命令实现本身。文件选择器等非 IPC 边界本套未触及。
 */
import "./installDom.ts";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { sharedWin } from "./installDom.ts";
import { updateSettings } from "../../src/settings";

export function deferred<T = unknown>() {
  let innerResolve!: (value: T) => void;
  let innerReject!: (reason: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    innerResolve = res;
    innerReject = rej;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    release(value?: T) {
      if (!settled) {
        settled = true;
        innerResolve(value as T);
      }
    },
  };
}

export type InvokeHandler = (
  cmd: string,
  args: Record<string, unknown>,
) => unknown;

export class MockIpc {
  readonly calls: { cmd: string; args: Record<string, unknown> }[] = [];
  /** 每次保存被 IPC 接到时的 (路径 → 内容)；先于任何 gate 记录。 */
  readonly saved = new Map<string, string>();
  private routes = new Map<string, InvokeHandler>();

  constructor(private fallback: InvokeHandler) {}

  on(cmd: string, handler: InvokeHandler): this {
    this.routes.set(cmd, handler);
    return this;
  }

  private readonly dispatch = async (
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> => {
    const a = args ?? {};
    this.calls.push({ cmd, args: a });
    const route = this.routes.get(cmd);
    if (route) return await route(a);
    return await this.fallback(cmd, a);
  };
}

export function applyTauriMock(ipc: MockIpc) {
  (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => ipc.dispatch(cmd, args),
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
  };
}

export async function flushDom(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 条件等待：轮询到断言前提成立（渲染/异步链完成），超时抛错。 */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

export interface ChapterFix {
  path: string;
  fileName: string;
  ordinal: number | null;
  title: string;
  content: string;
  fingerprint: string;
}

export interface PageFixture {
  ipc: MockIpc;
  container: HTMLElement;
  alerts: string[];
  confirms: string[];
  onBackCalls: number[];
  editorText(): string;
  chipText(): string | null;
  headerTitle(): string;
  /** 在正文末尾追加文字（模拟作者继续输入）。 */
  type(text: string): void;
  button(label: string): HTMLButtonElement;
  clickButton(label: string): void;
  unmount(): void;
}

interface MutableFixture extends PageFixture {
  __root?: Root;
}

function editorView(container: HTMLElement): EditorView {
  const el = container.querySelector(".cm-editor");
  if (!el) throw new Error("页面上找不到编辑器 DOM");
  const view = EditorView.findFromDOM(el as HTMLElement);
  if (!view) throw new Error("页面上找不到编辑器视图");
  return view;
}

function makeFixture(ipc: MockIpc): MutableFixture {
  const container = sharedWin.document.createElement("div");
  sharedWin.document.body.appendChild(container);
  const alerts: string[] = [];
  const confirms: string[] = [];
  sharedWin.alert = (message?: unknown) => {
    alerts.push(String(message));
  };
  sharedWin.confirm = (message?: unknown) => {
    confirms.push(String(message));
    return true;
  };
  applyTauriMock(ipc);
  const fixture: MutableFixture = {
    ipc,
    container,
    alerts,
    confirms,
    onBackCalls: [],
    editorText: () => editorView(container).state.doc.toString(),
    chipText: () => container.querySelector(".save-chip")?.textContent ?? null,
    headerTitle: () => container.querySelector(".editor-title")?.textContent ?? "",
    type(text: string) {
      const view = editorView(container);
      const at = view.state.doc.length;
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
      });
    },
    button(label: string): HTMLButtonElement {
      const buttons = Array.from(container.querySelectorAll("button"));
      const hit = buttons.find((b) => (b.textContent ?? "").trim() === label);
      if (!hit) throw new Error(`页面上找不到按钮「${label}」`);
      return hit as HTMLButtonElement;
    },
    clickButton(label: string) {
      fixture.button(label).click();
    },
    unmount() {
      finishUnmount(fixture);
    },
  };
  return fixture;
}

function finishUnmount(fixture: MutableFixture) {
  fixture.__root?.unmount();
  fixture.__root = undefined;
  fixture.container.remove();
  sharedWin.localStorage.clear();
  delete (sharedWin as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function render(fixture: MutableFixture, element: React.ReactElement) {
  const root = createRoot(fixture.container);
  fixture.__root = root;
  root.render(element);
}

/** 挂载书写编辑器（真实 WritingPage），默认打开第一章。 */
export async function mountWriting(
  chapters: ChapterFix[],
  opts: { projectDir?: string; projectTitle?: string } = {},
): Promise<PageFixture & { clickChapter(labelPart: string): void }> {
  updateSettings({ autosaveSec: 3 });
  const projectDir = opts.projectDir ?? "项目/《测试书》";
  const projectTitle = opts.projectTitle ?? "测试书";
  const mdOf = (p: unknown) => {
    const hit = chapters.find((c) => c.path === p);
    if (!hit) throw new Error(`读不到章节：${String(p)}`);
    return { content: hit.content, fingerprint: hit.fingerprint };
  };
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "read_project_meta":
        return { chapterPrefix: "第{n}章" };
      case "load_writing_stats":
        return { dailyGoal: 0, daily: {} };
      case "read_foreshadows":
        return [];
      case "expectation_board":
        return { maxChapter: 0, items: [] };
      case "find_chapter_intent":
        return { unit: null, bridge: null, warnings: [] };
      case "save_writing_stats":
        return null;
      case "scan_chapters":
        return chapters.map((c) => ({
          path: c.path,
          fileName: c.fileName,
          ordinal: c.ordinal,
          title: c.title,
          status: "草稿",
          wordCount: c.content.length,
          hanCount: c.content.length,
        }));
      case "read_book_md":
        return mdOf(args.path);
      case "save_chapter_md":
        ipc.saved.set(args.path as string, args.content as string);
        return { status: "saved", fingerprint: `saved:${String(args.path)}` };
      default:
        return null;
    }
  });
  const fixture = makeFixture(ipc) as MutableFixture & {
    clickChapter(labelPart: string): void;
  };
  const { default: WritingPage } = await import("../../src/WritingPage.tsx");
  const project = {
    dir: projectDir,
    name: `《${projectTitle}》`,
    title: projectTitle,
    chapterCount: chapters.length,
    wordCount: 0,
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
  const element = createElement(WritingPage as never, {
    project,
    libraryPath: "测试库",
    active: true,
    locate: { ordinal: null, path: chapters[0].path, quote: "" },
    onBack: () => fixture.onBackCalls.push(1),
    onChanged: () => {},
    onAiCommand: () => {},
    registerBridge: () => {},
    onChapterActive: () => {},
  } as never);
  render(fixture, element);
  fixture.clickChapter = (labelPart: string) => {
    const item = Array.from(fixture.container.querySelectorAll(".chapter-item")).find((b) =>
      (b.textContent ?? "").includes(labelPart),
    );
    if (!item) throw new Error(`页面上找不到章节「${labelPart}」`);
    (item as HTMLButtonElement).click();
  };  await flushDom(40);
  // 首次挂载冷启动较慢：等章节列表与编辑器真正渲染出来。
  await waitFor(
    () =>
      fixture.container.querySelectorAll(".chapter-item").length > 0 &&
      !!fixture.container.querySelector(".cm-editor"),
    "书写编辑器与章节列表就绪",
  );
  return fixture;
}

/** 挂载拆书编辑器（真实 EditorPage）。 */
export async function mountBookEditor(opts: {
  primaryMd: string;
  content: string;
  fingerprint: string;
  bookName?: string;
}): Promise<PageFixture> {
  updateSettings({ autosaveSec: 3 });
  const meta = {
    title: null,
    trackRecord: null,
    summary: null,
    goldenFinger: null,
    chapterPrefix: null,
  };
  const ipc = new MockIpc((cmd, args) => {
    switch (cmd) {
      case "migrate_book_header":
        return true;
      case "read_book_md":
        if (args.path === opts.primaryMd) {
          return { content: opts.content, fingerprint: opts.fingerprint };
        }
        throw new Error(`读不到拆书稿：${String(args.path)}`);
      case "read_book_meta":
        return meta;
      case "save_book_md":
        ipc.saved.set(args.path as string, args.content as string);
        return { status: "saved", fingerprint: `saved:${String(args.path)}` };
      default:
        return null;
    }
  });
  const fixture = makeFixture(ipc);
  const { default: EditorPage } = await import("../../src/EditorPage.tsx");
  const book = {
    name: opts.bookName ?? "示例书",
    layout: "folder-book",
    primaryMd: opts.primaryMd,
    mdCount: 1,
    chapterCount: 1,
    wordCount: opts.content.length,
    meta,
    tropes: [],
    cover: null,
    coverDir: "",
  };
  const element = createElement(EditorPage as never, {
    book,
    libraryPath: "测试库",
    active: true,
    onBack: () => fixture.onBackCalls.push(1),
    onAiCommand: () => {},
    registerBridge: () => {},
  } as never);
  render(fixture, element);
  await flushDom(40);
  await waitFor(() => !!fixture.container.querySelector(".cm-editor"), "拆书编辑器就绪");
  return fixture;
}
