import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  MapDraft,
  MapStructure,
  MapTransition,
  MapWorkspace,
  NoteDraft,
  NoteEntry,
  RegionDraft,
} from "./types";
import { emptyMapDraft, emptyNoteDraft, emptyRegionDraft } from "./types";
import { errMsg } from "./util";
import ContentSurface from "./ContentSurface";
import {
  CONTENT_SURFACE_STORAGE_KEY,
  readCollapsedCardPaths,
  serializeCollapsedCardPaths,
} from "./contentSurfaceState";
import MapDialog from "./MapDialog";
import NoteDialog from "./NoteDialog";
import PendingZone from "./PendingZone";
import RegionDialog from "./RegionDialog";
import TransitionDialog from "./TransitionDialog";
import { usePendingToggle } from "./pendingToggle";

/** 地图页的四个副页签（spec 地图与地域 §四）：全貌管整体、地域管局部、
 *  转场管地图间承接、历史管时代引用；只有一层副页签。 */
const MAP_TABS = ["全貌", "地域", "转场", "历史"] as const;
type MapTab = (typeof MAP_TABS)[number];

const MAPS_SURFACE = "maps";

const TAB_INTROS: Record<MapTab, string> = {
  全貌: "一张地图是一个整体故事空间：尺度、边界、全局矛盾与秘密都记在地图卡上；一本多图的书从这里看全貌。",
  地域: "地域是地图内部的局部区域：人物、组织、矛盾和当地主线记在地域卡上；相邻、通道等地域连接也只在地域语境里出现。",
  转场: "转场只管地图之间的叙事承接（离开原因、先行人物、未解问题、返回条件）；地域之间的移动不在这里。",
  历史: "时代是可选的引用（写在地图/地域档案的「时代」字段），按时代回看同一地方的层次，不强制建立完整年表。",
};

/** 字段行：只渲染已填写内容，空字段不出现（spec 工作台与卡片呈现 §2.1）。 */
function FieldLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="field-line">
      <span className="field-label">{label}</span>
      {value}
    </p>
  );
}

function fieldLines(rows: [string, string | null | undefined][]): ReactNode {
  return rows
    .filter(([, value]) => (value ?? "").toString().trim().length > 0)
    .map(([label, value]) => <FieldLine key={label} label={label} value={(value ?? "").toString()} />);
}

function listText(values: string[]): string | null {
  return values.length > 0 ? values.join("、") : null;
}

