import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BookEntry,
  ChapterEntry,
  IdeationOverview,
  IdeationOverviewItem,
  InspirationCard,
  PendingLine,
  ProjectEntry,
} from "./types";
import { STATUS_DONE } from "./types";
import { errMsg, formatCount } from "./util";
import { getCurrentProjectDir } from "./currentProject";
import { Icon, ICON_SIZE_DENSE, PenLine } from "./icons";
import type { ProjectTab } from "./ProjectPage";

/** 待办标题最多摆 3 条（验收口径 1～3 条真实待办），余量如实报数。 */
const MAX_TITLES = 3;

/** 看板归属 → 跳转页签＋徽标配色，一处定死（期待/目标同色＝同属三线）。 */
const BOARD_META: Record<PendingLine["board"], { tab: ProjectTab; badge: string }> = {
  伏笔: { tab: "伏笔", badge: "foreshadow" },
  期待: { tab: "期待感", badge: "thread" },
  目标: { tab: "目标", badge: "thread" },
};

export type RailSection = "拆书" | "灵感库" | "构思" | "书写";

type RailTask =
  | { kind: "board"; key: string; title: string; label: string; detail: string; line: PendingLine }
  | { kind: "ideation"; key: string; title: string; label: string; detail: string; item: IdeationOverviewItem }
  | { kind: "inspiration"; key: string; title: string; label: string; detail: string; card: InspirationCard }
  | { kind: "book"; key: string; title: string; label: string; detail: string; book: BookEntry }
  | { kind: "chapter"; key: string; title: string; label: string; detail: string; chapter: ChapterEntry };

const TASK_HEADINGS: Record<RailSection, string> = {
  拆书: "继续拆书",
  灵感库: "待整理灵感",
  构思: "待处理构思",
  书写: "待续写章节",
};

const EMPTY_TASK_HINTS: Record<RailSection, string> = {
  拆书: "还没有上次打开的拆书稿。",
  灵感库: "没有待打磨或未分类的灵感。",
  构思: "没有超期线索或待打磨的构思便笺。",
  书写: "没有待续写的草稿章节。",
};

interface RailProjectPanelProps {
  libraryPath: string | null;
  section: RailSection;
  onChooseFolder: () => void;
  /** 继续工作：切到书写板块，回到当前项目与上次章节。 */
  onResume: (project: ProjectEntry) => void;
  /** 构思条目点开：跳到对应页签，并在适用时聚焦人物。 */
  onOpenBoard: (project: ProjectEntry, tab: ProjectTab, focus?: string) => void;
  onOpenBook: (book: BookEntry) => void;
  onOpenInspiration: (card: InspirationCard) => void;
  onOpenChapter: (project: ProjectEntry, chapter: ChapterEntry) => void;
  /** 没有当前项目时的引导：去构思新建。 */
  onGoIdeation: () => void;
}

/** 窄轨「当前项目」飞出面板（工单 #56 / T01）：B 案头窄轨上挂的 A 书页信息面。
 *  只读现扫：项目概要、继续工作和随当前板块变化的真实待处理标题，不造进度。 */
