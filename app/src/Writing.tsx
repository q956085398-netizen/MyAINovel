import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiSeed, ProofIssue, ProjectEntry, WritingBridge, WritingLocate } from "./types";
import { errMsg, formatCount } from "./util";
import { useDisplayMode } from "./displayMode";
import DisplayToggle from "./DisplayToggle";
import CoverArt, { pickAndSetCover } from "./CoverArt";
import WritingPage from "./WritingPage";
import { ExportDialog } from "./ExportDialog";
import { setCurrentProjectDir } from "./currentProject";

/** 记住上次打开的项目：码字工具应「打开即回到那本书」。 */
const LAST_PROJECT_KEY = "gongbi.writing.project";

function summary(p: ProjectEntry): string {
  const parts = [
    p.chapterCount > 0 && `正文 ${formatCount(p.chapterCount)} 章`,
    p.wordCount > 0 && `${formatCount(p.wordCount)} 字`,
    p.unitCount > 0 && `单元 ${p.unitCount}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "还没有正文";
}

interface WritingProps {
  libraryPath: string | null;
  /** 书写板块是否在前台（切走时写作页立即落盘）。 */
  active: boolean;
  onChooseFolder: () => void;
  /** 新建空库：选空文件夹即设为当前库（工单 #21）。 */
  onCreateLibrary: () => void;
  /** 跳转请求：locate 带章序与引文（伏笔看板）；locate 空＝「继续工作」，
   *  写作页自己回到上次章节。消费后清空。 */
  jump: { projectDir: string; locate: WritingLocate | null } | null;
  onJumpConsumed: () => void;
  /** 板块 AI 命令（AI 陪看本章/润色）：种子交给 AI 面板。 */
  onAiCommand: (seed: AiSeed) => void;
  /** 写作页向 AI 面板注册回写桥（采纳润色＝替换选中）。 */
  registerBridge: (bridge: WritingBridge | null) => void;
  /** 是否停在正文上（工单 #56 / T01）：进入正文后外壳窄轨退场。 */
  onManuscriptChange?: (active: boolean) => void;
}

/** 书写板块（工单 #5，docs/spec/书写编辑器.md）：日常码字工具。
 *  项目与构思共用「项目/」布局，这里只写 正文/。 */
export default function Writing({
  libraryPath,
  active,
  onChooseFolder,
  onCreateLibrary,
  jump,
  onJumpConsumed,
  onAiCommand,
  registerBridge,
  onManuscriptChange,
}: WritingProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{
    project: ProjectEntry;
    /** 重挂载序号：跳转同一个项目也要重开（locate 只在挂载时生效）。 */
    seq: number;
    locate: WritingLocate | null;
  } | null>(null);
  /** 导出与发布对话框的目标项目（工单 #14；入口在项目列表，不进写作页）。 */
  const [exportFor, setExportFor] = useState<ProjectEntry | null>(null);
  /** 只在本板块首次扫盘时自动回到上次的项目。 */
  const autoOpenRef = useRef(true);
  // 展示模式（工单 #22）：与构思板块共用项目列表档位偏好。
  const [display, setDisplay] = useDisplayMode("projects");

  /** 记住打开的项目：板块内恢复键＋外壳「当前项目」面板共用。 */
  const remember = useCallback((project: ProjectEntry) => {
    localStorage.setItem(LAST_PROJECT_KEY, project.dir);
    setCurrentProjectDir(project.dir);
  }, []);

  const scan = useCallback(async (root: string) => {
    setScanning(true);
    setError(null);
    try {
      const list = await invoke<ProjectEntry[]>("scan_projects", { root });
      setProjects(list);
      if (autoOpenRef.current) {
        autoOpenRef.current = false;
        const last = localStorage.getItem(LAST_PROJECT_KEY);
        const pick = list.find((p) => p.dir === last);
        if (pick) {
          remember(pick);
          setOpen({ project: pick, seq: 0, locate: null });
        }
      }
    } catch (e) {
      setProjects([]);
      setError(`扫描失败：${errMsg(e)}`);
    } finally {
      setScanning(false);
    }
  }, [remember]);

  useEffect(() => {
    if (libraryPath) void scan(libraryPath);
  }, [libraryPath, scan]);

  // 正文在不在场（工单 #56 / T01）：写作页按「当前章」上报；
  // 回到项目列表（open 清空）时由这里补一声 false（写作页已卸载）。
  useEffect(() => {
    if (!open) onManuscriptChange?.(false);
  }, [open, onManuscriptChange]);

  // 跳转请求：现扫一次拿到最新项目快照，按序打开（locate 空＝回上次章节）。
  useEffect(() => {
    if (!jump || !libraryPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<ProjectEntry[]>("scan_projects", { root: libraryPath });
        if (cancelled) return;
        setProjects(list);
        const project = list.find((p) => p.dir === jump.projectDir);
        if (project) {
          remember(project);
          setOpen((cur) => ({
            project,
            seq: (cur?.seq ?? 0) + 1,
            locate: jump.locate,
          }));
        } else {
          window.alert("没找到这个项目（可能已被移动或删除）。");
        }
      } catch (e) {
        if (!cancelled) window.alert(`打开项目失败：${errMsg(e)}`);
      } finally {
        if (!cancelled) onJumpConsumed();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  /** 打开项目（locate 非空时顺带定位到某章某处）。 */
  function openAt(project: ProjectEntry, locate: WritingLocate | null) {
    remember(project);
    setOpen((cur) => ({ project, seq: (cur?.seq ?? 0) + 1, locate }));
  }

  /** 校对命中跳回：关掉对话框，打开该章并选中命中词（按行号定位）。 */
  function jumpFromProofread(project: ProjectEntry, issue: ProofIssue) {
    setExportFor(null);
    openAt(project, {
      ordinal: issue.ordinal,
      path: issue.path,
      quote: issue.word,
      line: issue.line,
      occurrence: issue.occurrence,
      fingerprint: issue.fingerprint,
    });
  }

  if (open) {
    return (
      <WritingPage
        key={`${open.project.dir}#${open.seq}`}
        project={open.project}
        libraryPath={libraryPath}
        active={active}
        locate={open.locate}
        onAiCommand={onAiCommand}
        registerBridge={registerBridge}
        onChapterActive={onManuscriptChange}
        onBack={() => {
          setOpen(null);
          if (libraryPath) void scan(libraryPath);
        }}
        onChanged={() => {
          if (libraryPath) void scan(libraryPath);
        }}
      />
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>书写</h1>
          {libraryPath && (
            <p className="library-path" title={libraryPath}>
              {libraryPath}
            </p>
          )}
        </div>
        <div className="page-actions">
          {libraryPath ? (
            <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
              刷新
            </button>
          ) : (
            <button className="btn primary" onClick={onChooseFolder}>
              打开库文件夹
            </button>
          )}
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {!libraryPath && (
        <div className="empty-state">
          <p>还没有打开库文件夹。</p>
          <p className="hint">
            正文存在构思项目的「正文/」里，一章一个文件；一本书一个项目。
            <br />
            可以直接用现有的拆书库文件夹（拆书与书写互不干扰）。
          </p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={onChooseFolder}>
              打开库文件夹
            </button>
            <button className="btn" onClick={onCreateLibrary}>
              新建空库
            </button>
          </div>
        </div>
      )}

      {libraryPath && scanning && <div className="empty-state">正在扫描……</div>}

      {libraryPath && !scanning && !error && projects.length === 0 && (
        <div className="empty-state">
          <p>还没有项目。</p>
          <p className="hint">
            先在「构思」板块新建一个项目（一本书），书写板块会在它的 正文/ 里放章节。
          </p>
        </div>
      )}

      {projects.length > 0 && (
        <>
          <div className="list-bar">
            <p className="stats">共 {formatCount(projects.length)} 个项目</p>
            <DisplayToggle mode={display} onChange={setDisplay} />
          </div>
          {display === "grid" ? (
            <div className="cover-grid">
              {projects.map((p) => (
                <div
                  key={p.dir}
                  className="cover-card"
                  title="开始写"
                  onClick={() => openAt(p, null)}
                >
                  <CoverArt
                    name={p.title}
                    cover={p.cover}
                    onSetCover={() =>
                      void pickAndSetCover(p.coverDir, () => {
                        if (libraryPath) void scan(libraryPath);
                      })
                    }
                  />
                  <button
                    className="btn small cover-action"
                    title="导出正文 / 发布前校对"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExportFor(p);
                    }}
                  >
                    导出/发布
                  </button>
                  <div className="cover-name" title={p.title}>
                    {p.title}
                  </div>
                  <div className="cover-stats">
                    单元 {p.unitCount} · 矛盾 {p.contradictionCount} ·{" "}
                    {formatCount(p.wordCount)} 字
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card-list">
              {projects.map((p) => (
                <div key={p.dir} className="card-item">
                  <div className="card-title-row">
                    <button className="card-title" title="开始写" onClick={() => openAt(p, null)}>
                      {p.title}
                    </button>
                    <button
                      className="btn small"
                      title="导出正文 / 发布前校对"
                      onClick={() => setExportFor(p)}
                    >
                      导出/发布
                    </button>
                  </div>
                  <p className="card-meta">
                    <span className="card-source">{summary(p)}</span>
                  </p>
                  <p className="card-preview" title={p.dir}>
                    {p.dir}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {exportFor && (
        <ExportDialog
          key={exportFor.dir}
          projectDir={exportFor.dir}
          projectTitle={exportFor.title}
          chapterCount={exportFor.chapterCount}
          libraryPath={libraryPath}
          onClose={() => setExportFor(null)}
          onJump={(issue) => jumpFromProofread(exportFor, issue)}
        />
      )}
    </div>
  );
}
