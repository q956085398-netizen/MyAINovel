import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
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
  TropeSuggestion,
  TropeSpan,
} from "./types";
import { emptyBookMeta } from "./types";
import { errMsg } from "./util";
import BookMetaDialog from "./BookMetaDialog";
import TropeDialog from "./TropeDialog";

/** 五插入块（设计共识 §四）：Obsidian 风格 callout，纯 markdown 可读。 */
const INSERT_BLOCKS = ["点评", "如果是我写", "原文截图", "出场人物", "小结"] as const;

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

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px" },
  ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
  ".cm-content": { paddingBottom: "30vh" },
});

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
  onBack: () => void;
  /** 三命令出口：把选区种子递给 App 层的 AI 面板。 */
  onAiCommand: (seed: AiSeed) => void;
  /** 注册编辑器桥（文档快照＋采纳回写），卸载时置 null。 */
  registerBridge: (bridge: EditorBridge | null) => void;
}

/** 拆书编辑器：前缀推进（Ctrl+Enter）、五插入块、截图粘贴、Ctrl+S 保存。
 *  父组件以 key=primaryMd 挂载，一本书一次生命周期。 */
export default function EditorPage({ book, onBack, onAiCommand, registerBridge }: EditorPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const prefixRef = useRef("");
  const savingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaInit, setMetaInit] = useState<{ meta: BookMeta; warning?: string }>({
    meta: emptyBookMeta(),
  });
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

  async function save() {
    const view = viewRef.current;
    if (!view || savingRef.current) return;
    savingRef.current = true;
    try {
      await invoke("save_book_md", { path: book.primaryMd, content: view.state.doc.toString() });
      setDirty(false);
    } catch (e) {
      window.alert(`保存失败：${errMsg(e)}`);
    } finally {
      savingRef.current = false;
    }
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

  function handleBack() {
    if (dirty && !window.confirm("有未保存的修改，返回将丢失，确定吗？")) return;
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
      let content: string;
      try {
        content = await invoke<string>("read_book_md", { path: book.primaryMd });
      } catch (e) {
        if (!cancelled) setLoadError(`读取拆书稿失败：${errMsg(e)}`);
        return;
      }

      let meta: BookMeta = emptyBookMeta();
      let metaWarn: string | undefined;
      try {
        meta = await invoke<BookMeta>("read_book_meta", { mdPath: book.primaryMd });
      } catch (e) {
        metaWarn = `已有 .yaml 解析失败：${errMsg(e)}。在「书级资料」保存会整文件覆盖，请先确认内容。`;
      }
      if (cancelled || !containerRef.current) return;
      prefixRef.current = normalizePrefix(meta.chapterPrefix);
      setMetaInit({ meta, warning: metaWarn });

      view = new EditorView({
        parent: containerRef.current,
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            markdown(),
            editorTheme,
            EditorView.updateListener.of((u) => {
              if (u.docChanged) setDirty(true);
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
      registerBridge(null);
      view?.destroy();
      viewRef.current = null;
    };
    // 本组件按书重挂载（父组件 key），book 在生命周期内不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <button className="btn" onClick={handleBack}>
          ← 返回
        </button>
        <h1 className="editor-title">
          {book.name}
          {dirty && <span className="dirty-dot" title="未保存" />}
        </h1>
        <div className="page-actions">
          <button className="btn" disabled={!ready} onClick={() => setMetaOpen(true)}>
            书级资料
          </button>
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
          Ctrl+Enter 开下一章 · Ctrl+S 保存 · 粘贴图片自动存入附件
        </span>
      </div>
      <div className="editor-container" ref={containerRef} />
      {metaOpen && (
        <BookMetaDialog
          mdPath={book.primaryMd}
          initial={metaInit.meta}
          warning={metaInit.warning}
          onClose={() => setMetaOpen(false)}
          onSaved={(m) => {
            prefixRef.current = normalizePrefix(m.chapterPrefix);
            setMetaInit({ meta: m });
            setMetaOpen(false);
          }}
        />
      )}
      {tropeDialog && (
        <TropeDialog
          mdPath={book.primaryMd}
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