export default function RailProjectPanel({
  libraryPath,
  section,
  onChooseFolder,
  onResume,
  onOpenBoard,
  onOpenBook,
  onOpenInspiration,
  onOpenChapter,
  onGoIdeation,
}: RailProjectPanelProps) {
  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [tasks, setTasks] = useState<RailTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 键盘可达：面板展开即把焦点收进来（Esc 关、Tab 在面板内走）。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 面板每次展开都是新挂载，现扫一次即够——关了再开重扫，数据始终新鲜。
  useEffect(() => {
    setProject(null);
    setTasks(libraryPath ? null : []);
    setError(null);
    if (!libraryPath) return;
    let cancelled = false;
    void (async () => {
      let current: ProjectEntry | undefined;
      try {
        const list = await invoke<ProjectEntry[]>("scan_projects", { root: libraryPath });
        if (cancelled) return;
        const dir = getCurrentProjectDir();
        current = dir ? list.find((p) => p.dir === dir) : undefined;
        setProject(current ?? null);
      } catch (e) {
        if (!cancelled && (section === "构思" || section === "书写")) {
          setError(`项目扫描失败：${errMsg(e)}`);
        }
      }

      try {
        let next: RailTask[] = [];
        if (section === "拆书") {
          const books = await invoke<BookEntry[]>("scan_library", { root: libraryPath });
          const lastPath = localStorage.getItem("gongbi.lastBook");
          const book = books.find((entry) => entry.primaryMd === lastPath);
          if (book) {
            next = [{
              kind: "book",
              key: book.primaryMd,
              title: book.meta.title ?? book.name,
              label: "上次拆书稿",
              detail: `拆书 ${formatCount(book.chapterCount)} 章 · ${formatCount(book.wordCount)} 字`,
              book,
            }];
          }
        } else if (section === "灵感库") {
          const cards = await invoke<InspirationCard[]>("scan_inspirations", { root: libraryPath });
          const polishing = cards.filter((card) => card.pending).sort((a, b) => b.mtime - a.mtime);
          const unclassified = cards
            .filter((card) => card.category === "未分类" && !card.pending)
            .sort((a, b) => b.mtime - a.mtime);
          next = [...polishing, ...unclassified].slice(0, MAX_TITLES).map((card) => ({
            kind: "inspiration",
            key: card.path,
            title: card.title,
            label: card.pending ? "待打磨" : "未分类",
            detail: card.category,
            card,
          }));
        } else if (section === "构思" && current) {
          const [lines, overview] = await Promise.all([
            invoke<PendingLine[]>("project_pending", { project: current.dir }),
            invoke<IdeationOverview>("read_ideation_overview", { project: current.dir }),
          ]);
          const boardTasks: RailTask[] = lines.map((line) => ({
            kind: "board" as const,
            key: `${line.board}:${line.name}`,
            title: line.name,
            label: line.board,
            detail: `超 ${line.lag} 章`,
            line,
          }));
          const noteTasks: RailTask[] = overview.pending.map((item) => ({
            kind: "ideation" as const,
            key: `${item.tab}:${item.name}`,
            title: item.name,
            label: item.summary ?? "待处理",
            detail: item.tab,
            item,
          }));
          next = [...boardTasks, ...noteTasks].slice(0, MAX_TITLES);
        } else if (section === "书写" && current) {
          const chapters = await invoke<ChapterEntry[]>("scan_chapters", { project: current.dir });
          next = chapters
            .filter((chapter) => chapter.status !== STATUS_DONE)
            .sort((left, right) => (right.ordinal ?? -1) - (left.ordinal ?? -1))
            .slice(0, MAX_TITLES)
            .map((chapter) => ({
              kind: "chapter",
              key: chapter.path,
              title: chapter.title,
              label: chapter.ordinal === null ? "草稿" : `第 ${chapter.ordinal} 章`,
              detail: `${chapter.status} · ${formatCount(chapter.wordCount)} 字`,
              chapter,
            }));
        }
        if (!cancelled) setTasks(next);
      } catch (e) {
        // 上下文里的真实待办读取失败时如实显示；不伪造待办标题。
        if (!cancelled) {
          setTasks([]);
          setError((currentError) => currentError ?? `待办读取失败：${errMsg(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryPath, section]);

  function openTask(task: RailTask) {
    if (task.kind === "board" && project) {
      const meta = (BOARD_META as Partial<Record<string, (typeof BOARD_META)[PendingLine["board"]]>>)[task.line.board];
      if (meta) onOpenBoard(project, meta.tab);
    } else if (task.kind === "ideation" && project) {
      onOpenBoard(project, task.item.tab as ProjectTab);
    } else if (task.kind === "inspiration") {
      onOpenInspiration(task.card);
    } else if (task.kind === "book") {
      onOpenBook(task.book);
    } else if (task.kind === "chapter" && project) {
      onOpenChapter(project, task.chapter);
    }
  }

  return (
    <div className="rail-flyout" role="dialog" aria-label="当前项目" tabIndex={-1} ref={dialogRef}>
      <h2 className="rail-flyout-title">当前项目</h2>

      {!libraryPath && (
        <>
          <p className="rail-flyout-hint">还没有打开库文件夹。</p>
          <button className="btn primary" onClick={onChooseFolder}>
            打开库文件夹
          </button>
        </>
      )}

      {libraryPath && !project && !error && (
        <>
          <p className="rail-flyout-hint">还没有当前项目。</p>
          <p className="rail-flyout-hint sub">在构思或书写板块打开一个项目，这里会记住它。</p>
          <button className="btn" onClick={onGoIdeation}>
            去构思看看
          </button>
        </>
      )}

      {error && <div className="error-box">{error}</div>}

      {project && (
        <>
          <div className="rail-project-head">
            <span className="rail-project-name" title={project.title}>
              {project.title}
            </span>
            <span className="rail-project-meta">
              {project.chapterCount > 0
                ? `正文 ${formatCount(project.chapterCount)} 章 · ${formatCount(project.wordCount)} 字`
                : "还没有正文"}
            </span>
          </div>

          <button className="btn primary rail-resume" onClick={() => onResume(project)}>
            <Icon as={PenLine} size={ICON_SIZE_DENSE} />
            继续工作
          </button>
          <p className="rail-flyout-hint sub">回到这本书上次的章节与进度。</p>
        </>
      )}

      {libraryPath && (
        <div className="rail-pending">
          <h3 className="rail-pending-head">{TASK_HEADINGS[section]}</h3>
          {tasks === null && !error && <p className="rail-flyout-hint">正在现扫……</p>}
          {tasks !== null && tasks.length === 0 && (
            <p className="rail-flyout-hint">{EMPTY_TASK_HINTS[section]}</p>
          )}
          {tasks?.map((task) => {
            const meta = task.kind === "board" ? BOARD_META[task.line.board] : null;
            return (
              <button
                key={task.key}
                className="rail-pending-item"
                title={`${task.label}「${task.title}」 · ${task.detail}`}
                onClick={() => openTask(task)}
              >
                <span className={`rail-pending-badge ${meta?.badge ?? (task.kind === "board" ? "unknown" : "context")}`}>
                  {task.label}
                </span>
                <span className="rail-pending-name">{task.title}</span>
                <span className="rail-pending-lag">{task.detail}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="rail-flyout-foot">拆书积累 · 灵感沉淀 · 构思写作</div>
    </div>
  );
}
