import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  highlightActiveLine,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChapterEntry,
  MdContent,
  ProjectEntry,
  ProjectMeta,
  SaveResult,
  SnapshotEntry,
  UnitBrief,
  WritingStats,
} from "./types";
import { CHAPTER_STATUS_VALUES, STATUS_DONE, STATUS_DRAFT, emptyWritingStats } from "./types";
import { errMsg, formatCount } from "./util";
import {
  chapterLabel,
  chapterStats,
  countBilled,
  readChapterStatus,
  todayKey,
  upsertFrontmatterStatus,
} from "./chapterFile";
import { baseEditorTheme } from "./editorTheme";

/** 自动保存防抖：停笔约 3 秒落盘（用户拍板「自动保存为主」）。 */
const AUTOSAVE_MS = 3000;
const PREFS_KEY = "gongbi.writing.prefs";
const chapterKey = (dir: string) => `gongbi.writing.chapter.${dir}`;

const editorTheme = baseEditorTheme({ fontSize: "17px", paddingBottom: "40vh" });

const typewriterCompartment = new Compartment();
const dimCompartment = new Compartment();

/** 打字机滚动：选区变化后把光标行滚到视口中央。 */
function typewriterExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.selectionSet) return;
        const view = update.view;
        window.requestAnimationFrame(() => {
          if (!view.dom.isConnected) return;
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }),
          });
        });
      }
    },
  );
}

/** 行淡化：非当前行加 dim class（只装饰视口内的行，长文也便宜）。 */
function dimmingExtension(): Extension {
  const dimLine = Decoration.line({ class: "cm-dim-line" });
  function build(view: EditorView): DecorationSet {
    const active = view.state.doc.lineAt(view.state.selection.main.head).number;
    const ranges: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        if (line.number !== active) ranges.push(dimLine.range(line.from));
        if (line.to + 1 > to) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(ranges);
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function loadPrefs(): { typewriter: boolean; dimming: boolean } {
  const fallback = { typewriter: true, dimming: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<typeof fallback>) };
  } catch {
    return fallback;
  }
}

/** 新建/重命名/每日目标三个单输入框弹窗共用一个壳。 */
type ChapterDialog = { kind: "new" | "rename" | "goal"; value: string };

interface WritingPageProps {
  project: ProjectEntry;
  /** 书写板块当前是否在前台：切走时立即保存（板块常驻挂载，不卸载）。 */
  active: boolean;
  onBack: () => void;
  /** 正文有变化：让上层刷新项目列表的计数。 */
  onChanged: () => void;
}

/** 写作页（工单 #5，docs/spec/书写编辑器.md）：章节列表＋单章编辑器＋
 *  状态栏＋联动侧栏。自动保存穿指纹闸（ADR 0004），写盘前留历史版本。 */
