import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiSeed, ProjectEntry } from "./types";
import { errMsg, formatCount } from "./util";
import { useDisplayMode } from "./displayMode";
import DisplayToggle from "./DisplayToggle";
import CoverArt, { pickAndSetCover } from "./CoverArt";
import ProjectPage, { type ProjectTab } from "./ProjectPage";

function summary(p: ProjectEntry): string {
  const parts = [
    p.unitCount > 0 && `单元 ${p.unitCount}`,
    p.contradictionCount > 0 && `矛盾 ${p.contradictionCount}`,
    p.characterCount > 0 && `人物 ${p.characterCount}`,
    p.worldviewCount > 0 && `词条 ${p.worldviewCount}`,
    p.openingCount > 0 && `开头 ${p.openingCount}`,
    p.chapterCount > 0 && `正文 ${p.chapterCount} 章`,
    p.wordCount > 0 && `${formatCount(p.wordCount)} 字`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "还是空的";
}

interface IdeationProps {
  libraryPath: string | null;
  onChooseFolder: () => void;
  /** 新建空库：选空文件夹即设为当前库（工单 #21）。 */
  onCreateLibrary: () => void;
  /** 从灵感库跳来：打开该项目（可落到某个页签／某个人物），打开后清空。
   *  带的是跳转方刚扫到的项目快照，不受本板块列表新鲜度影响。 */
  jump: { project: ProjectEntry; tab?: ProjectTab; focus?: string } | null;
  onJumpConsumed: () => void;
  /** 伏笔看板点章：跳到书写板块打开该章。 */
  onOpenChapter: (projectDir: string, ordinal: number, quote: string) => void;
  /** 板块 AI 命令（排布体检/矛盾梳理）：种子交给 AI 面板。 */
  onAiCommand: (seed: AiSeed) => void;
}

/** 构思板块：库根「项目/」下一书一文件夹（工单 #4）。
 *  拆书与构思互不相认，只经「词表.yaml ＋ 灵感库」通行。 */
export default function Ideation({
  libraryPath,
  onChooseFolder,
  onCreateLibrary,
  jump,
  onJumpConsumed,
  onOpenChapter,
  onAiCommand,
}: IdeationProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{
    project: ProjectEntry;
    tab?: ProjectTab;
    focus?: string;
    seq: number;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // 展示模式（工单 #22）：项目列表档位与书写板块共用一个偏好。
  const [display, setDisplay] = useDisplayMode("projects");

  const scan = useCallback(async (root: string) => {
    setScanning(true);
    setError(null);
    try {
      const list = await invoke<ProjectEntry[]>("scan_projects", { root });
      setProjects(list);
      // 打开着的项目也换成最新快照，页内计数（导航徽标）跟着刷新。
      setOpen((cur) => {
        if (!cur) return cur;
        const fresh = list.find((p) => p.dir === cur.project.dir);
        return fresh ? { ...cur, project: fresh } : cur;
      });
    } catch (e) {
      setProjects([]);
      setError(`扫描失败：${errMsg(e)}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (libraryPath) void scan(libraryPath);
  }, [libraryPath, scan]);

  // 跨板块跳转：直接开跳转方带来的项目快照，不等本板块自己的列表。
  // seq 递增让「再次跳到同一个项目」也重挂载——页签只在新挂载时生效。
  useEffect(() => {
    if (!jump) return;
    setOpen((cur) => ({
      project: jump.project,
      tab: jump.tab,
      focus: jump.focus,
      seq: (cur?.seq ?? 0) + 1,
    }));
    onJumpConsumed();
  }, [jump, onJumpConsumed]);

  async function create() {
    if (!libraryPath || busy) return;
    const title = newTitle.trim();
    if (!title) {
      window.alert("书名不能为空。");
      return;
    }
    setBusy(true);
    try {
      const project = await invoke<ProjectEntry>("create_project", { root: libraryPath, title });
      setCreating(false);
      setNewTitle("");
      await scan(libraryPath);
      setOpen({ project, seq: 0 });
    } catch (e) {
      window.alert(`新建项目失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    return (
      <ProjectPage
        key={`${open.project.dir}#${open.seq}`}
        project={open.project}
        libraryPath={libraryPath}
        initialTab={open.tab}
        initialFocus={open.focus}
        onOpenChapter={onOpenChapter}
        onAiCommand={onAiCommand}
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
          <h1>构思</h1>
          {libraryPath && (
            <p className="library-path" title={libraryPath}>
              {libraryPath}
            </p>
          )}
        </div>
        <div className="page-actions">
          {libraryPath ? (
            <>
              <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
                刷新
              </button>
              <button className="btn primary" onClick={() => setCreating(true)}>
                新建项目
              </button>
            </>
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
            构思项目存在库文件夹的「项目/」子目录里，一本书一个文件夹；
            <br />
            可以直接用现有的拆书库文件夹（拆书与构思互不干扰）。
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
          <p>还没有构思项目。</p>
          <p className="hint">
            新建一个项目（一本书），从「读者遐想（类型圈）」开始：先想清楚读者要看什么，
            <br />
            再把矛盾丢进矛盾池，展开成单元，排布成大纲。
          </p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={() => setCreating(true)}>
              新建项目
            </button>
          </div>
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
                  title="打开项目"
                  onClick={() => setOpen({ project: p, seq: 0 })}
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
                    <button
                      className="card-title"
                      title="打开项目"
                      onClick={() => setOpen({ project: p, seq: 0 })}
                    >
                      {p.title}
                    </button>
                    {p.name !== p.title && p.name !== `《${p.title}》` && (
                      <span className="card-cat">{p.name}</span>
                    )}
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

      {creating && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <div className="dialog">
            <h2>新建项目</h2>
            <label>
              书名
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="如：大魏读书人"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </label>
            <p className="hint">
              会建 项目/《书名》/；正文/ 与构思数据随使用懒生成。
              同名项目已存在时报错，不自动续号。
            </p>
            <div className="dialog-actions">
              <button className="btn" disabled={busy} onClick={() => setCreating(false)}>
                取消
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void create()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