/** 空页引导（工单 #65）：简短、可关闭；关闭记在本地，不再打扰。 */
function DismissableIntro({ id, children }: { id: string; children: ReactNode }) {
  const storageKey = `gongbi.maps.intro.${id}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(storageKey) === "1");
  if (hidden) return null;
  return (
    <div className="hint-box dismissable-intro">
      <span>{children}</span>
      <button
        className="link-like"
        onClick={() => {
          localStorage.setItem(storageKey, "1");
          setHidden(true);
        }}
      >
        知道了
      </button>
    </div>
  );
}

interface MapsViewProps {
  project: string;
  /** 档案增删改后：让项目页刷新计数。 */
  onChanged: () => void;
}

/** 地图板块（工单 #65 / T15）：全貌／地域／转场／历史四页签。
 *  档案（构思/地图、构思/地域的 .md）与结构（地图结构.yaml）是两份文件、
 *  同一份数据源；卡片、页签与重开读的都是它们，没有副本。 */
export default function MapsView({ project, onChanged }: MapsViewProps) {
  const [subtab, setSubtab] = useState<MapTab>("全貌");
  const [workspace, setWorkspace] = useState<MapWorkspace>({ maps: [], regions: [] });
  const [structure, setStructure] = useState<MapStructure | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [worldview, setWorldview] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [mapEditing, setMapEditing] = useState<{ draft: MapDraft; prevPath: string | null } | null>(
    null,
  );
  const [regionEditing, setRegionEditing] = useState<{
    draft: RegionDraft;
    prevPath: string | null;
    ownerMap: string | null;
  } | null>(null);
  const [transitionEditing, setTransitionEditing] = useState<{
    initial: MapTransition | null;
    index: number | null;
  } | null>(null);
  const [eraEditing, setEraEditing] = useState<{ draft: NoteDraft; prevPath: string | null } | null>(
    null,
  );

  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(() =>
    readCollapsedCardPaths(localStorage.getItem(CONTENT_SURFACE_STORAGE_KEY), MAPS_SURFACE),
  );

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      setWorkspace(await invoke<MapWorkspace>("read_map_workspace", { project }));
    } catch {
      // 档案目录是可选的；单个损坏文件不拖垮整页（后端按原文降级）。
      setWorkspace({ maps: [], regions: [] });
    }
    try {
      setStructure(await invoke<MapStructure>("read_map_structure", { project }));
      setStructureError(null);
    } catch (e) {
      setStructure(null);
      setStructureError(
        `地图结构.yaml 解析失败：${errMsg(e)}。应用不覆盖读不懂的文件，请先在 Obsidian 里修好再回来编辑。`,
      );
    }
    try {
      setWorldview(await invoke<NoteEntry[]>("scan_notes", { project, kind: "世界观" }));
    } catch {
      setWorldview([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void scan();
    // 切页签时重读：档案可能在别的页签/板块里改过。
  }, [scan, subtab, reloadKey]);

  const { switching, toggle: togglePending } = usePendingToggle(scan);

  function toggleCollapsed(path: string) {
    setCollapsedCards((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      localStorage.setItem(
        CONTENT_SURFACE_STORAGE_KEY,
        serializeCollapsedCardPaths(
          localStorage.getItem(CONTENT_SURFACE_STORAGE_KEY),
          MAPS_SURFACE,
          next,
        ),
      );
      return next;
    });
  }

  const mapNames = useMemo(() => workspace.maps.map((m) => m.name), [workspace.maps]);

  /** 地域 → 所属地图（结构表「包含」派生）；引用失效只提示不校验。 */
  const regionOwner = useMemo(() => {
    const owner = new Map<string, string>();
    if (structure) {
      for (const row of structure.contains) owner.set(row.region, row.map);
    }
    return owner;
  }, [structure]);

  const eras = useMemo(
    () => worldview.filter((note) => note.category === "时代"),
    [worldview],
  );

  const pendingMaps = workspace.maps.filter((m) => m.pending);
  const normalMaps = workspace.maps.filter((m) => !m.pending);
  const pendingRegions = workspace.regions.filter((r) => r.pending);
  const normalRegions = workspace.regions.filter((r) => !r.pending);

  function refresh() {
    onChanged();
    setReloadKey((k) => k + 1);
  }

  /** 引用名不在现有地图里：缺省提示（spec §三：不自动删边）。 */
  function mapRef(name: string): string {
    return mapNames.includes(name) ? name : `${name}（地图不存在）`;
  }

  return (
    <div className="note-pane map-pane">
      <div className="pane-head">
        <div>
          <h2>地图</h2>
          <p className="hint">
            地图管整体故事空间，地域管局部；两者都是一文件档案（构思/地图、构思/地域），
            结构与画布关系存 构思/地图结构.yaml。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            刷新
          </button>
          {subtab === "全貌" && (
            <button
              className="btn primary"
              onClick={() => setMapEditing({ draft: emptyMapDraft(), prevPath: null })}
            >
              新建地图
            </button>
          )}
          {subtab === "地域" && (
            <button
              className="btn primary"
              onClick={() =>
                setRegionEditing({ draft: emptyRegionDraft(), prevPath: null, ownerMap: null })
              }
            >
              新建地域
            </button>
          )}
          {subtab === "转场" && (
            <button
              className="btn primary"
              disabled={mapNames.length < 2}
              title={mapNames.length < 2 ? "转场需要至少两张地图，先去「全貌」建图。" : undefined}
              onClick={() => setTransitionEditing({ initial: null, index: null })}
            >
              新建转场
            </button>
          )}
          {subtab === "历史" && (
            <button
              className="btn primary"
              onClick={() => {
                const draft = emptyNoteDraft("世界观");
                setEraEditing({ draft: { ...draft, category: "时代" }, prevPath: null });
              }}
            >
              新建时代词条
            </button>
          )}
        </div>
      </div>

      <div className="subtabs">
        {MAP_TABS.map((t) => (
          <button
            key={t}
            className={`subtab ${subtab === t ? "active" : ""}`}
            onClick={() => setSubtab(t)}
          >
            {t}
            {t === "全貌" && workspace.maps.length > 0 && (
              <span className="subtab-count">{workspace.maps.length}</span>
            )}
            {t === "地域" && workspace.regions.length > 0 && (
              <span className="subtab-count">{workspace.regions.length}</span>
            )}
            {t === "转场" && structure && structure.transitions.length > 0 && (
              <span className="subtab-count">{structure.transitions.length}</span>
            )}
          </button>
        ))}
      </div>

      {structureError && <div className="error-box">{structureError}</div>}
      {loading && <p className="hint">正在读取……</p>}

      <div className="map-archive" key={subtab}>
        {subtab === "全貌" && (
          <>
            <DismissableIntro id="全貌">{TAB_INTROS.全貌}</DismissableIntro>
            <PendingZone
              label="待打磨的地图"
              count={pendingMaps.length}
              hint="还在发酵的空间设定；整理完成后回到下面的原位置。"
            >
              <div className="card-list">
                {pendingMaps.map((map) => (
                  <article key={map.path} className="card-item is-pending">
                    <div className="card-title-row">
                      <button
                        className="card-title"
                        title="编辑这张地图档案"
                        onClick={() =>
                          setMapEditing({ draft: map, prevPath: map.path })
                        }
                      >
                        {map.name}
                      </button>
                      {map.scale && <span className="card-cat">{map.scale}</span>}
                    </div>
                    {fieldLines([
                      ["阶段目标", map.stageGoal],
                      ["中心矛盾", map.centralConflict],
                      ["核心秘密", map.coreSecret],
                      ["当地主线", map.localMainline],
                    ])}
                    {map.body && <div className="card-body">{map.body}</div>}
                    <div className="card-actions">
                      <button
                        className="btn primary small"
                        disabled={switching === map.path}
                        title="解除待打磨：档案回到原排序位置"
                        onClick={() => void togglePending(map.path, false)}
                      >
                        整理完成
                      </button>
                      <button
                        className="btn small"
                        onClick={() => setMapEditing({ draft: map, prevPath: map.path })}
                      >
                        编辑
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </PendingZone>

            {normalMaps.length === 0 && !loading && (
              <div className="empty-state">
                <p>还没有地图。</p>
                <p className="hint">
                  新建一张，或把旧的「地理」类世界观词条升级成地图／地域（在「世界观」页签里操作）。
                </p>
              </div>
            )}

            <div className="card-list">
              {normalMaps.map((map) => (
                <ContentSurface
                  key={map.path}
                  identity={map.path}
                  title={map.name}
                  badges={
                    <>
                      {map.scale && <span className="card-cat">{map.scale}</span>}
                      {map.eras.length > 0 && <span className="card-cat">{map.eras.join("·")}</span>}
                    </>
                  }
                  expanded={!collapsedCards.has(map.path)}
                  onEdit={() => setMapEditing({ draft: map, prevPath: map.path })}
                  onToggleExpanded={() => toggleCollapsed(map.path)}
                  actions={
                    <button
                      className="btn small"
                      disabled={switching === map.path}
                      title="挪到本页顶部的待打磨区；文件与排序位置都不动"
                      onClick={() => void togglePending(map.path, true)}
                    >
                      待打磨
                    </button>
                  }
                >
                  {fieldLines([
                    ["作用", map.role],
                    ["边界", map.boundary],
                    ["阶段目标", map.stageGoal],
                    ["中心矛盾", map.centralConflict],
                    ["核心秘密", map.coreSecret],
                    ["当地主线", map.localMainline],
                    ["进入条件", map.entryCondition],
                    ["离开条件", map.exitCondition],
                    ["人物", listText(map.people)],
                    ["组织", listText(map.organizations)],
                    ["单元", listText(map.units)],
                    ["主线里程碑", listText(map.milestones)],
                  ])}
                  {map.body && <div className="card-body">{map.body}</div>}
                </ContentSurface>
              ))}
            </div>
          </>
        )}

        {subtab === "地域" && (
          <>
            <DismissableIntro id="地域">{TAB_INTROS.地域}</DismissableIntro>
            <PendingZone
              label="待打磨的地域"
              count={pendingRegions.length}
              hint="还在发酵的地方设定；整理完成后回到下面的原位置。"
            >
              <div className="card-list">
                {pendingRegions.map((region) => (
                  <article key={region.path} className="card-item is-pending">
                    <div className="card-title-row">
                      <button
                        className="card-title"
                        title="编辑这份地域档案"
                        onClick={() =>
                          setRegionEditing({
                            draft: region,
                            prevPath: region.path,
                            ownerMap: regionOwner.get(region.name) ?? null,
                          })
                        }
                      >
                        {region.name}
                      </button>
                      {region.scale && <span className="card-cat">{region.scale}</span>}
                    </div>
                    {fieldLines([
                      ["剧情功能", region.plotRole],
                      ["当地主线", region.localMainline],
                      ["秘密", region.secret],
                    ])}
                    {region.body && <div className="card-body">{region.body}</div>}
                    <div className="card-actions">
                      <button
                        className="btn primary small"
                        disabled={switching === region.path}
                        title="解除待打磨：档案回到原排序位置"
                        onClick={() => void togglePending(region.path, false)}
                      >
                        整理完成
                      </button>
                      <button
                        className="btn small"
                        onClick={() =>
                          setRegionEditing({
                            draft: region,
                            prevPath: region.path,
                            ownerMap: regionOwner.get(region.name) ?? null,
                          })
                        }
                      >
                        编辑
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </PendingZone>

            {normalRegions.length === 0 && !loading && (
              <div className="empty-state">
                <p>还没有地域。</p>
                <p className="hint">地域是地图内部的局部区域；先建地图，再把归属填在地域卡上。</p>
              </div>
            )}

            <div className="card-list">
              {normalRegions.map((region) => {
                const owner = regionOwner.get(region.name);
                // 地域连接只出现在地域语境（spec §一）：相邻/通道/往返等，
                // 与跨地图转场分开。
                const connections = (structure?.regionRelations ?? []).filter(
                  (rel) => rel.from === region.name || rel.to === region.name,
                );
                return (
                  <ContentSurface
                    key={region.path}
                    identity={region.path}
                    title={region.name}
                    badges={
                      <>
                        {region.scale && <span className="card-cat">{region.scale}</span>}
                        <span
                          className="card-cat"
                          title={owner ? "所属地图（结构表「包含」）" : "还没归入任何地图"}
                        >
                          {owner ? mapRef(owner) : "未归图"}
                        </span>
                      </>
                    }
                    expanded={!collapsedCards.has(region.path)}
                    onEdit={() =>
                      setRegionEditing({
                        draft: region,
                        prevPath: region.path,
                        ownerMap: owner ?? null,
                      })
                    }
                    onToggleExpanded={() => toggleCollapsed(region.path)}
                    actions={
                      <button
                        className="btn small"
                        disabled={switching === region.path}
                        title="挪到本页顶部的待打磨区；文件与排序位置都不动"
                        onClick={() => void togglePending(region.path, true)}
                      >
                        待打磨
                      </button>
                    }
                  >
                    {fieldLines([
                      ["剧情功能", region.plotRole],
                      ["当地主线", region.localMainline],
                      ["秘密", region.secret],
                      ["展开为", region.expandsTo ? mapRef(region.expandsTo) : null],
                      ["人物", listText(region.people)],
                      ["组织", listText(region.organizations)],
                      ["矛盾", listText(region.contradictions)],
                      ["单元", listText(region.units)],
                      ["伏笔", listText(region.foreshadows)],
                      ["时代", listText(region.eras)],
                    ])}
                    {connections.length > 0 && (
                      <p className="field-line">
                        <span className="field-label">地域连接</span>
                        {connections
                          .map(
                            (rel) =>
                              `${rel.kind}：${rel.from === region.name ? rel.to : rel.from}`,
                          )
                          .join("；")}
                      </p>
                    )}
                    {region.body && <div className="card-body">{region.body}</div>}
                  </ContentSurface>
                );
              })}
            </div>
          </>
        )}

        {subtab === "转场" && (
          <>
            <DismissableIntro id="转场">{TAB_INTROS.转场}</DismissableIntro>
            {structure && structure.transitions.length === 0 && (
              <div className="empty-state">
                <p>还没有跨地图转场。</p>
                <p className="hint">
                  只有大地图之间的转场才记这里；地域内移动不用记，也不会触发割裂提示。
                </p>
              </div>
            )}
            <div className="card-list">
              {(structure?.transitions ?? []).map((t, index) => {
                const narrativeEmpty =
                  !t.reason &&
                  t.advancePeople.length === 0 &&
                  t.clues.length === 0 &&
                  t.unresolved.length === 0 &&
                  !t.returnCondition;
                return (
                  <article key={`${t.from}-${t.to}-${index}`} className="card-item">
                    <div className="card-title-row">
                      <button
                        className="card-title"
                        title="编辑这条转场"
                        onClick={() => setTransitionEditing({ initial: t, index })}
                      >
                        {mapRef(t.from)} <span className="transition-arrow">→</span> {mapRef(t.to)}
                      </button>
                    </div>
                    {fieldLines([
                      ["离开原因", t.reason],
                      ["先行人物", listText(t.advancePeople)],
                      ["提前线索", listText(t.clues)],
                      ["随行未解问题", listText(t.unresolved)],
                      ["返回条件", t.returnCondition],
                      ["单元", listText(t.units)],
                    ])}
                    {narrativeEmpty && (
                      <p className="hint">
                        还没写承接——大地图转场最容易割裂，补一补离开原因、先行人物或未解问题。
                      </p>
                    )}
                    <div className="card-actions">
                      <button
                        className="btn small"
                        onClick={() => setTransitionEditing({ initial: t, index })}
                      >
                        编辑
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        {subtab === "历史" && (
          <>
            <DismissableIntro id="历史">{TAB_INTROS.历史}</DismissableIntro>
            {eras.length === 0 && (
              <div className="empty-state">
                <p>还没有时代词条。</p>
                <p className="hint">
                  时代是可选的：建一条「时代」类世界观词条，再在地图／地域档案的「时代」字段里引用它。
                </p>
              </div>
            )}
            <div className="card-list">
              {eras.map((era) => {
                const refMaps = workspace.maps.filter((m) => m.eras.includes(era.name));
                const refRegions = workspace.regions.filter((r) => r.eras.includes(era.name));
                return (
                  <ContentSurface
                    key={era.path}
                    identity={era.path}
                    title={era.name}
                    badges={<span className="card-cat">时代</span>}
                    expanded={!collapsedCards.has(era.path)}
                    onEdit={() => setEraEditing({ draft: era, prevPath: era.path })}
                    onToggleExpanded={() => toggleCollapsed(era.path)}
                  >
                    {fieldLines([
                      ["地图", listText(refMaps.map((m) => m.name))],
                      ["地域", listText(refRegions.map((r) => r.name))],
                    ])}
                    {era.body && <div className="card-body">{era.body}</div>}
                  </ContentSurface>
                );
              })}
            </div>
          </>
        )}
      </div>

      {mapEditing && (
        <MapDialog
          project={project}
          initial={mapEditing.draft}
          prevPath={mapEditing.prevPath}
          onClose={() => setMapEditing(null)}
          onSaved={() => {
            setMapEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setMapEditing(null);
            refresh();
          }}
        />
      )}
      {regionEditing && (
        <RegionDialog
          project={project}
          initial={regionEditing.draft}
          prevPath={regionEditing.prevPath}
          ownerMap={regionEditing.ownerMap}
          mapNames={mapNames}
          onClose={() => setRegionEditing(null)}
          onSaved={() => {
            setRegionEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setRegionEditing(null);
            refresh();
          }}
        />
      )}
      {transitionEditing && structure && !structureError && (
        <TransitionDialog
          project={project}
          initial={transitionEditing.initial}
          index={transitionEditing.index}
          mapNames={mapNames}
          structure={structure}
          onClose={() => setTransitionEditing(null)}
          onSaved={() => {
            setTransitionEditing(null);
            refresh();
          }}
        />
      )}
      {eraEditing && (
        <NoteDialog
          project={project}
          initial={eraEditing.draft}
          prevPath={eraEditing.prevPath}
          vocab={null}
          onClose={() => setEraEditing(null)}
          onSaved={() => {
            setEraEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setEraEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
