import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AiCommandKind,
  AiSeed,
  ArrangementItem,
  MapWorkspace,
  NoteEntry,
  NoteKind,
  ProjectEntry,
  ProjectMeta,
  Vocabulary,
} from "./types";
import { emptyProjectMeta, EXPECTATION_KIND_EXPECT, EXPECTATION_KIND_GOAL } from "./types";
import { errMsg, formatCount } from "./util";
import ArrangementView from "./ArrangementView";
import CircleView from "./CircleView";
import ExpectationBoard from "./ExpectationBoard";
import ForeshadowBoard from "./ForeshadowBoard";
import NoteList from "./NoteList";
import ProjectMetaDialog from "./ProjectMetaDialog";
import RelationshipCanvas from "./RelationshipCanvas";
import PlanningView from "./PlanningView";
import BridgeLibrary from "./BridgeLibrary";
import { ArrowLeft, Icon, ICON_SIZE_DENSE } from "./icons";

// 「三线」拆为「期待感」「目标」两页签（工单 #36）：名字自解释，
// 数据模型不动（三线.yaml 的类别枚举仍是 期待｜目标），只按类别过滤复用看板。
const TABS = [
  "大纲",
  "类型圈",
  "矛盾",
  "桥段库",
  "单元",
  "伏笔",
  "期待感",
  "目标",
  "排布",
  "人物",
  "世界观",
  "开头",
] as const;
const NAV_GROUPS = [
  { step: "第一步", label: "定书", tabs: ["大纲", "类型圈", "人物", "世界观", "开头"] },
  { step: "第二步", label: "生情节", tabs: ["矛盾", "桥段库", "单元", "排布"] },
  { step: "第三步", label: "织张力", tabs: ["伏笔", "期待感", "目标"] },
] as const;
/** 项目页签；跨板块跳转（灵感库关联 → 项目）也用它指路。 */
export type ProjectTab = (typeof TABS)[number];
type Tab = ProjectTab;

const NOTE_TABS: NoteKind[] = ["矛盾", "单元", "人物", "世界观", "开头"];

/** 「人物」页签的两面：名单（小传）与画布（关系网）。 */
const CHARACTER_VIEWS = ["名单", "画布"] as const;
type CharacterView = (typeof CHARACTER_VIEWS)[number];

function isNoteTab(tab: Tab): tab is NoteKind {
  return (NOTE_TABS as string[]).includes(tab);
}

interface ProjectPageProps {
  project: ProjectEntry;
  libraryPath: string | null;
  /** 打开时落在哪个页签（默认「类型圈」）；仅挂载时生效。 */
  initialTab?: ProjectTab;
  /** 跨板块跳来的人名（灵感库关联 →「《书名》/人名」）：落到人物画布并选中。 */
  initialFocus?: string;
  onBack: () => void;
  /** 项目内容变了：让上层刷新项目列表的计数。 */
  onChanged: () => void;
  /** 伏笔看板点章：跳到书写板块打开该章。 */
  onOpenChapter: (projectDir: string, ordinal: number, quote: string) => void;
  /** 板块 AI 命令：材料由后端组装（工单 #15）。 */
  onAiCommand: (seed: AiSeed) => void;
}

/** 构思项目页（工单 #4 的文件布局）：类型圈 / 矛盾池 / 单元 / 伏笔 / 排布 /
 *  人物（名单｜画布）/ 世界观 / 开头。正文由「书写」板块承接（工单 #5）。 */
