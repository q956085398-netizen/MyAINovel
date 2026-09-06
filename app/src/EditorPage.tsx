import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import type { BookEntry, BookMeta, ChapterAnchor, TropeSpan } from "./types";
import { emptyBookMeta } from "./types";
import { errMsg } from "./util";
import BookMetaDialog from "./BookMetaDialog";
import TropeDialog from "./TropeDialog";

/** 五插入块（设计共识 §四）：Obsidian 风格 callout，纯 markdown 可读。 */
const INSERT_BLOCKS = ["点评", "如果是我写", "原文截图", "出场人物", "小结"] as const;

/** 章前缀只在前端暂存；空值由 Rust 侧回退默认「第{n}章」，单一事实源。 */
function normalizePrefix(prefix: string | null | undefined): string {
  return prefix?.trim() ?? "";
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
}

/** 拆书编辑器：前缀推进（Ctrl+Enter）、五插入块、截图粘贴、Ctrl+S 保存。
 *  父组件以 key=primaryMd 挂载，一本书一次生命周期。 */
export default function EditorPage({ book, onBack }: EditorPageProps) {
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

  function insertBlock(callout: string) {
    const view = viewRef.current;
    if (!view) return;
    insertAtLineEnd(view, `\n\n> [!${callout}]\n> `);
    view.focus();
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

  /** 桥段标注入口：章锚点按当前正文即时计算；桥段列表读同名 .yaml。 */
  async function openTropePanel() {
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
    setTropeDialog({ chapters, tropes, warning });
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
    })();

    return () => {
      cancelled = true;
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
