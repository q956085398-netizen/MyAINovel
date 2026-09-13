import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import type {
  AiCommandKind,
  AiSeed,
  BookEntry,
  BookMeta,
  ChapterAnchor,
  EditorBridge,
  MdContent,
  SaveResult,
  TropeSuggestion,
  TropeSpan,
} from "./types";
import { emptyBookMeta } from "./types";
import { errMsg } from "./util";
import { autosaveIntervalMs, chapterPrefixOrDefault } from "./settings";
import { registerFlushSaver } from "./saveFlush";
import { baseEditorTheme, editorAppearance, useEditorAppearance } from "./editorTheme";
import TropeDialog from "./TropeDialog";

/** 六插入块（设计共识 §四＋工单 #30 书档入家族）：Obsidian 风格 callout，
 *  纯 markdown 可读；书档常规来自模板与迁移，工具栏可补插。 */
const INSERT_BLOCKS = ["点评", "如果是我写", "原文截图", "出场人物", "小结", "书档"] as const;

/** 编辑器三命令（设计共识 §七）：AI 给初稿，人在侧边栏确认后才落盘。 */
const AI_COMMANDS: { kind: AiCommandKind; label: string }[] = [
  { kind: "梳理", label: "梳理选中内容" },
  { kind: "标注", label: "建议类型/解法标注" },
  { kind: "小结", label: "提炼小结" },
];

/** 章前缀只在前端暂存；空值由 Rust 侧回退默认「第{n}章」，单一事实源。 */
function normalizePrefix(prefix: string | null | undefined): string {
  return prefix?.trim() ?? "";
}

/** 行号落在哪一章（0 起索引）；行在首章标题之前返回 -1。 */
function chapterIndexForLine(chapters: ChapterAnchor[], line: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].line <= line) idx = i;
    else break;
  }
  return idx;
}

/** 行号→章标题序数（1 起）；首章标题之前算第 1 章。 */
function chapterOrdinalForLine(chapters: ChapterAnchor[], line: number): number {
  return chapterIndexForLine(chapters, line) + 1;
}

const editorTheme = baseEditorTheme({ fontSize: "15px", paddingBottom: "30vh" });

/** 外观随设置变化（工单 #24：深色；#26：排版）经 Compartment 重配。 */
const appearanceCompartment = new Compartment();

