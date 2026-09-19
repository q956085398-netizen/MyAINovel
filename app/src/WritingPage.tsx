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
  AiSeed,
  ChapterIntent,
  ChapterEntry,
  ExpectationBoard,
  Foreshadow,
  MdContent,
  ProofIssue,
  ProjectEntry,
  ProjectMeta,
  SaveResult,
  SnapshotEntry,
  WritingBridge,
  WritingLocate,
  WritingStats,
} from "./types";
import { AI_CHAPTER_COMPANION } from "./types";
import {
  CHAPTER_STATUS_VALUES,
  EXPECTATION_HORIZON_MID,
  EXPECTATION_KINDS,
  STATUS_DONE,
  STATUS_DRAFT,
  emptyWritingStats,
  expectationKindLabel,
  expectationOverdueChapters,
} from "./types";
import { errMsg, formatCount } from "./util";
import { autosaveIntervalMs } from "./settings";
import { registerFlushSaver } from "./saveFlush";
import {
  chapterLabel,
  chapterStats,
  countBilled,
  readChapterStatus,
  todayKey,
  upsertFrontmatterStatus,
} from "./chapterFile";
import { findQuote } from "./foreshadowAnchor";
import { ForeshadowCollectDialog, ForeshadowNameDialog } from "./ForeshadowDialog";
import { ExpectationFormDialog, ExpectationFulfillDialog } from "./ExpectationDialog";
import { baseEditorTheme, editorAppearance, useEditorAppearance } from "./editorTheme";
import { dirName, editorRender } from "./editorRender";
import { useImageViewer } from "./ImageViewer";
import TypographyToolbar from "./TypographyToolbar";
import { ExportDialog } from "./ExportDialog";
import { ArrowLeft, Icon, ICON_SIZE_DENSE } from "./icons";

/** 自动保存防抖：停笔满设置间隔（默认 3 秒，工单 #28 起两编辑器共用）落盘。 */
const PREFS_KEY = "gongbi.writing.prefs";
const chapterKey = (dir: string) => `gongbi.writing.chapter.${dir}`;

const editorTheme = baseEditorTheme({ fontSize: "17px", paddingBottom: "40vh" });

const typewriterCompartment = new Compartment();
const dimCompartment = new Compartment();
const foreshadowCompartment = new Compartment();
/** 外观随设置变化（工单 #24：深色；#26：排版）经 Compartment 重配。 */
const appearanceCompartment = new Compartment();

/** 伏笔引文装饰（工单 #6）：正文零污染——装饰只画在编辑器里，
 *  引文匹配走 findQuote（与 Rust 同一规则）；失配的引文不装饰。 */
interface ForeshadowMark {
  name: string;
  state: string;
  quote: string;
  /** 回收记录＝实线，埋设＝虚线。 */
  recovered: boolean;
}