export default function ProjectPage({
  project,
  libraryPath,
  initialTab,
  initialFocus,
  onBack,
  onChanged,
  onOpenChapter,
  onAiCommand,
}: ProjectPageProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "大纲");
  const [meta, setMeta] = useState<ProjectMeta>(emptyProjectMeta());
  const [metaWarning, setMetaWarning] = useState<string | undefined>();
  const [metaOpen, setMetaOpen] = useState(false);
  const [vocab, setVocab] = useState<Vocabulary | null>(null);
  const [units, setUnits] = useState<NoteEntry[]>([]);
  const [worldview, setWorldview] = useState<NoteEntry[]>([]);
  const [mapWorkspace, setMapWorkspace] = useState<MapWorkspace>({ maps: [], regions: [] });
  const [arrangement, setArrangement] = useState<ArrangementItem[]>([]);
  const [arrangementError, setArrangementError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [characterView, setCharacterView] = useState<CharacterView>(
    initialFocus ? "画布" : "名单",
  );

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

  const loadMapWorkspace = useCallback(async () => {
    try {
      setMapWorkspace(await invoke<MapWorkspace>("read_map_workspace", { project: project.dir }));
    } catch {
      // 地图实体是新增的可选目录；损坏文件不应妨碍旧项目继续排布。
      setMapWorkspace({ maps: [], regions: [] });
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
    void loadMapWorkspace();
    void loadArrangement();
    void loadVocab();
    // 切页时重读跨页数据（单元/世界观/项目资料是排布页的输入）。
  }, [loadMeta, loadUnits, loadWorldview, loadMapWorkspace, loadArrangement, loadVocab, tab, reloadKey]);

  /** 页内某处保存成功：只通知上层刷新项目列表计数，不重挂当前页
   *  （重挂会把排布/列表的滚动与刚存下的状态冲掉）。 */
  const refreshAll = useCallback(() => {
    onChanged();
  }, [onChanged]);

  /** 板块 AI 命令：材料（类型圈/排布/矛盾池/人物关系…）由后端现读组装，
   *  命令只出报告；`subjects`＝选中的人名（只有「人物关系梳理」用）。 */
  const runAiCommand = useCallback(
    async (kind: AiCommandKind, subjects?: string[]) => {
      try {
        const text = await invoke<string>("build_ai_context", {
          kind,
          project: project.dir,
          chapter: null,
          subjects: subjects ?? null,
        });
        onAiCommand({ kind, bookName: meta.title ?? project.title, text });
      } catch (e) {
        window.alert(`AI 命令材料读取失败：${errMsg(e)}`);
      }
    },
    [onAiCommand, project.dir, project.title, meta.title],
  );

  /** 「跟 TA 聊」进人物对话（工单 #16）：材料后端现读，人格底座随会话走；
   *  跟命令不同——不自动发送，建好会话等人先开口。 */
  const chatWith = useCallback(
    async (name: string) => {
      const bookTitle = meta.title ?? project.title;
      try {
        const text = await invoke<string>("build_ai_context", {
          kind: "人物对话",
          project: project.dir,
          chapter: null,
          subjects: [name],
        });
        onAiCommand({
          kind: "人物对话",
          bookName: bookTitle,
          text,
          note: name,
          persona: { project: `《${bookTitle}》`, person: name },
        });
      } catch (e) {
        window.alert(`人物对话开不起来：${errMsg(e)}`);
      }
    },
    [onAiCommand, project.dir, project.title, meta.title],
  );

  // 排布的地图提示值＝项目.yaml 的「地图」＋世界观「地理」词条（按名引用）。
  const mapNames = [
    ...meta.maps,
    ...worldview
      .filter((n) => n.category === "地理" && !meta.maps.includes(n.name))
      .map((n) => n.name),
    ...mapWorkspace.maps
      .map((map) => map.name)
      .filter((name) => !meta.maps.includes(name) && !worldview.some((note) => note.category === "地理" && note.name === name)),
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
          <button className="btn with-icon" onClick={onBack}>
            <Icon as={ArrowLeft} size={ICON_SIZE_DENSE} />
            项目列表
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
          {NAV_GROUPS.map((group) => (
            <div className="project-nav-group" key={group.label}>
              <p className="project-nav-label">
                <span>{group.step}</span>
                {group.label}
              </p>
              {group.tabs.map((t) => (
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
                  {t === "伏笔" && project.foreshadowCount > 0 && (
                    <span className="nav-badge">{project.foreshadowCount}</span>
                  )}
                  {t === "期待感" && project.expectationExpectCount > 0 && (
                    <span className="nav-badge">{project.expectationExpectCount}</span>
                  )}
                  {t === "目标" && project.expectationGoalCount > 0 && (
                    <span className="nav-badge">{project.expectationGoalCount}</span>
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
            </div>
          ))}
          <div className="project-nav-foot">
            正文 {formatCount(project.chapterCount)} 章 · {formatCount(project.wordCount)} 字
            <br />
            正文在「书写」板块编辑（一章一文件）
          </div>
        </nav>

        <div className="project-content" key={`${tab}-${reloadKey}`}>
          {tab === "大纲" && <PlanningView project={project.dir} unitNames={units.map((unit) => unit.name)} />}
          {tab === "类型圈" && <CircleView project={project.dir} vocab={vocab} />}
          {tab === "桥段库" && (
            <BridgeLibrary
              project={project.dir}
              units={units}
              onChanged={refreshAll}
            />
          )}
          {isNoteTab(tab) && tab !== "人物" && (
            <NoteList
              project={project.dir}
              kind={tab}
              vocab={vocab}
              onChanged={refreshAll}
              onPromoted={() => setTab("单元")}
              onAiCommand={tab === "矛盾" ? () => void runAiCommand("矛盾梳理") : undefined}
            />
          )}
          {tab === "人物" && (
            <div className="character-pane">
              <div className="subtabs">
                {CHARACTER_VIEWS.map((v) => (
                  <button
                    key={v}
                    className={`subtab ${characterView === v ? "active" : ""}`}
                    onClick={() => setCharacterView(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="character-view" key={characterView}>
                {characterView === "名单" ? (
                  <NoteList
                    project={project.dir}
                    kind="人物"
                    vocab={vocab}
                    onChanged={refreshAll}
                    onPromoted={() => setTab("单元")}
                    onChat={(name) => void chatWith(name)}
                  />
                ) : (
                  <RelationshipCanvas
                    project={project.dir}
                    focusName={initialFocus}
                    onAiCommand={(names) => void runAiCommand("人物关系梳理", names)}
                    onChat={(name) => void chatWith(name)}
                    onPromoted={() => setTab("矛盾")}
                    onChanged={refreshAll}
                  />
                )}
              </div>
            </div>
          )}
          {tab === "伏笔" && (
            <ForeshadowBoard
              project={project.dir}
              chapterPrefix={meta.chapterPrefix}
              onChanged={refreshAll}
              onOpenChapter={(ordinal, quote) => onOpenChapter(project.dir, ordinal, quote)}
            />
          )}
          {(tab === "期待感" || tab === "目标") && (
            <ExpectationBoard
              project={project.dir}
              kind={tab === "期待感" ? EXPECTATION_KIND_EXPECT : EXPECTATION_KIND_GOAL}
              chapterPrefix={meta.chapterPrefix}
              onChanged={refreshAll}
              onOpenChapter={(ordinal, quote) => onOpenChapter(project.dir, ordinal, quote)}
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
                onAiCommand={() => void runAiCommand("排布体检")}
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
