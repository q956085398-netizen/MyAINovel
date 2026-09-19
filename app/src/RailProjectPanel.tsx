import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PendingLine, ProjectEntry } from "./types";
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

interface RailProjectPanelProps {
  libraryPath: string | null;
  onChooseFolder: () => void;
  /** 继续工作：切到书写板块，回到当前项目与上次章节。 */
  onResume: (project: ProjectEntry) => void;
  /** 待办标题点开：跳到构思对应看板（伏笔/期待感/目标）。 */
  onOpenBoard: (project: ProjectEntry, tab: ProjectTab) => void;
  /** 没有当前项目时的引导：去构思新建。 */
  onGoIdeation: () => void;
}

/** 窄轨「当前项目」飞出面板（工单 #56 / T01）：B 案头窄轨上挂的 A 书页信息面。
 *  只读现扫：项目概要＋继续工作＋真实待办（超期伏笔/期待线），不造进度。 */
export default function RailProjectPanel({
  libraryPath,
  onChooseFolder,
  onResume,
  onOpenBoard,
  onGoIdeation,
}: RailProjectPanelProps) {
  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [pending, setPending] = useState<PendingLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 键盘可达：面板展开即把焦点收进来（Esc 关、Tab 在面板内走）。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 面板每次展开都是新挂载，现扫一次即够——关了再开重扫，数据始终新鲜。
  useEffect(() => {
    if (!libraryPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<ProjectEntry[]>("scan_projects", { root: libraryPath });
        if (cancelled) return;
        const dir = getCurrentProjectDir();
        const hit = dir ? list.find((p) => p.dir === dir) : undefined;
        if (!hit) return;
        setProject(hit);
        try {
          const lines = await invoke<PendingLine[]>("project_pending", { project: hit.dir });
          if (!cancelled) setPending(lines);
        } catch (e) {
          // 线表坏了不吞错误：面板如实报，去构思看板处理。
          if (!cancelled) setError(`待办读取失败：${errMsg(e)}`);
        }
      } catch (e) {
        if (!cancelled) setError(`项目扫描失败：${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryPath]);

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

          <div className="rail-pending">
            <h3 className="rail-pending-head">待办</h3>
            {pending === null && !error && <p className="rail-flyout-hint">正在现扫……</p>}
            {pending !== null && pending.length === 0 && (
              <p className="rail-flyout-hint">没有超期的伏笔与期待线。</p>
            )}
            {pending !== null &&
              pending.slice(0, MAX_TITLES).map((line) => (
                <button
                  key={`${line.board}:${line.name}`}
                  className="rail-pending-item"
                  title={`${line.board}「${line.name}」已 ${line.lag} 章未推进，去构思看板处理`}
                  onClick={() => onOpenBoard(project, BOARD_META[line.board].tab)}
                >
                  <span className={`rail-pending-badge ${BOARD_META[line.board].badge}`}>
                    {line.board}
                  </span>
                  <span className="rail-pending-name">{line.name}</span>
                  <span className="rail-pending-lag">超 {line.lag} 章</span>
                </button>
              ))}
            {pending !== null && pending.length > MAX_TITLES && (
              <p className="rail-flyout-hint sub">……还有 {pending.length - MAX_TITLES} 条。</p>
            )}
          </div>
        </>
      )}

      <div className="rail-flyout-foot">拆书积累 · 灵感沉淀 · 构思写作</div>
    </div>
  );
}