export default function WritingPage({ project, active, onBack, onChanged }: WritingPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const extensionsRef = useRef<Extension[] | null>(null);
  const currentRef = useRef<ChapterEntry | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  const baselineRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const autosaveRef = useRef<number | null>(null);
  const countsTimerRef = useRef<number | null>(null);
  const statsRef = useRef<WritingStats>(emptyWritingStats());

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [current, setCurrent] = useState<ChapterEntry | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [counts, setCounts] = useState({ billed: 0, han: 0, sel: 0 });
  const [stats, setStats] = useState<WritingStats>(emptyWritingStats());
  const [status, setStatus] = useState(STATUS_DRAFT);
  const [unit, setUnit] = useState<UnitBrief | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [dialog, setDialog] = useState<ChapterDialog | null>(null);
  const [history, setHistory] = useState<null | {
    list: SnapshotEntry[];
    selected: string | null;
    preview: string;
  }>(null);

  // ---------- 编辑器装配 ----------

  function refreshCounts(view: EditorView) {
    const content = view.state.doc.toString();
    const s = chapterStats(content);
    setCounts((c) => ({ ...c, billed: s.wordCount, han: s.hanCount }));
    setStatus(readChapterStatus(content));
  }

  function refreshSelection(view: EditorView) {
    const sel = view.state.selection.main;
    const next = sel.empty ? 0 : countBilled(view.state.doc.sliceString(sel.from, sel.to));
    setCounts((c) => (c.sel === next ? c : { ...c, sel: next }));
  }

  function scheduleAutosave() {
    if (autosaveRef.current !== null) window.clearTimeout(autosaveRef.current);
    autosaveRef.current = window.setTimeout(() => {
      autosaveRef.current = null;
      void saveNow(false);
    }, AUTOSAVE_MS);
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
          const rel = await invoke<string>("save_chapter_paste_image", {
            project: project.dir,
            ext,
            bytes,
          });
          const pos = view.state.selection.main.head;
          const insert = `\n\n![](${rel})\n`;
          view.dispatch({
            changes: { from: pos, insert },
            selection: { anchor: pos + insert.length },
            scrollIntoView: true,
          });
        } catch (e) {
          window.alert(`截图保存失败：${errMsg(e)}`);
        }
      }
    })();
    return true;
  }

  function buildExtensions(): Extension[] {
    return [
      basicSetup,
      markdown(),
      editorTheme,
      highlightActiveLine(),
      typewriterCompartment.of(prefs.typewriter ? typewriterExtension() : []),
      dimCompartment.of(prefs.dimming ? dimmingExtension() : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          dirtyRef.current = true;
          setDirty(true);
          if (countsTimerRef.current !== null) window.clearTimeout(countsTimerRef.current);
          countsTimerRef.current = window.setTimeout(() => {
            countsTimerRef.current = null;
            refreshCounts(u.view);
          }, 150);
          scheduleAutosave();
        }
        if (u.selectionSet) refreshSelection(u.view);
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
              void saveNow(false);
              return true;
            },
          },
        ]),
      ),
      EditorView.domEventHandlers({ paste: handlePaste }),
    ];
  }

  function ensureView(): EditorView {
    if (viewRef.current) return viewRef.current;
    if (!extensionsRef.current) extensionsRef.current = buildExtensions();
    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({ doc: "", extensions: extensionsRef.current }),
    });
    viewRef.current = view;
    return view;
  }

  /** 用盘上内容重建编辑器状态：setState 不触发 updateListener，
   *  所以载入不会被误判成「用户改了」。光标落到文末并聚焦——
   *  打开一章就是要接着往下写。 */
  function loadContent(content: string) {
    const view = ensureView();
    if (!extensionsRef.current) extensionsRef.current = buildExtensions();
    view.setState(EditorState.create({ doc: content, extensions: extensionsRef.current }));
    view.dispatch({ selection: { anchor: content.length }, scrollIntoView: true });
    view.focus();
    const s = chapterStats(content);
    baselineRef.current = s.wordCount;
    setCounts({ billed: s.wordCount, han: s.hanCount, sel: 0 });
    setStatus(readChapterStatus(content));
    dirtyRef.current = false;
    setDirty(false);
  }

  // ---------- 读写 ----------

  async function rescan(): Promise<ChapterEntry[]> {
    const list = await invoke<ChapterEntry[]>("scan_chapters", { project: project.dir });
    setChapters(list);
    return list;
  }

  async function loadUnit(entry: ChapterEntry) {
    if (entry.ordinal === null) {
      setUnit(null);
      return;
    }
    try {
      setUnit(
        await invoke<UnitBrief | null>("find_unit_for_chapter", {
          project: project.dir,
          ordinal: entry.ordinal,
        }),
      );
    } catch {
      setUnit(null);
    }
  }

  async function openChapter(entry: ChapterEntry): Promise<boolean> {
    if (currentRef.current && dirtyRef.current) {
      const ok = await saveNow(false);
      if (!ok) return false;
    }
    try {
      const doc = await invoke<MdContent>("read_book_md", { path: entry.path });
      currentRef.current = entry;
      setCurrent(entry);
      fingerprintRef.current = doc.fingerprint;
      conflictRef.current = false;
      setConflict(false);
      loadContent(doc.content);
      localStorage.setItem(chapterKey(project.dir), entry.path);
      void loadUnit(entry);
      return true;
    } catch (e) {
      window.alert(`读取章节失败：${errMsg(e)}`);
      return false;
    }
  }

  function addTodayWords(delta: number) {
    const key = todayKey();
    const cur = statsRef.current;
    const next: WritingStats = {
      ...cur,
      daily: { ...cur.daily, [key]: (cur.daily[key] ?? 0) + delta },
    };
    statsRef.current = next;
    setStats(next);
    void invoke("save_writing_stats", { stats: next }).catch(() => {});
  }

  /** 保存当前章（指纹闸）：成功 true；冲突 false（横幅交人裁决）。 */
  async function saveNow(force: boolean): Promise<boolean> {
    const view = viewRef.current;
    const entry = currentRef.current;
    if (!view || !entry) return true;
    if (savingRef.current) return false;
    // 没有改动就不写盘（也避免无谓快照）；force 用于冲突后的「确认覆盖」。
    if (!force && !dirtyRef.current) return true;
    if (conflictRef.current && !force) return false;
    savingRef.current = true;
    try {
      const content = view.state.doc.toString();
      const result = await invoke<SaveResult>("save_chapter_md", {
        project: project.dir,
        path: entry.path,
        content,
        base: fingerprintRef.current,
        force,
      });
      if (result.status === "conflict") {
        conflictRef.current = true;
        setConflict(true);
        return false;
      }
      fingerprintRef.current = result.fingerprint;
      conflictRef.current = false;
      setConflict(false);
      dirtyRef.current = false;
      setDirty(false);
      const s = chapterStats(content);
      const delta = s.wordCount - baselineRef.current;
      baselineRef.current = s.wordCount;
      if (delta !== 0) addTodayWords(delta);
      const statusNow = readChapterStatus(content);
      setChapters((list) =>
        list.map((c) =>
          c.path === entry.path
            ? { ...c, wordCount: s.wordCount, hanCount: s.hanCount, status: statusNow }
            : c,
        ),
      );
      return true;
    } catch (e) {
      window.alert(`保存失败：${errMsg(e)}`);
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  async function reloadFromDisk() {
    const entry = currentRef.current;
    if (!entry) return;
    if (!window.confirm("重新加载会放弃编辑器里未保存的修改，确定吗？")) return;
    try {
      const doc = await invoke<MdContent>("read_book_md", { path: entry.path });
      fingerprintRef.current = doc.fingerprint;
      conflictRef.current = false;
      setConflict(false);
      loadContent(doc.content);
    } catch (e) {
      window.alert(`重新加载失败：${errMsg(e)}`);
    }
  }

  async function forceOverwrite() {
    if (
      !window.confirm(
        "要用编辑器里的内容覆盖盘上文件吗？\n（盘上被外部修改的内容会先留一份历史版本）",
      )
    ) {
      return;
    }
    await saveNow(true);
  }

  // ---------- 章节动作 ----------

  async function openNextChapter() {
    if (currentRef.current && dirtyRef.current) {
      const ok = await saveNow(false);
      if (!ok) return;
    }
    try {
      const created = await invoke<ChapterEntry>("create_chapter", {
        project: project.dir,
        title: "",
      });
      await rescan();
      await openChapter(created);
    } catch (e) {
      window.alert(`新建下一章失败：${errMsg(e)}`);
    }
  }

  async function createChapter(title: string) {
    try {
      const created = await invoke<ChapterEntry>("create_chapter", {
        project: project.dir,
        title,
      });
      setDialog(null);
      await rescan();
      await openChapter(created);
    } catch (e) {
      window.alert(`新建章节失败：${errMsg(e)}`);
    }
  }

  async function renameCurrent(title: string) {
    const entry = currentRef.current;
    if (!entry) return;
    if (dirtyRef.current && !(await saveNow(false))) return;
    try {
      const renamed = await invoke<ChapterEntry>("rename_chapter", {
        path: entry.path,
        title,
      });
      currentRef.current = renamed;
      setCurrent(renamed);
      localStorage.setItem(chapterKey(project.dir), renamed.path);
      setDialog(null);
      await rescan();
    } catch (e) {
      window.alert(`重命名失败：${errMsg(e)}`);
    }
  }

  async function deleteCurrent() {
    const entry = currentRef.current;
    if (!entry) return;
    if (
      !window.confirm(
        `删除「${chapterLabel(entry, prefix)}」？\n文件会直接删除（历史版本仍留在 .gongbi/历史/ 里）。`,
      )
    ) {
      return;
    }
    if (autosaveRef.current !== null) {
      window.clearTimeout(autosaveRef.current);
      autosaveRef.current = null;
    }
    const index = chapters.findIndex((c) => c.path === entry.path);
    try {
      await invoke("delete_chapter", { path: entry.path });
      currentRef.current = null;
      setCurrent(null);
      setUnit(null);
      const list = await rescan();
      const next = list.length > 0 ? list[Math.min(Math.max(index, 0), list.length - 1)] : null;
      if (next) await openChapter(next);
      else loadContent("");
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    }
  }

  async function renumber() {
    if (
      !window.confirm(
        "把合规章节按当前顺序重排为 1..N（文件名会变，未编号文件不动）？",
      )
    ) {
      return;
    }
    const entry = currentRef.current;
    if (entry && dirtyRef.current && !(await saveNow(false))) return;
    const numbered = chapters.filter((c) => c.ordinal !== null);
    const position = entry ? numbered.findIndex((c) => c.path === entry.path) : -1;
    try {
      const list = await invoke<ChapterEntry[]>("renumber_chapters", { project: project.dir });
      setChapters(list);
      if (position >= 0) {
        const target = list.find((c) => c.ordinal === position + 1);
        if (target) {
          currentRef.current = target;
          setCurrent(target);
          localStorage.setItem(chapterKey(project.dir), target.path);
        }
      }
    } catch (e) {
      window.alert(`重编号失败：${errMsg(e)}`);
    }
  }

  function changeStatus(next: string) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: upsertFrontmatterStatus(view.state.doc.toString(), next) });
    setStatus(next);
    view.focus();
  }

  function togglePref(key: "typewriter" | "dimming", value: boolean) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    viewRef.current?.dispatch({
      effects: [
        typewriterCompartment.reconfigure(next.typewriter ? typewriterExtension() : []),
        dimCompartment.reconfigure(next.dimming ? dimmingExtension() : []),
      ],
    });
  }

  async function openHistory() {
    const entry = currentRef.current;
    if (!entry) return;
    try {
      const list = await invoke<SnapshotEntry[]>("list_chapter_snapshots", {
        project: project.dir,
        path: entry.path,
      });
      setHistory({ list, selected: null, preview: "" });
    } catch (e) {
      window.alert(`读取历史版本失败：${errMsg(e)}`);
    }
  }

  async function selectSnapshot(path: string) {
    try {
      const preview = await invoke<string>("read_chapter_snapshot", { path });
      setHistory((h) => (h ? { ...h, selected: path, preview } : h));
    } catch (e) {
      window.alert(`读取历史版本失败：${errMsg(e)}`);
    }
  }

  async function restoreSnapshot() {
    if (!history?.selected) return;
    if (dirtyRef.current && !window.confirm("当前有未保存的修改，恢复历史版本会覆盖它们，确定吗？")) {
      return;
    }
    try {
      const content = await invoke<string>("read_chapter_snapshot", { path: history.selected });
      loadContent(content);
      dirtyRef.current = true;
      setDirty(true);
      scheduleAutosave();
      setHistory(null);
      viewRef.current?.focus();
    } catch (e) {
      window.alert(`恢复失败：${errMsg(e)}`);
    }
  }

  async function saveGoal(raw: string) {
    const goal = Math.max(0, Math.round(Number(raw) || 0));
    const next = { ...statsRef.current, dailyGoal: goal };
    statsRef.current = next;
    setStats(next);
    setDialog(null);
    await invoke("save_writing_stats", { stats: next }).catch(() => {});
  }

  function submitDialog(d: ChapterDialog) {
    if (d.kind === "new") void createChapter(d.value);
    else if (d.kind === "rename") void renameCurrent(d.value);
    else void saveGoal(d.value);
  }

  async function handleBack() {
    if (dirtyRef.current && !(await saveNow(false))) return;
    onChanged();
    onBack();
  }

  // ---------- 生命周期 ----------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const meta = await invoke<ProjectMeta>("read_project_meta", { project: project.dir });
        if (!cancelled) setPrefix(meta.chapterPrefix);
      } catch {
        // 项目.yaml 读不了：章前缀回退默认，不挡写作。
      }
      try {
        const loaded = await invoke<WritingStats>("load_writing_stats");
        if (!cancelled) {
          statsRef.current = loaded;
          setStats(loaded);
        }
      } catch {
        // 统计读不了：从零起算。
      }
      let list: ChapterEntry[] = [];
      try {
        list = await rescan();
      } catch (e) {
        if (!cancelled) setLoadError(`扫描正文失败：${errMsg(e)}`);
        return;
      }
      if (cancelled) return;
      const remembered = localStorage.getItem(chapterKey(project.dir));
      const numbered = list.filter((c) => c.ordinal !== null);
      const pick =
        list.find((c) => c.path === remembered) ?? numbered[numbered.length - 1] ?? list[0];
      if (pick) await openChapter(pick);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      if (autosaveRef.current !== null) window.clearTimeout(autosaveRef.current);
      if (countsTimerRef.current !== null) window.clearTimeout(countsTimerRef.current);
      void saveNow(false);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // 本组件按项目重挂载（父组件 key），project 在生命周期内不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  // 切出书写板块：立即落盘；切回来：焦点还给编辑器（板块常驻挂载，不卸载）。
  useEffect(() => {
    if (active) viewRef.current?.focus();
    else if (dirtyRef.current) void saveNow(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const totalWords = chapters.reduce(
    (sum, c) => sum + (current && c.path === current.path ? counts.billed : c.wordCount),
    0,
  );
  const todayWords = stats.daily[todayKey()] ?? 0;

  if (loadError) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>{project.title}</h1>
          </div>
          <button className="btn" onClick={onBack}>
            ← 项目列表
          </button>
        </header>
        <div className="error-box">{loadError}</div>
      </div>
    );
  }

  return (
    <div className={`writing-page ${immersive ? "immersive" : ""}`}>
      <header className="editor-header">
        <button className="btn" onClick={() => void handleBack()}>
          ← 项目列表
        </button>
        <h1 className="editor-title">
          {current ? chapterLabel(current, prefix) : project.title}
          {dirty && <span className="dirty-dot" title="未保存" />}
        </h1>
        <div className="page-actions">
          {immersive ? (
            <button className="btn" onClick={() => setImmersive(false)}>
              退出沉浸（Esc）
            </button>
          ) : (
            <>
              <button className="btn" disabled={!ready} onClick={() => setImmersive(true)}>
                沉浸
              </button>
              <button className="btn" disabled={!current} onClick={() => void openHistory()}>
                历史版本
              </button>
              <button className="btn" onClick={() => setListOpen((v) => !v)}>
                {listOpen ? "收起列表" : "章节列表"}
              </button>
              <button className="btn" onClick={() => setSidebarOpen((v) => !v)}>
                {sidebarOpen ? "收起侧栏" : "侧栏"}
              </button>
            </>
          )}
        </div>
      </header>

      {conflict && (
        <div className="conflict-bar">
          <span>本章已被外部修改（可能是在 Obsidian 里编辑过），自动保存已暂停。</span>
          <button className="btn small" onClick={() => void reloadFromDisk()}>
            重新加载
          </button>
          <button className="btn small" onClick={() => void forceOverwrite()}>
            确认覆盖
          </button>
        </div>
      )}

      <div className="writing-body">
        {listOpen && (
          <aside className="chapter-list">
          <div className="chapter-list-head">
            <span className="toolbar-label">章节</span>
            <button
              className="btn small"
              disabled={!ready}
              title="新建一章（Ctrl+Enter 直接开下一章）"
              onClick={() => setDialog({ kind: "new", value: "" })}
            >
              新建
            </button>
            <button className="btn small" onClick={() => void rescan()}>
              刷新
            </button>
          </div>
          <div className="chapter-items">
            {chapters.length === 0 && <p className="hint">还没有章节，点「新建」开始。</p>}
            {chapters.map((c) => (
              <button
                key={c.path}
                className={`chapter-item ${current?.path === c.path ? "active" : ""}`}
                title={c.fileName}
                onClick={() => void openChapter(c)}
              >
                <span className="chapter-label">{chapterLabel(c, prefix)}</span>
                <span className="chapter-meta">
                  {formatCount(c.wordCount)} 字
                  {c.status === STATUS_DONE && (
                    <span className="chapter-done">{STATUS_DONE}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {current && (
            <div className="chapter-list-foot">
              <button
                className="btn small"
                onClick={() => setDialog({ kind: "rename", value: current.title })}
              >
                重命名
              </button>
              <button className="btn small" onClick={() => void renumber()}>
                重编号
              </button>
              <button className="btn small danger" onClick={() => void deleteCurrent()}>
                删除
              </button>
            </div>
          )}
        </aside>
        )}

        <div className="writing-editor" ref={containerRef} />

        {sidebarOpen && (
          <aside className="writing-sidebar">
            <h2 className="sidebar-title">本章在书里的位置</h2>
            {unit ? (
              <>
                <div className="unit-head">
                  <span className="unit-name">{unit.name}</span>
                  {unit.index !== null && unit.total > 0 && (
                    <span className="unit-pos">
                      第 {unit.index}/{unit.total} 个单元
                    </span>
                  )}
                </div>
                {unit.types.length > 0 && <p className="unit-types">{unit.types.join(" · ")}</p>}
                {unit.core && (
                  <p className="unit-core">
                    <span className="field-label">核心矛盾</span>
                    {unit.core}
                  </p>
                )}
                <p className="unit-attrs">
                  {[
                    unit.line && `线：${unit.line}`,
                    unit.map && `地图：${unit.map}`,
                    unit.upgradeBattle && `升级战斗：${unit.upgradeBattle}`,
                    unit.pace && `节奏：${unit.pace}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "排布里还没给这个单元定属性"}
                </p>
                <div className="unit-body">
                  <span className="field-label">桥段安排</span>
                  <pre>{unit.body.trim() || "（单元里还没写桥段安排）"}</pre>
                </div>
              </>
            ) : (
              <p className="hint">
                {current?.ordinal === null
                  ? "这一章的文件名没有章号，无法对应到单元。"
                  : "本章还没归入单元。到「构思 → 单元」里给单元填上起章/止章，这里就会显示它所在的位置。"}
              </p>
            )}
          </aside>
        )}
      </div>

      <footer className="writing-status">
        <span>本章 {formatCount(counts.billed)} 字</span>
        <span className="status-sep">汉字 {formatCount(counts.han)}</span>
        {counts.sel > 0 && <span className="status-sep">选中 {formatCount(counts.sel)} 字</span>}
        <span className="status-sep">全书 {formatCount(totalWords)} 字</span>
        <button
          className="btn small"
          title="设置每日目标"
          onClick={() => setDialog({ kind: "goal", value: String(stats.dailyGoal) })}
        >
          今日 {formatCount(todayWords)}/{formatCount(stats.dailyGoal)}
        </button>
        <select
          className="status-select"
          value={status}
          title="章节状态"
          onChange={(e) => changeStatus(e.target.value)}
        >
          {CHAPTER_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="status-toggle">
          <input
            type="checkbox"
            checked={prefs.typewriter}
            onChange={(e) => togglePref("typewriter", e.target.checked)}
          />
          打字机
        </label>
        <label className="status-toggle">
          <input
            type="checkbox"
            checked={prefs.dimming}
            onChange={(e) => togglePref("dimming", e.target.checked)}
          />
          行淡化
        </label>
        <span className="status-right">{dirty ? "未保存" : "已保存"}</span>
      </footer>

      {chapters.length === 0 && ready && (
        <div className="writing-empty">
          <p>这本书还没有正文。</p>
          <button
            className="btn primary"
            onClick={() => setDialog({ kind: "new", value: "" })}
          >
            新建第一章
          </button>
        </div>
      )}

      {dialog && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <div className="dialog">
            <h2>
              {dialog.kind === "new" ? "新建章节" : dialog.kind === "rename" ? "重命名" : "每日目标"}
            </h2>
            <label>
              {dialog.kind === "goal" ? "每日目标字数" : "章节标题（可留空）"}
              <input
                value={dialog.value}
                autoFocus
                type={dialog.kind === "goal" ? "number" : "text"}
                placeholder={dialog.kind === "new" ? "如：初入江湖" : ""}
                onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitDialog(dialog);
                }}
              />
            </label>
            {dialog.kind === "new" && (
              <p className="hint">新章序号取现有最大号 +1；标题留空则文件叫 0007.md。</p>
            )}
            <div className="dialog-actions">
              <button className="btn" onClick={() => setDialog(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => submitDialog(dialog)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {history && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHistory(null);
          }}
        >
          <div className="dialog history-dialog">
            <h2>历史版本</h2>
            <div className="history-body">
              <div className="history-list">
                {history.list.length === 0 && <p className="hint">还没有历史版本。</p>}
                {history.list.map((s) => (
                  <button
                    key={s.path}
                    className={`history-item ${history.selected === s.path ? "active" : ""}`}
                    onClick={() => void selectSnapshot(s.path)}
                  >
                    <span>{new Date(s.time).toLocaleString("zh-Hans-CN")}</span>
                    <span className="chapter-meta">{formatCount(s.wordCount)} 字</span>
                  </button>
                ))}
              </div>
              <pre className="history-preview">
                {history.selected ? history.preview : "点左侧版本看内容"}
              </pre>
            </div>
            <p className="hint">
              恢复＝把这个版本载入编辑器（不直接落盘），确认后再保存；自动保存也会接管。
            </p>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setHistory(null)}>
                关闭
              </button>
              <button
                className="btn primary"
                disabled={!history.selected}
                onClick={() => void restoreSnapshot()}
              >
                恢复此版本
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
