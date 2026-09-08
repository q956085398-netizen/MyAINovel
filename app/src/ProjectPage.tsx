import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ArrangementItem,
  NoteEntry,
  NoteKind,
  ProjectEntry,
  ProjectMeta,
  Vocabulary,
} from "./types";
import { emptyProjectMeta } from "./types";
import { errMsg, formatCount } from "./util";
import ArrangementView from "./ArrangementView";
import CircleView from "./CircleView";
import NoteList from "./NoteList";
import ProjectMetaDialog from "./ProjectMetaDialog";

const TABS = ["类型圈", "矛盾", "单元", "排布", "人物", "世界观", "开头"] as const;
type Tab = (typeof TABS)[number];

const NOTE_TABS: NoteKind[] = ["矛盾", "单元", "人物", "世界观", "开头"];

function isNoteTab(tab: Tab): tab is NoteKind {
  return (NOTE_TABS as string[]).includes(tab);
}

interface ProjectPageProps {
  project: ProjectEntry;
  libraryPath: string | null;
  onBack: () => void;
  /** 项目内容变了：让上层刷新项目列表的计数。 */
  onChanged: () => void;
}

/** 构思项目页（工单 #4 的文件布局）：类型圈 / 矛盾池 / 单元 / 排布 /
 *  人物 / 世界观 / 开头。正文由「书写」板块承接（工单 #5）。 */
export default function ProjectPage({
  project,
  libraryPath,
  onBack,
  onChanged,
}: ProjectPageProps) {
  const [tab, setTab] = useState<Tab>("类型圈");
  const [meta, setMeta] = useState<ProjectMeta>(emptyProjectMeta());
  const [metaWarning, setMetaWarning] = useState<string | undefined>();
  const [metaOpen, setMetaOpen] = useState(false);
  const [vocab, setVocab] = useState<Vocabulary | null>(null);
  const [units, setUnits] = useState<NoteEntry[]>([]);
  const [worldview, setWorldview] = useState<NoteEntry[]>([]);
  const [arrangement, setArrangement] = useState<ArrangementItem[]>([]);
  const [arrangementError, setArrangementError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await invoke<ProjectMeta>("read_project_meta", { project: project.dir }));
      setMetaWarning(undefined);
    } catch (e) {
      setMeta(emptyProjectMeta());
      setMetaWarning(
        `项目.yaml 解析失败：${errMsg(e)}。在「项目资料」保存会整文件覆盖，请先确认内容。`,
      );
    }
  }, [project.dir]);

  const loadUnits = useCallback(async () => {
    try {
      setUnits(await invoke<NoteEntry[]>("scan_notes", { project: project.dir, kind: "单元" }));
    } catch {
      setUnits([]);
    }
  }, [project.dir]);

  const loadWorldview = useCallback(async () => {
    try {
      setWorldview(
        await invoke<NoteEntry[]>("scan_notes", { project: project.dir, kind: "世界观" }),
      );
    } catch {
      setWorldview([]);
    }
  }, [project.dir]);

  const loadArrangement = useCallback(async () => {
    try {
      setArrangement(await invoke<ArrangementItem[]>("read_arrangement", { project: project.dir }));
      setArrangementError(null);
    } catch (e) {
      setArrangement([]);
      setArrangementError(
        `排布.yaml 解析失败：${errMsg(e)}。请在 Obsidian 里修好再回来编辑（应用不覆盖读不懂的文件）。`,
      );
    }
  }, [project.dir]);

  const loadVocab = useCallback(async () => {
    if (!libraryPath) return;
    try {
      setVocab(await invoke<Vocabulary>("load_vocab", { root: libraryPath }));
    } catch {
      setVocab(null);
    }
  }, [libraryPath]);

  useEffect(() => {
    void loadMeta();
    void loadUnits();
    void loadWorldview();
    void loadArrangement();
    void loadVocab();
    // 切页时重读跨页数据（单元/世界观/项目资料是排布页的输入）。
  }, [loadMeta, loadUnits, loadWorldview, loadArrangement, loadVocab, tab, reloadKey]);

  /** 页内某处保存成功：只通知上层刷新项目列表计数，不重挂当前页
   *  （重挂会把排布/列表的滚动与刚存下的状态冲掉）。 */
  const refreshAll = useCallback(() => {
    onChanged();
  }, [onChanged]);

  // 排布的地图提示值＝项目.yaml 的「地图」＋世界观「地理」词条（按名引用）。
  const mapNames = [
    ...meta.maps,
    ...worldview
      .filter((n) => n.category === "地理" && !meta.maps.includes(n.name))
      .map((n) => n.name),
  ];

  return (
    <div className="project-page">
      <header className="page-header">
        <div>
          <h1>{meta.title ?? project.title}</h1>
          <p className="library-path" title={project.dir}>
            {project.dir}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={onBack}>
            ← 项目列表
          </button>
          <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            刷新
          </button>
          <button className="btn" onClick={() => setMetaOpen(true)}>
            项目资料
          </button>
        </div>
      </header>

      {metaWarning && <div className="error-box">{metaWarning}</div>}

      <div className="project-body">
        <nav className="project-nav">
          {TABS.map((t) => (
            <button
              key={t}
              className={`nav-item ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
              {t === "矛盾" && project.contradictionCount > 0 && (
                <span className="nav-badge">{project.contradictionCount}</span>
              )}
              {t === "单元" && project.unitCount > 0 && (
                <span className="nav-badge">{project.unitCount}</span>
              )}
              {t === "人物" && project.characterCount > 0 && (
                <span className="nav-badge">{project.characterCount}</span>
              )}
              {t === "世界观" && project.worldviewCount > 0 && (
                <span className="nav-badge">{project.worldviewCount}</span>
              )}
              {t === "开头" && project.openingCount > 0 && (
                <span className="nav-badge">{project.openingCount}</span>
              )}
            </button>
          ))}
          <div className="project-nav-foot">
            正文 {formatCount(project.chapterCount)} 章 · {formatCount(project.wordCount)} 字
            <br />
            书写编辑器由工单 #5 定稿后落地
          </div>
        </nav>

        <div className="project-content" key={`${tab}-${reloadKey}`}>
          {tab === "类型圈" && <CircleView project={project.dir} vocab={vocab} />}
          {isNoteTab(tab) && (
            <NoteList
              project={project.dir}
              kind={tab}
              vocab={vocab}
              onChanged={refreshAll}
              onPromoted={() => setTab("单元")}
            />
          )}
          {tab === "排布" &&
            (arrangementError ? (
              <div className="note-pane">
                <div className="error-box">{arrangementError}</div>
              </div>
            ) : (
              <ArrangementView
                project={project.dir}
                unitNames={units.map((u) => u.name)}
                plotLines={meta.plotLines}
                mapNames={mapNames}
                initial={arrangement}
                onSaved={refreshAll}
              />
            ))}
        </div>
      </div>

      {metaOpen && (
        <ProjectMetaDialog
          project={project.dir}
          initial={meta}
          fallbackTitle={project.title}
          warning={metaWarning}
          onClose={() => setMetaOpen(false)}
          onSaved={(m) => {
            setMeta(m);
            setMetaWarning(undefined);
            setMetaOpen(false);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}