function foreshadowExtension(marks: ForeshadowMark[]): Extension {
  const build = (view: EditorView): DecorationSet => {
    if (marks.length === 0) return Decoration.none;
    const text = view.state.doc.toString();
    const ranges: Range<Decoration>[] = [];
    for (const m of marks) {
      const hit = findQuote(text, m.quote);
      if (!hit) continue;
      ranges.push(
        Decoration.mark({
          class: m.recovered ? "cm-foreshadow-recovered" : "cm-foreshadow-planted",
          attributes: { title: `伏笔：${m.name} · ${m.state}` },
        }).range(hit.from, hit.to),
      );
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

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
  libraryPath: string | null;
  /** 书写板块当前是否在前台：切走时立即保存（板块常驻挂载，不卸载）。 */
  active: boolean;
  /** 跳转请求：打开该章并选中引文（仅挂载时生效）。 */
  locate?: WritingLocate | null;
  onBack: () => void;
  /** 正文有变化：让上层刷新项目列表的计数。 */
  onChanged: () => void;
  /** 板块 AI 命令（AI 陪看本章/润色）：种子交给 AI 面板。 */
  onAiCommand: (seed: AiSeed) => void;
  /** 向 AI 面板注册回写桥：采纳润色＝替换当前选区。 */
  registerBridge: (bridge: WritingBridge | null) => void;
}

/** 写作页（工单 #5，docs/spec/书写编辑器.md）：章节列表＋单章编辑器＋
 *  状态栏＋联动侧栏。自动保存穿指纹闸（ADR 0004），写盘前留历史版本。 */
export default function WritingPage({
  project,
  libraryPath,
  active,
  locate,
  onBack,
  onChanged,
  onAiCommand,
  registerBridge,
}: WritingPageProps) {
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
  const menuRef = useRef<HTMLDivElement | null>(null);

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
  const [intent, setIntent] = useState<ChapterIntent | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [dialog, setDialog] = useState<ChapterDialog | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [history, setHistory] = useState<null | {
    list: SnapshotEntry[];
    selected: string | null;
    preview: string;
  }>(null);
  // 伏笔（工单 #6）：项目全量列表＋当前正文（侧栏判「引文失配」用）。
  const foreshadowsRef = useRef<Foreshadow[]>([]);
  const [foreshadows, setForeshadows] = useState<Foreshadow[]>([]);
  const [docText, setDocText] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [annotate, setAnnotate] = useState<{ quote: string } | null>(null);
  const [collect, setCollect] = useState<{ quote: string } | null>(null);
  const [foreshadowBusy, setForeshadowBusy] = useState(false);
  // 三线（工单 #7）：看板视图（未推进章数/超期由 Rust 现算）供侧栏与弹窗用。
  const [expectations, setExpectations] = useState<ExpectationBoard>({
    maxChapter: 0,
    items: [],
  });
  // 记为期待线：右键菜单一步定类别（期待感/目标，工单 #36），弹窗只填名字＋档位。
  const [expAnnotate, setExpAnnotate] = useState<{ quote: string; kind: string } | null>(null);
  const [expFulfill, setExpFulfill] = useState<{ quote: string } | null>(null);
  const [expectationBusy, setExpectationBusy] = useState(false);
  // 内联图查看器（工单 #31）：点正文里的截图弹原图。
  const imageViewer = useImageViewer();
  const unit = intent?.unit ?? null;

  // ---------- 编辑器装配 ----------

  function refreshCounts(view: EditorView) {
    const content = view.state.doc.toString();
    const s = chapterStats(content);
    setCounts((c) => ({ ...c, billed: s.wordCount, han: s.hanCount }));
    setStatus(readChapterStatus(content));
    // 侧栏的「引文失配」跟着正文走（与装饰同一套 findQuote）。
    setDocText(content);
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
      appearanceCompartment.of(editorAppearance()),
      highlightActiveLine(),
      typewriterCompartment.of(prefs.typewriter ? typewriterExtension() : []),
      dimCompartment.of(prefs.dimming ? dimmingExtension() : []),
      foreshadowCompartment.of([]),
      // 渲染层（工单 #31/#32）：callout 卡片＋内联图；`../附件/` 相对当前章
      // 文件解析，asset 授权随库根（项目在库内）已覆盖。
      editorRender({
        getResolveDir: () => {
          const path = currentRef.current?.path;
          return path ? dirName(path) : undefined;
        },
        onImageOpen: imageViewer.open,
      }),
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
      EditorView.domEventHandlers({ paste: handlePaste, contextmenu: handleContextMenu }),
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
    setDocText(content);
    dirtyRef.current = false;
    setDirty(false);
    applyForeshadowMarks();
  }

  // ---------- 读写 ----------

  async function rescan(): Promise<ChapterEntry[]> {
    const list = await invoke<ChapterEntry[]>("scan_chapters", { project: project.dir });
    setChapters(list);
    return list;
  }

  async function loadIntent(entry: ChapterEntry) {
    if (entry.ordinal === null) {
      setIntent(null);
      return;
    }
    try {
      setIntent(
        await invoke<ChapterIntent>("find_chapter_intent", {
          project: project.dir,
          ordinal: entry.ordinal,
        }),
      );
    } catch {
      // 规划读取是写作旁路；失败时照常可写，只显示自由写作提示。
      setIntent({ unit: null, bridge: null, warnings: [] });
    }
  }

  // ---------- 伏笔（工单 #6，docs/spec/伏笔系统.md） ----------

  async function loadForeshadows(): Promise<Foreshadow[]> {
    try {
      const list = await invoke<Foreshadow[]>("read_foreshadows", { project: project.dir });
      foreshadowsRef.current = list;
      setForeshadows(list);
      return list;
    } catch (e) {
      // 伏笔.yaml 损坏：显式提示，但不挡写作（伏笔只是旁路数据）。
      foreshadowsRef.current = [];
      setForeshadows([]);
      window.alert(`读取伏笔失败：${errMsg(e)}`);
      return [];
    }
  }

  /** 当前章的全部锚点（埋设＋回收），供装饰与侧栏共用。 */
  function chapterMarks(): ForeshadowMark[] {
    const ordinal = currentRef.current?.ordinal;
    if (ordinal === null || ordinal === undefined) return [];
    const marks: ForeshadowMark[] = [];
    for (const f of foreshadowsRef.current) {
      for (const a of f.planted) {
        if (a.chapter === ordinal) {
          marks.push({ name: f.name, state: f.state, quote: a.quote, recovered: false });
        }
      }
      for (const r of f.recovered) {
        if (r.chapter === ordinal) {
          marks.push({ name: f.name, state: f.state, quote: r.quote, recovered: true });
        }
      }
    }
    return marks;
  }

  /** 重建正文装饰（切章、伏笔增删、恢复历史版本后都要来一发）。 */
  function applyForeshadowMarks() {
    viewRef.current?.dispatch({
      effects: foreshadowCompartment.reconfigure(foreshadowExtension(chapterMarks())),
    });
  }

  /** 在正文里选中引文并滚到中间；找不到返回 false（失配）。 */
  function locateQuote(quote: string): boolean {
    const view = viewRef.current;
    if (!view) return false;
    const hit = findQuote(view.state.doc.toString(), quote);
    if (!hit) return false;
    view.dispatch({
      selection: { anchor: hit.from, head: hit.to },
      effects: EditorView.scrollIntoView(hit.from, { y: "center" }),
    });
    view.focus();
    return true;
  }

  /** 按行号＋第几次出现选中（发布前校对的命中跳回）；行或词对不上时
   *  退回全文找词（校对结果是扫盘时的快照，正文可能已经改过）。 */
  function locateAtLine(line: number, word: string, occurrence: number): boolean {
    const view = viewRef.current;
    if (!view) return false;
    const doc = view.state.doc;
    if (line < 1 || line > doc.lines) return locateQuote(word);
    const text = doc.line(line).text;
    let at = -1;
    let from = 0;
    for (let n = 0; n <= occurrence; n += 1) {
      at = text.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
    }
    if (at < 0) return locateQuote(word);
    const anchor = doc.line(line).from + at;
    view.dispatch({
      selection: { anchor, head: anchor + word.length },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
    return true;
  }

  /** 当前章的章序；未编号（文件名没有数字前缀）时提示并返回 null——
   *  伏笔锚点以章序数落盘，未编号章没法标。 */
  function requireOrdinal(): number | null {
    const ordinal = currentRef.current?.ordinal;
    if (ordinal === null || ordinal === undefined) {
      window.alert("这一章的文件名没有章号，先给它编号（重编号）再标伏笔。");
      return null;
    }
    return ordinal;
  }

  async function annotateForeshadow(name: string) {
    const ordinal = requireOrdinal();
    const view = viewRef.current;
    if (ordinal === null || !view || !annotate) return;
    setForeshadowBusy(true);
    try {
      const list = await invoke<Foreshadow[]>("annotate_foreshadow", {
        project: project.dir,
        name,
        chapter: ordinal,
        quote: annotate.quote,
      });
      foreshadowsRef.current = list;
      setForeshadows(list);
      setAnnotate(null);
      applyForeshadowMarks();
    } catch (e) {
      window.alert(`设为伏笔失败：${errMsg(e)}`);
    } finally {
      setForeshadowBusy(false);
    }
  }

  async function recoverForeshadow(name: string, kind: string, note: string) {
    const ordinal = requireOrdinal();
    if (ordinal === null || !collect) return;
    setForeshadowBusy(true);
    try {
      const list = await invoke<Foreshadow[]>("recover_foreshadow", {
        project: project.dir,
        name,
        chapter: ordinal,
        quote: collect.quote,
        kind,
        note: note.trim() || null,
      });
      foreshadowsRef.current = list;
      setForeshadows(list);
      setCollect(null);
      applyForeshadowMarks();
    } catch (e) {
      window.alert(`回收伏笔失败：${errMsg(e)}`);
    } finally {
      setForeshadowBusy(false);
    }
  }

  // ---------- 三线（工单 #7，docs/spec/期待感三线.md） ----------

  async function loadExpectations(): Promise<void> {
    try {
      setExpectations(await invoke<ExpectationBoard>("expectation_board", { project: project.dir }));
    } catch (e) {
      // 三线.yaml 损坏：显式提示，但不挡写作（三线只是旁路数据）。
      setExpectations({ maxChapter: 0, items: [] });
      window.alert(`读取期待线失败：${errMsg(e)}`);
    }
  }

  async function annotateExpectation(name: string, kind: string, horizon: string) {
    const ordinal = requireOrdinal();
    if (ordinal === null || !expAnnotate) return;
    setExpectationBusy(true);
    try {
      await invoke("annotate_expectation", {
        project: project.dir,
        name,
        chapter: ordinal,
        quote: expAnnotate.quote,
        kind,
        horizon,
      });
      setExpAnnotate(null);
      await loadExpectations();
    } catch (e) {
      window.alert(`记为期待线失败：${errMsg(e)}`);
    } finally {
      setExpectationBusy(false);
    }
  }

  async function fulfillExpectation(name: string, kind: string, note: string) {
    const ordinal = requireOrdinal();
    if (ordinal === null || !expFulfill) return;
    setExpectationBusy(true);
    try {
      await invoke("fulfill_expectation", {
        project: project.dir,
        name,
        chapter: ordinal,
        quote: expFulfill.quote,
        kind,
        note: note.trim() || null,
      });
      setExpFulfill(null);
      await loadExpectations();
    } catch (e) {
      window.alert(`兑现期待线失败：${errMsg(e)}`);
    } finally {
      setExpectationBusy(false);
    }
  }

  /** 右键菜单：有选区才出（设为伏笔／回收伏笔／记为期待感／记为目标／兑现期待线），
   *  不抢编辑器默认菜单。 */
  function handleContextMenu(event: MouseEvent, view: EditorView): boolean {
    const sel = view.state.selection.main;
    if (sel.empty) return false;
    const text = view.state.doc.sliceString(sel.from, sel.to).trim();
    if (!text) return false;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, text });
    return true;
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
      void loadIntent(entry);
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

  /** 保存当前章（指纹闸）：成功 true；冲突 false（横幅交人裁决）。
   *  quiet＝关窗兜底用：失败只记日志，不拿弹框拦关窗。 */
  async function saveNow(force: boolean, quiet = false): Promise<boolean> {
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
      // 保存往返窗口里又打过字的不算干净：留着脏标让下一轮自动保存接走。
      if (view.state.doc.toString() === content) {
        dirtyRef.current = false;
        setDirty(false);
      }
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
      if (quiet) {
        console.error("关窗兜底保存失败：", e);
      } else {
        window.alert(`保存失败：${errMsg(e)}`);
      }
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
      setIntent(null);
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

  // ---------- AI 命令（工单 #15、#45） ----------

  /** AI 陪看本章：材料只含正文与可用的本章意图，由作者显式发起，只出建议。
   *  读的是盘上正文——先把未保存的改动落盘，冲突没裁决就不跑。 */
  async function runChapterCompanion() {
    const entry = currentRef.current;
    const view = viewRef.current;
    if (!entry || entry.ordinal === null || !view) {
      window.alert("先打开一章再请 AI 陪看（章序按文件名前缀认，未编号章不参与）。");
      return;
    }
    // 固定作者点击这一刻的正文；保存往返期间即使继续输入，本次陪看也不会悄悄读旧盘面。
    const chapterContent = view.state.doc.toString();
    if (dirtyRef.current && !(await saveNow(false))) {
      window.alert("本章还有未落盘的修改（或保存冲突未裁决），先处理再请 AI 陪看。");
      return;
    }
    try {
      const text = await invoke<string>("build_ai_context", {
        kind: AI_CHAPTER_COMPANION,
        project: project.dir,
        chapter: entry.ordinal,
        subjects: null,
        chapterContent,
      });
      onAiCommand({ kind: AI_CHAPTER_COMPANION, bookName: project.title, text });
    } catch (e) {
      window.alert(`AI 陪看材料读取失败：${errMsg(e)}`);
    }
  }

  /** 润色：只把选中的那段正文交给 AI；采纳（替换选中）在面板里点。 */
  function runPolish() {
    const view = viewRef.current;
    const entry = currentRef.current;
    if (!view || !entry) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      window.alert("先在正文里选中要润色的那一段。");
      return;
    }
    const text = view.state.doc.sliceString(sel.from, sel.to);
    if (!text.trim()) {
      window.alert("选中的是空白，先选一段正文。");
      return;
    }
    // 带原始选区（含首尾空白）：AI 看到的与被替换的是同一段，不悄悄吞掉换行。
    onAiCommand({
      kind: "润色",
      bookName: project.title,
      text,
      note: chapterLabel(entry, prefix),
    });
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
      await loadForeshadows();
      await loadExpectations();
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
        (locate
          ? locate.path
            ? list.find((c) => c.path === locate.path)
            : list.find((c) => c.ordinal === locate.ordinal)
          : undefined) ??
        list.find((c) => c.path === remembered) ??
        numbered[numbered.length - 1] ??
        list[0];
      if (pick) await openChapter(pick);
      // 跳转落点：给行号按行定位（校对命中），否则全文找引文（伏笔/三线）。
      if (locate?.quote) {
        if (locate.line !== undefined) {
          if (locate.fingerprint && locate.fingerprint !== fingerprintRef.current) {
            window.alert("正文在校对后已经变化，请重新校对本章后再定位。");
          } else {
            locateAtLine(locate.line, locate.quote, locate.occurrence ?? 0);
          }
        } else {
          locateQuote(locate.quote);
        }
      }
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

  // 设置变化（主题/排版）→ 编辑器外观重配（工单 #24/#26）。
  useEditorAppearance(viewRef, appearanceCompartment);

  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  // 切出书写板块：立即落盘；切回来：焦点还给编辑器（板块常驻挂载，不卸载），
  // 并重读伏笔与三线（构思侧看板可能刚改过状态/删过条目）。
  useEffect(() => {
    if (active) {
      viewRef.current?.focus();
      void loadForeshadows().then(applyForeshadowMarks);
      void loadExpectations();
    } else if (dirtyRef.current) {
      void saveNow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // AI 面板的桥（工单 #15）：getDoc＝当前章全文（「携带当前文档」用），
  // replaceSelection＝采纳润色稿。替换走正常编辑路径：会标脏、自动保存、可 Ctrl+Z。
  useEffect(() => {
    registerBridge({
      getDoc: () => {
        const view = viewRef.current;
        const entry = currentRef.current;
        if (!view || !entry) return null;
        return {
          bookName: project.title,
          label: chapterLabel(entry, prefix),
          path: entry.path,
          content: view.state.doc.toString(),
        };
      },
      replaceSelection: (text: string) => {
        const view = viewRef.current;
        if (!view) return false;
        const sel = view.state.selection.main;
        if (sel.empty) return false;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
          scrollIntoView: true,
        });
        return true;
      },
    });
    return () => registerBridge(null);
    // project 在生命周期内不变（父组件按项目重挂载）；prefix 影响文档抬头，变了重挂桥。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix]);

  // 关窗兜底（工单 #28）：应用级关窗事件里静默落盘——不弹框、不裁决冲突
  // （冲突时盘上为准，ADR 0004）。saveNow 读 ref，首渲染实例即可。
  useEffect(
    () => registerFlushSaver(async () => {
      await saveNow(false, true);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 右键菜单：点别处或 Esc 关掉（菜单内的 mousedown 不算「别处」）。
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const chapterOrdinal = current?.ordinal ?? null;
  const chapterPlanted = foreshadows.flatMap((f) =>
    f.planted.filter((a) => a.chapter === chapterOrdinal).map((a) => ({ f, a })),
  );
  const chapterRecovered = foreshadows.flatMap((f) =>
    f.recovered.filter((r) => r.chapter === chapterOrdinal).map((r) => ({ f, r })),
  );
  // 三线：本章埋设/兑现＋未兑现的线按「未推进章数 ÷ 档位阈值」的紧迫度降序。
  const chapterPlantedExp = expectations.items.flatMap((e) =>
    e.planted.filter((a) => a.chapter === chapterOrdinal).map((a) => ({ e, a })),
  );
  const chapterFulfilledExp = expectations.items.flatMap((e) =>
    e.fulfilled.filter((p) => p.chapter === chapterOrdinal).map((p) => ({ e, p })),
  );
  const openLines = expectations.items
    .filter((e) => e.unadvancedChapters !== null)
    .map((e) => ({
      e,
      unadvanced: e.unadvancedChapters ?? 0,
      urgency: (e.unadvancedChapters ?? 0) / expectationOverdueChapters(e.horizon),
    }))
    .sort((a, b) => b.urgency - a.urgency);

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
          <button className="btn with-icon" onClick={onBack}>
            <Icon as={ArrowLeft} size={ICON_SIZE_DENSE} />
            项目列表
          </button>
        </header>
        <div className="error-box">{loadError}</div>
      </div>
    );
  }

  return (
    <div className={`writing-page ${immersive ? "immersive" : ""}`}>
      <header className="editor-header">
        <button className="btn with-icon" onClick={() => void handleBack()}>
          <Icon as={ArrowLeft} size={ICON_SIZE_DENSE} />
          项目列表
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
              <button
                className="btn"
                disabled={!current}
                onClick={() => void saveNow(false).then((saved) => saved && setProofOpen(true))}
              >
                校对本章
              </button>
              <button className="btn" onClick={() => setListOpen((v) => !v)}>
                {listOpen ? "收起列表" : "章节列表"}
              </button>
              <button className="btn" onClick={() => setSidebarOpen((v) => !v)}>
                {sidebarOpen ? "收起侧栏" : "侧栏"}
              </button>
              <button
                className="btn"
                disabled={!ready || !current || counts.sel === 0}
                title="AI 润色选中段落：回复后点「替换选中正文」才落盘（可 Ctrl+Z 撤销）"
                onClick={runPolish}
              >
                AI 润色
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

      {!immersive && <TypographyToolbar />}

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
            <div className="sidebar-section-head">
              <h2 className="sidebar-title">本章意图</h2>
              <button
                className="btn primary small"
                disabled={!ready || !current}
                title="由你主动发起；AI 只对照正文与本章意图给建议，不评分、不改正文"
                onClick={() => void runChapterCompanion()}
              >
                AI 陪看本章
              </button>
            </div>
            {unit && intent?.bridge ? (
              <details className="chapter-intent-card" open>
                <summary>
                  {unit.name} <span>→</span> {intent.bridge.name}
                </summary>
                <div className="chapter-intent-content">
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
                {unit.emotionGoal && (
                  <p className="unit-core">
                    <span className="field-label">单元情绪目标</span>
                    {unit.emotionGoal}
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
                {([
                  ["情绪曲线", intent.bridge.emotionCurve],
                  ["关键转折", intent.bridge.keyTurn],
                  ["期待钩子", intent.bridge.expectationHook],
                  ["章节拍安排", intent.bridge.beatPlan],
                ] as const).map(([label, value]) =>
                  value ? (
                    <p className="intent-field" key={label}>
                      <span className="field-label">{label}</span>
                      {value}
                    </p>
                  ) : null,
                )}
                </div>
              </details>
            ) : (
              <p className="hint">
                本章还没有设定写作意图，可以先自由写；形成明确剧情后，再整理为桥段草案。
              </p>
            )}
            {unit && intent?.bridge && intent.warnings.length ? (
              <ul className="intent-warnings">
                {intent.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}

            {(chapterPlanted.length > 0 || chapterRecovered.length > 0) && (
              <>
                <h2 className="sidebar-title">本章伏笔</h2>
                <ul className="foreshadow-side-list">
                  {chapterPlanted.map(({ f, a }, i) => (
                    <li key={`p${i}`}>
                      <button
                        className="link-btn"
                        title="选中正文里的引文"
                        onClick={() => locateQuote(a.quote)}
                      >
                        {f.name}
                      </button>
                      <span className="card-cat">{f.state}</span>
                      {a.quote && <span className="foreshadow-quote">「{a.quote}」</span>}
                      {findQuote(docText, a.quote) === null && (
                        <span className="card-cat danger">引文失配</span>
                      )}
                    </li>
                  ))}
                  {chapterRecovered.map(({ f, r }, i) => (
                    <li key={`r${i}`}>
                      <button
                        className="link-btn"
                        title="选中正文里的引文"
                        onClick={() => locateQuote(r.quote)}
                      >
                        {f.name}
                      </button>
                      <span className="card-cat">回收 · {r.kind}</span>
                      {r.quote && <span className="foreshadow-quote">「{r.quote}」</span>}
                      {findQuote(docText, r.quote) === null && (
                        <span className="card-cat danger">引文失配</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {(chapterPlantedExp.length > 0 || chapterFulfilledExp.length > 0) && (
              <>
                <h2 className="sidebar-title">本章期待线</h2>
                <ul className="foreshadow-side-list">
                  {chapterPlantedExp.map(({ e, a }, i) => (
                    <li key={`ep${i}`}>
                      <button
                        className="link-btn"
                        title="选中正文里的引文"
                        onClick={() => locateQuote(a.quote)}
                      >
                        {e.name}
                      </button>
                      <span className="card-cat">
                        {expectationKindLabel(e.kind)} · {e.horizon}
                      </span>
                      {a.quote && <span className="foreshadow-quote">「{a.quote}」</span>}
                      {findQuote(docText, a.quote) === null && (
                        <span className="card-cat danger">引文失配</span>
                      )}
                    </li>
                  ))}
                  {chapterFulfilledExp.map(({ e, p }, i) => (
                    <li key={`ef${i}`}>
                      <button
                        className="link-btn"
                        title="选中正文里的引文"
                        onClick={() => locateQuote(p.quote)}
                      >
                        {e.name}
                      </button>
                      <span className="card-cat">
                        兑现 · {p.kind} · {expectationKindLabel(e.kind)}
                      </span>
                      {p.quote && <span className="foreshadow-quote">「{p.quote}」</span>}
                      {p.note && <span className="foreshadow-note">{p.note}</span>}
                      {findQuote(docText, p.quote) === null && (
                        <span className="card-cat danger">引文失配</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {openLines.length > 0 && (
              <>
                <h2 className="sidebar-title">还欠着的线</h2>
                <ul className="foreshadow-side-list">
                  {openLines.slice(0, 5).map(({ e, unadvanced }) => (
                    <li key={e.name}>
                      <span>{e.name}</span>
                      <span className="card-cat">
                        {expectationKindLabel(e.kind)} · {e.horizon}
                      </span>
                      {e.overdue ? (
                        <span className="card-cat danger">超期 {unadvanced} 章</span>
                      ) : (
                        <span className="card-cat">已 {unadvanced} 章未推进</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="hint">共 {openLines.length} 条未兑现，见「构思 → 期待感/目标」。</p>
              </>
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

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="context-item"
            onClick={() => {
              setMenu(null);
              if (requireOrdinal() === null) return;
              setAnnotate({ quote: menu.text });
            }}
          >
            设为伏笔
          </button>
          <button
            className="context-item"
            onClick={() => {
              setMenu(null);
              if (requireOrdinal() === null) return;
              setCollect({ quote: menu.text });
            }}
          >
            回收伏笔
          </button>
          {EXPECTATION_KINDS.map((k) => (
            <button
              key={k}
              className="context-item"
              onClick={() => {
                setMenu(null);
                if (requireOrdinal() === null) return;
                setExpAnnotate({ quote: menu.text, kind: k });
              }}
            >
              记为{expectationKindLabel(k)}
            </button>
          ))}
          <button
            className="context-item"
            onClick={() => {
              setMenu(null);
              if (requireOrdinal() === null) return;
              setExpFulfill({ quote: menu.text });
            }}
          >
            兑现期待线
          </button>
        </div>
      )}

      {annotate && (
        <ForeshadowNameDialog
          title="设为伏笔"
          label="伏笔名"
          hint="选中这段文字会成为这条伏笔的锚点；同名伏笔会自动追加一条埋设，不新建。"
          initial={annotate.quote.slice(0, 12)}
          busy={foreshadowBusy}
          onCancel={() => setAnnotate(null)}
          onSubmit={(name) => void annotateForeshadow(name)}
        />
      )}

      {collect && (
        <ForeshadowCollectDialog
          quote={collect.quote}
          foreshadows={foreshadows}
          busy={foreshadowBusy}
          onCancel={() => setCollect(null)}
          onSubmit={(name, kind, note) => void recoverForeshadow(name, kind, note)}
        />
      )}

      {expAnnotate && (
        <ExpectationFormDialog
          title={`记为${expectationKindLabel(expAnnotate.kind)}`}
          hint="选中这段文字会成为这条线的锚点；同名线会追加一条埋设（档位以已有为准），不新建。"
          initial={expAnnotate.quote.slice(0, 12)}
          fixedKind={expAnnotate.kind}
          initialHorizon={EXPECTATION_HORIZON_MID}
          busy={expectationBusy}
          onCancel={() => setExpAnnotate(null)}
          onSubmit={(name, kind, horizon) => void annotateExpectation(name, kind, horizon)}
        />
      )}

      {expFulfill && (
        <ExpectationFulfillDialog
          quote={expFulfill.quote}
          expectations={expectations.items}
          busy={expectationBusy}
          onCancel={() => setExpFulfill(null)}
          onSubmit={(name, kind, note) => void fulfillExpectation(name, kind, note)}
        />
      )}

      {proofOpen && current && (
        <ExportDialog
          projectDir={project.dir}
          projectTitle={project.title}
          chapterCount={chapters.filter((chapter) => chapter.ordinal !== null).length}
          libraryPath={libraryPath}
          initialTab="proof"
          initialChapter={current.ordinal}
          initialPath={current.path}
          nonModal
          onClose={() => setProofOpen(false)}
          onJump={(issue: ProofIssue) => {
            if (dirtyRef.current || issue.fingerprint !== fingerprintRef.current) {
              window.alert("正文在校对后已经变化，请重新校对本章后再定位。");
              return;
            }
            setProofOpen(false);
            locateAtLine(issue.line, issue.word, issue.occurrence);
          }}
        />
      )}

      {imageViewer.node}
    </div>
  );
}
