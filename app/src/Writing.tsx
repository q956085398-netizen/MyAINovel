import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectEntry } from "./types";
import { errMsg, formatCount } from "./util";
import WritingPage from "./WritingPage";

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
}

/** 书写板块（工单 #5，docs/spec/书写编辑器.md）：日常码字工具。
 *  项目与构思共用「项目/」布局，这里只写 正文/。 */
export default function Writing({ libraryPath, active, onChooseFolder }: WritingProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ProjectEntry | null>(null);
  /** 只在本板块首次扫盘时自动回到上次的项目。 */
  const autoOpenRef = useRef(true);

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
        if (pick) setOpen(pick);
      }
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

  function openProject(project: ProjectEntry) {
    localStorage.setItem(LAST_PROJECT_KEY, project.dir);
    setOpen(project);
  }

  if (open) {
    return (
      <WritingPage
        key={open.dir}
        project={open}
        active={active}
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
          <p className="stats">共 {formatCount(projects.length)} 个项目</p>
          <div className="card-list">
            {projects.map((p) => (
              <div key={p.dir} className="card-item">
                <div className="card-title-row">
                  <button className="card-title" title="开始写" onClick={() => openProject(p)}>
                    {p.title}
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
        </>
      )}
    </div>
  );
}