function insertAtLineEnd(view: EditorView, insert: string) {
  const pos = view.state.selection.main.head;
  const at = view.state.doc.lineAt(pos).to;
  view.dispatch({
    changes: { from: at, to: at, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
  });
}

interface EditorPageProps {
  book: BookEntry;
  /** 库根：桥段标注面板加载词表提示用。 */
  libraryPath: string | null;
  /** 拆书编辑器是否在前台（书库页签可见）：切走时立即保存（常驻挂载，不卸载）。 */
  active: boolean;
  onBack: () => void;
  /** 三命令出口：把选区种子递给 App 层的 AI 面板。 */
  onAiCommand: (seed: AiSeed) => void;
  /** 注册编辑器桥（文档快照＋采纳回写），卸载时置 null。 */
  registerBridge: (bridge: EditorBridge | null) => void;
}

/** 拆书编辑器：前缀推进（Ctrl+Enter）、五插入块、截图粘贴、Ctrl+S 保存；
 *  保存网与书写编辑器同一套（工单 #28，spec 拆书保存与模板 §二）——
 *  停笔防抖自动存＋返回即存＋切板块/卸载/关窗兜底＋覆盖前快照（Rust 侧）。
 *  父组件以 key=primaryMd 挂载，一本书一次生命周期。 */
export default function EditorPage({
  book,
  libraryPath,
  active,
  onBack,
  onAiCommand,
  registerBridge,
}: EditorPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const prefixRef = useRef("");
  /** 盘上正文的版本指纹（ADR 0004）：载入/保存成功后更新，保存时带回对账。 */
  const fingerprintRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  /** 冲突未裁决期间自动保存暂停（与书写编辑器同一纪律），手动保存仍可裁决。 */
  const conflictRef = useRef(false);
  const savingRef = useRef(false);
  const autosaveRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tropeDialog, setTropeDialog] = useState<{
    chapters: ChapterAnchor[];
    tropes: TropeSpan[];
    warning?: string;
  } | null>(null);

  async function openNextChapter() {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    const line = await invoke<string>("next_chapter_line", {
      content: text,
      template: prefixRef.current,
    });
    const sep = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const at = view.state.doc.length;
    const insert = `${sep}${line}\n`;
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  function insertBlock(callout: string, text?: string) {
    const view = viewRef.current;
    if (!view) return;
    // 带 text＝采纳 AI 初稿整段落盘；不带＝手写，留一个待填的引用行。
    const body = text ? text.split("\n").map((l) => `> ${l}`).join("\n") : "";
    insertAtLineEnd(view, `\n\n> [!${callout}]\n${body || "> "}`);
    view.focus();
  }

  /** 采纳 AI 初稿：插到命令选区末行（1 起，越界收敛到末行）的行尾，
   *  保证梳理/小结落在被处理内容旁边，而非碰巧的光标处。 */
  function insertCalloutAtLine(callout: "点评" | "小结", text: string, anchorLine: number) {
    const view = viewRef.current;
    if (!view) return false;
    const clamped = Math.min(Math.max(anchorLine, 1), view.state.doc.lines);
    const at = view.state.doc.line(clamped).to;
    const body = text.split("\n").map((l) => `> ${l}`).join("\n");
    view.dispatch({
      changes: { from: at, to: at, insert: `\n\n> [!${callout}]\n${body}` },
      selection: { anchor: at + body.length + 1 },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  /** 保存（门闩在此）：落定（保存成功/本无改动）返回 true。
   *  自动保存、手动保存、返回即存同走这一条链——指纹对账与冲突裁决不变。
   *  quiet＝兜底路径（卸载/关窗）：不弹框，冲突时盘上为准（ADR 0004）。 */
  async function save(force = false, quiet = false): Promise<boolean> {
    if (quiet && (!dirtyRef.current || conflictRef.current)) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    try {
      return await persist(force, quiet);
    } catch (e) {
      if (quiet) {
        console.error("拆书兜底保存失败：", e);
      } else {
        window.alert(`保存失败：${errMsg(e)}`);
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  /** 保存本体（门闩由 save 持有）：落盘或进入冲突裁决。
   *  返回是否「落定」——保存成功、本无改动、按盘上重载都算。 */
  async function persist(force: boolean, quiet = false): Promise<boolean> {
    const view = viewRef.current;
    if (!view) return true;
    if (!force && !dirtyRef.current) return true;
    const content = view.state.doc.toString();
    const result = await invoke<SaveResult>("save_book_md", {
      path: book.primaryMd,
      content,
      base: fingerprintRef.current,
      force,
    });
    if (result.status === "saved") {
      fingerprintRef.current = result.fingerprint;
      conflictRef.current = false;
      // 保存往返窗口里又打过字的不算干净：留着脏标让下一轮自动保存接走。
      if (viewRef.current?.state.doc.toString() === content) {
        dirtyRef.current = false;
        setDirty(false);
      }
      return true;
    }
    if (quiet) return false;
    // 指纹对不上：盘上被外部程序改过，交人裁决（既有两段确认）。
    conflictRef.current = true;
    if (
      window.confirm(
        "保存被拦下：文件在保存前已被其他程序修改（可能是在 Obsidian 里编辑过）。\n\n" +
          "「确定」＝重新加载盘上内容（放弃编辑器里未保存的修改）；\n" +
          "「取消」＝留在编辑器，可选择是否用当前内容覆盖盘上文件。",
      )
    ) {
      try {
        const doc = await invoke<MdContent>("read_book_md", { path: book.primaryMd });
        const v = viewRef.current;
        if (!v) return true;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.content } });
        fingerprintRef.current = doc.fingerprint;
        conflictRef.current = false;
        dirtyRef.current = false;
        setDirty(false);
        return true;
      } catch (e) {
        window.alert(`重新加载失败：${errMsg(e)}`);
        return false;
      }
    } else if (window.confirm("要用编辑器里的当前内容覆盖盘上文件吗？\n（盘上被外部修改的内容将丢失）")) {
      // 直接走 persist(true)（force 不可能再冲突），不经 save 以免撞门闩。
      return await persist(true);
    }
    return false;
  }

  /** 停笔防抖自动保存（工单 #28）：docChanged 重置计时，停笔满设置间隔落盘。 */
  function scheduleAutosave() {
    if (autosaveRef.current !== null) window.clearTimeout(autosaveRef.current);
    autosaveRef.current = window.setTimeout(() => {
      autosaveRef.current = null;
      if (!dirtyRef.current || conflictRef.current) return;
      if (savingRef.current) {
        scheduleAutosave();
        return;
      }
      void save(false);
    }, autosaveIntervalMs());
  }

  function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return false;
    event.preventDefault();
    void (async () => {
      for (const file of files) {
        const ext = file.type.split("/")[1] || "png";
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        try {
          const rel = await invoke<string>("save_paste_image", {
            mdPath: book.primaryMd,
            ext,
            bytes,
          });
          insertAtLineEnd(view, `\n\n![](${rel})\n`);
        } catch (e) {
          window.alert(`截图保存失败：${errMsg(e)}`);
        }
      }
    })();
    return true;
  }

  /** 返回即存（工单 #28）：先落盘再退回书库——返回永远不丢内容；
   *  保存遇冲突时弹既有裁决框，裁决没落定（取消）就留在编辑器。 */
  async function handleBack() {
    if (dirtyRef.current && !(await save(false))) return;
    onBack();
  }

  /** 桥段标注入口：章锚点按当前正文即时计算；桥段列表读同名 .yaml。
   *  prefill＝采纳 AI 标注建议：选区行号换算章范围，作为待确认条目进列表。 */
  async function openTropePanel(
    prefill?: { startLine: number; endLine: number; suggestion: TropeSuggestion },
  ) {
    const view = viewRef.current;
    if (!view) return;
    let chapters: ChapterAnchor[];
    try {
      chapters = await invoke<ChapterAnchor[]>("list_chapters", {
        content: view.state.doc.toString(),
        template: prefixRef.current,
      });
    } catch (e) {
      window.alert(`章标题识别失败：${errMsg(e)}`);
      return;
    }
    let tropes: TropeSpan[] = [];
    let warning: string | undefined;
    try {
      tropes = await invoke<TropeSpan[]>("read_tropes", { mdPath: book.primaryMd });
    } catch (e) {
      warning = `已有 .yaml 解析失败：${errMsg(e)}。保存桥段会整文件覆盖，请先确认内容。`;
    }
    if (prefill) {
      if (chapters.length === 0) {
        // 建议不能静默丢：把结论亮出来，用户知道为什么没预填。
        window.alert(
          `正文中没有检测到章标题，无法预填桥段标注。\n\nAI 建议——类型：` +
            `${prefill.suggestion.types.join("、")}` +
            `${prefill.suggestion.solution ? `；解法：${prefill.suggestion.solution}` : ""}\n\n` +
            `可先用「开下一章」或按章前缀写标题后，再到「桥段标注」手动录入。`,
        );
        return;
      }
      tropes = [
        ...tropes,
        {
          startChapter: chapterOrdinalForLine(chapters, prefill.startLine),
          endChapter: chapterOrdinalForLine(chapters, Math.max(prefill.endLine, prefill.startLine)),
          types: prefill.suggestion.types,
          solution: prefill.suggestion.solution,
        },
      ];
    }
    setTropeDialog({ chapters, tropes, warning });
  }

  /** 编辑器三命令：梳理/标注要求先选中文本；小结空选区时落回当前章或全文。 */
  async function runAiCommand(kind: AiCommandKind) {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    let text = view.state.doc.sliceString(sel.from, sel.to).trim();
    let startLine = view.state.doc.lineAt(sel.from).number;
    let endLine = view.state.doc.lineAt(sel.to).number;
    let note: string | undefined;

    if (!text && kind === "小结") {
      const doc = view.state.doc;
      let chapters: ChapterAnchor[];
      try {
        chapters = await invoke<ChapterAnchor[]>("list_chapters", {
          content: doc.toString(),
          template: prefixRef.current,
        });
      } catch (e) {
        window.alert(`章标题识别失败：${errMsg(e)}`);
        return;
      }
      const cursorLine = doc.lineAt(sel.head).number;
      const ci = chapterIndexForLine(chapters, cursorLine);
      if (ci >= 0) {
        const from = chapters[ci].line;
        const to = ci + 1 < chapters.length ? chapters[ci + 1].line - 1 : doc.lines;
        const lines: string[] = [];
        for (let l = from; l <= to; l++) lines.push(doc.line(l).text);
        text = lines.join("\n").trim();
        startLine = from;
        endLine = to;
        note = chapters[ci].title;
      } else {
        text = doc.toString().trim();
        startLine = 1;
        endLine = doc.lines;
        note = "全文";
      }
    }

    if (!text) {
      const label = AI_COMMANDS.find((c) => c.kind === kind)?.label ?? kind;
      window.alert(`请先在正文中选中要处理的内容，再执行「${label}」。`);
      return;
    }
    onAiCommand({ kind, bookName: book.name, text, startLine, endLine, note });
  }

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;

    void (async () => {
      // 打开书先做书档一次性迁移（工单 #30，spec §五）：yaml 四键搬上纸面。
      // 迁移失败（yaml 读不懂）不拦打开——桥段面板保存时另有显式告警。
      try {
        await invoke<boolean>("migrate_book_header", { mdPath: book.primaryMd });
      } catch (e) {
        console.warn("书档迁移跳过（yaml 解析失败）：", e);
      }
      let content: string;
      let fingerprint: string;
      try {
        const doc = await invoke<MdContent>("read_book_md", { path: book.primaryMd });
        content = doc.content;
        fingerprint = doc.fingerprint;
      } catch (e) {
        if (!cancelled) setLoadError(`读取拆书稿失败：${errMsg(e)}`);
        return;
      }

      // 章前缀取值（spec §六）：书 yaml 自定义键 > 全局设置（默认 第{n}章）；
      // 空值由 Rust 侧回退默认，单一事实源。yaml 读取失败不拦编辑器。
      let meta: BookMeta = emptyBookMeta();
      try {
        meta = await invoke<BookMeta>("read_book_meta", { mdPath: book.primaryMd });
      } catch (e) {
        console.warn("读取书 yaml 失败（章前缀回退全局设置）：", e);
      }
      if (cancelled || !containerRef.current) return;
      prefixRef.current = normalizePrefix(meta.chapterPrefix) || chapterPrefixOrDefault();
      fingerprintRef.current = fingerprint;

      view = new EditorView({
        parent: containerRef.current,
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            markdown(),
            editorTheme,
            appearanceCompartment.of(editorAppearance()),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                dirtyRef.current = true;
                setDirty(true);
                scheduleAutosave();
              }
            }),
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-Enter",
                  preventDefault: true,
                  run: () => {
                    void openNextChapter();
                    return true;
                  },
                },
                {
                  key: "Mod-s",
                  preventDefault: true,
                  run: () => {
                    void save();
                    return true;
                  },
                },
              ]),
            ),
            EditorView.domEventHandlers({ paste: handlePaste }),
          ],
        }),
      });
      viewRef.current = view;
      setReady(true);
      registerBridge({
        getDoc: () => {
          const v = viewRef.current;
          return v
            ? { bookName: book.name, path: book.primaryMd, content: v.state.doc.toString() }
            : null;
        },
        adoptCallout: (kind, text, anchorLine) => insertCalloutAtLine(kind, text, anchorLine),
        adoptTrope: (startLine, endLine, suggestion) => {
          void openTropePanel({ startLine, endLine, suggestion });
        },
      });
    })();

    return () => {
      cancelled = true;
      if (autosaveRef.current !== null) window.clearTimeout(autosaveRef.current);
      // 卸载兜底：异步 IPC 在组件销毁后仍会完成，正文先于 destroy 同步取走。
      void save(false, true);
      registerBridge(null);
      view?.destroy();
      viewRef.current = null;
    };
    // 本组件按书重挂载（父组件 key），book 在生命周期内不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关窗兜底（工单 #28）：应用级关窗事件里静默落盘。save 只读 ref，
  // 首渲染实例即可。
  useEffect(
    () =>
      registerFlushSaver(async () => {
        await save(false, true);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 切出拆书板块（隐藏不卸载）立即落盘（工单 #28）；切回来焦点还给编辑器。
  useEffect(() => {
    if (active) {
      viewRef.current?.focus();
    } else if (dirtyRef.current && !conflictRef.current) {
      void save(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 设置变化（主题/排版）→ 编辑器外观重配（视图异步就绪前订阅先挂上，
  // dispatch 时 viewRef 没有就不动，挂载时已带最新外观）。
  useEditorAppearance(viewRef, appearanceCompartment);

  if (loadError) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>{book.name}</h1>
          </div>
        </header>
        <div className="error-box">{loadError}</div>
        <button className="btn" onClick={onBack}>
          返回书库
        </button>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="editor-header">
        <button className="btn" onClick={() => void handleBack()}>
          ← 返回
        </button>
        <h1 className="editor-title">
          {book.name}
          {dirty && <span className="dirty-dot" title="未保存" />}
        </h1>
        <div className="page-actions">
          <button className="btn" disabled={!ready} onClick={() => void openTropePanel()}>
            桥段标注
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void openNextChapter()}>
            开下一章
          </button>
          <button className="btn" disabled={!ready || !dirty} onClick={() => void save()}>
            保存
          </button>
        </div>
      </header>
      <div className="editor-toolbar">
        <span className="toolbar-label">插入块</span>
        {INSERT_BLOCKS.map((b) => (
          <button key={b} className="btn small" disabled={!ready} onClick={() => insertBlock(b)}>
            {b}
          </button>
        ))}
        <span className="toolbar-label">AI 命令</span>
        {AI_COMMANDS.map((c) => (
          <button
            key={c.kind}
            className="btn small ai-cmd"
            disabled={!ready}
            title="发给 AI 侧边栏出初稿，确认后才落盘"
            onClick={() => void runAiCommand(c.kind)}
          >
            {c.label}
          </button>
        ))}
        <span className="toolbar-hint">
          停笔自动保存 · Ctrl+Enter 开下一章 · Ctrl+S 立即保存 · 粘贴图片自动存入附件
        </span>
      </div>
      <div className="editor-container" ref={containerRef} />
      {tropeDialog && (
        <TropeDialog
          mdPath={book.primaryMd}
          libraryPath={libraryPath}
          chapters={tropeDialog.chapters}
          initial={tropeDialog.tropes}
          warning={tropeDialog.warning}
          onClose={() => setTropeDialog(null)}
          onSaved={() => setTropeDialog(null)}
        />
      )}
    </div>
  );
}
