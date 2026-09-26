import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  MapCanvasLayout,
  MapCanvasPlacement,
  MapEntry,
  MapRelation,
  MapStructure,
  MapTransition,
  Milestone,
  RegionEntry,
  RegionRelation,
} from "./types";
import { errMsg, oneLinePreview } from "./util";
import MapRelationDialog from "./MapRelationDialog";
import "./MapSemanticCanvas.css";

type ViewMode = "常规" | "千丝万缕" | "莲花" | "千层饼";
type RelationDraft = { index: number | null; relation: MapRelation | RegionRelation };
type NodeRecord = { name: string; map?: MapEntry; region?: RegionEntry; nestedRegions?: RegionEntry[]; missing?: boolean };
type MainlineMilestone = Pick<Milestone, "title" | "units"> & { lineName: string };
type DragState = {
  name: string;
  pointer: number;
  startX: number;
  startY: number;
  origin: MapCanvasPlacement;
  next: MapCanvasPlacement;
  moved: boolean;
};

interface Props {
  project: string;
  maps: MapEntry[];
  regions: RegionEntry[];
  structure: MapStructure;
  mainlineMilestones: MainlineMilestone[];
  /** null 为全书画布；有值时为这张地图内的地域画布。 */
  mapName: string | null;
  refreshKey: number;
  eras: string[];
  onSelectMap?: (name: string) => void;
  onCreateMap: () => void;
  onCreateRegion: (mapName: string | null) => void;
  onEditMap: (map: MapEntry) => void;
  onEditRegion: (region: RegionEntry) => void;
  onEditTransition: (transition: MapTransition, index: number) => void;
  onStructureChanged: (structure: MapStructure) => void;
  onRefresh: () => void;
  onCreateTransition: () => void;
}

const EMPTY_POSITION: MapCanvasPlacement[] = [];

function nodeReferences(node: NodeRecord, mainlineMilestones: MainlineMilestone[] = []) {
  const nested = node.nestedRegions ?? [];
  const region = node.region;
  const regionMilestones = region
    ? mainlineMilestones.filter((item) => item.lineName === region.localMainline?.trim() || item.units.some((unit) => region.units.includes(unit)))
    : [];
  return {
    people: [...(node.map?.people ?? node.region?.people ?? []), ...nested.flatMap((region) => region.people)],
    organizations: [...(node.map?.organizations ?? node.region?.organizations ?? []), ...nested.flatMap((region) => region.organizations)],
    story: node.map
      ? [...node.map.units, ...node.map.milestones, ...nested.flatMap((region) => [...region.contradictions, ...region.units, ...region.foreshadows])]
      : [...(region?.contradictions ?? []), ...(region?.units ?? []), ...(region?.foreshadows ?? [])],
    milestones: regionMilestones.map((item) => `主线里程碑 · ${item.title}`),
    secrets: region?.secret ? [`地域隐秘 · ${region.secret}`] : [],
  };
}

function previewLotus(nodes: NodeRecord[], placements: MapCanvasPlacement[], preferredCore?: string) {
  if (nodes.length < 2) return placements;
  const core = nodes.find((node) => node.name === preferredCore) ?? nodes.find((node) => node.map?.role?.includes("核心")) ?? nodes[0];
  const rest = nodes.filter((node) => node.name !== core.name);
  const current = new Map(placements.map((place) => [place.name, place]));
  const corePosition = current.get(core.name) ?? { name: core.name, x: 500, y: 340, pinned: false };
  const center = { x: Math.max(460, corePosition.x), y: Math.max(320, corePosition.y) };
  const radius = Math.max(230, 105 * Math.sqrt(rest.length));
  return nodes.map((node) => {
    if (node.name === core.name) return { ...corePosition, ...center };
    const index = rest.findIndex((item) => item.name === node.name);
    const angle = (2 * Math.PI * index) / rest.length - Math.PI / 2;
    return {
      ...(current.get(node.name) ?? { name: node.name, pinned: false, x: 180, y: 150 }),
      x: Math.min(99_900, Math.max(60, center.x + radius * Math.cos(angle))),
      y: Math.min(99_900, Math.max(60, center.y + radius * Math.sin(angle))),
    };
  });
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, bend: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return `M ${from.x - 40} ${from.y - 32} C ${from.x - 86} ${from.y - 112} ${from.x + 86} ${from.y - 112} ${from.x + 40} ${from.y - 32}`;
  const ux = dx / distance;
  const uy = dy / distance;
  const radius = 1 / Math.sqrt((ux / 82) ** 2 + (uy / 34) ** 2);
  const middleX = (from.x + to.x) / 2;
  const middleY = (from.y + to.y) / 2;
  return `M ${from.x + ux * radius} ${from.y + uy * radius} Q ${middleX - uy * bend} ${middleY + ux * bend} ${to.x - ux * radius} ${to.y - uy * radius}`;
}

/** 两级地图结构的可编辑视图；地图档案与结构文件仍是唯一数据来源。 */
export default function MapSemanticCanvas(props: Props) {
  const {
    project, maps, regions, structure, mainlineMilestones, mapName, refreshKey, eras,
    onSelectMap, onCreateMap, onCreateRegion, onEditMap, onEditRegion,
    onEditTransition, onStructureChanged,
    onRefresh, onCreateTransition,
  } = props;
  const [layout, setLayout] = useState<MapCanvasLayout | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<MapCanvasPlacement[] | null>(null);
  const [dragPreview, setDragPreview] = useState<MapCanvasPlacement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("常规");
  const [era, setEra] = useState("");
  const [overlay, setOverlay] = useState({ people: false, organizations: false, story: false });
  const [relationDialog, setRelationDialog] = useState<RelationDraft | null>(null);
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const drag = useRef<DragState | null>(null);
  const markerId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUndo(null);
    invoke<MapCanvasLayout>("read_map_canvas_layout", { project, mapName })
      .then((next) => {
        if (!cancelled) {
          setLayout(next);
          setSelected((current) => current && next.placements.some((item) => item.name === current) ? current : null);
        }
      })
      .catch((e) => { if (!cancelled) setError(`画布读取失败：${errMsg(e)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project, mapName, refreshKey]);

  const nodes = useMemo<NodeRecord[]>(() => {
    if (mapName === null) return maps.map((map) => ({
      name: map.name,
      map,
      nestedRegions: regions.filter((region) => structure.contains.some((row) => row.map === map.name && row.region === region.name)),
    }));
    const contained = new Set(structure.contains.filter((row) => row.map === mapName).map((row) => row.region));
    return regions.filter((region) => contained.has(region.name)).map((region) => ({ name: region.name, region }));
  }, [mapName, maps, regions, structure.contains]);

  const nodeByName = useMemo(() => new Map(nodes.map((node) => [node.name, node])), [nodes]);
  const allRegionNames = new Set(regions.map((region) => region.name));
  const localRegionNames = new Set(nodes.map((node) => node.name));
  const allMapNames = new Set(maps.map((map) => map.name));
  const relations = mapName === null
    ? structure.mapRelations.map((relation, index) => ({ relation, index }))
    : structure.regionRelations.map((relation, index) => ({ relation, index })).filter(({ relation }) => {
      const fromExists = allRegionNames.has(relation.from);
      const toExists = allRegionNames.has(relation.to);
      if (fromExists && toExists) return localRegionNames.has(relation.from) && localRegionNames.has(relation.to);
      if (!fromExists && !toExists) return true;
      const existingEndpoint = fromExists ? relation.from : relation.to;
      return localRegionNames.has(existingEndpoint);
    });
  const missingRelations = relations.filter(({ relation }) => mapName === null
    ? !allMapNames.has(relation.from) || !allMapNames.has(relation.to)
    : !allRegionNames.has(relation.from) || !allRegionNames.has(relation.to));
  const missingTransitionNames = mapName === null
    ? structure.transitions.filter((transition) => !allMapNames.has(transition.from) || !allMapNames.has(transition.to)).flatMap((transition) => [transition.from, transition.to]).filter((name) => !allMapNames.has(name))
    : [];
  const missingNames = [...new Set([
    ...missingRelations.flatMap(({ relation }) => [relation.from, relation.to]).filter((name) => mapName === null ? !allMapNames.has(name) : !allRegionNames.has(name)),
    ...missingTransitionNames,
  ])];
  const missingNodes: NodeRecord[] = missingNames.map((name) => ({ name, missing: true }));
  const placements = layout?.placements ?? EMPTY_POSITION;
  const positions = useMemo(() => new Map(placements.map((place) => [place.name, place])), [placements]);
  if (dragPreview) positions.set(dragPreview.name, dragPreview);
  const coreMap = structure.mapRelations.find((relation) => relation.kind.includes("核心附属"))?.from;
  const coreName = nodes.find((node) => node.map?.role?.includes("核心"))?.name ?? coreMap;
  const arrangedPositions = mode === "莲花" ? previewLotus(nodes, placements, coreName) : [...positions.values()];
  const missingStartY = Math.max(150, ...arrangedPositions.map((place) => place.y)) + 220;
  const missingPlacements = missingNames.map((name, index) => ({
    name,
    x: 180 + (index % 4) * 280,
    y: missingStartY + Math.floor(index / 4) * 190,
    pinned: false,
  }));
  const missingPositionByName = new Map(missingPlacements.map((placement) => [placement.name, placement]));
  const visiblePositions = [...arrangedPositions, ...missingPlacements];
  const visibleByName = useMemo(() => new Map(visiblePositions.map((place) => [place.name, place])), [visiblePositions]);
  const width = Math.max(850, ...visiblePositions.map((place) => place.x + 180));
  const attachmentRows = (node: NodeRecord) => {
    const refs = nodeReferences(node, mainlineMilestones);
    const count = (overlay.people ? refs.people.length : 0) + (overlay.organizations ? refs.organizations.length : 0);
    return Math.ceil(count / 2);
  };
  const storyChipCount = (node: NodeRecord) => {
    if (!overlay.story) return 0;
    const refs = nodeReferences(node, mainlineMilestones);
    return Math.min(5, refs.story.length + refs.milestones.length + refs.secrets.length);
  };
  const height = Math.max(520, ...visiblePositions.map((place) => {
    const node = nodeByName.get(place.name);
    return place.y + 130 + (mapName !== null && node ? attachmentRows(node) * 24 + storyChipCount(node) * 15 : 0);
  }));
  const mapEntry = maps.find((map) => map.name === mapName);
  const backgroundPath = mapEntry?.backgroundImagePath;
  const backgroundUrl = backgroundPath && !backgroundFailed ? convertFileSrc(backgroundPath) : null;
  useEffect(() => setBackgroundFailed(false), [mapName, backgroundPath]);

  const relationKinds = mapName === null
    ? structure.mapLegend.map((item) => item.name)
    : structure.regionLegend.map((item) => item.name);
  const transitions = mapName === null ? structure.transitions : [];
  const returningTransitionIndices = new Set<number>();
  if (mode === "莲花" && coreName) {
    transitions.forEach((transition, index) => {
      if (transition.from !== coreName) return;
      transitions.forEach((candidate, candidateIndex) => {
        if (candidate.from === transition.to && candidate.to === coreName) {
          returningTransitionIndices.add(index);
          returningTransitionIndices.add(candidateIndex);
        }
      });
    });
  }
  const containedRegions = new Set<string>();
  if (mapName !== null) {
    structure.contains.forEach((row) => {
      if (row.map === mapName && nodeByName.has(row.region)) containedRegions.add(row.region);
    });
  }
  const relationLegend = mapName === null ? structure.mapLegend : structure.regionLegend;
  const relationIsDirected = (relation: MapRelation | RegionRelation) =>
    relationLegend.find((item) => item.name === relation.kind)?.directed ?? false;
  const nodeEra = (node: NodeRecord) => node.map?.eras ?? node.region?.eras ?? [];
  const inEra = (node: NodeRecord) => !era || nodeEra(node).includes(era);
  const activeNodes = [...nodes, ...missingNodes];

  const sharedPairs = useMemo(() => {
    if (mode !== "千丝万缕") return [] as { from: string; to: string; refs: string[] }[];
    const pairs: { from: string; to: string; refs: string[] }[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const left = nodeReferences(nodes[i], mainlineMilestones);
        const right = nodeReferences(nodes[j], mainlineMilestones);
        const refs = [
          ...left.people.filter((item) => right.people.includes(item)).map((item) => `人物 · ${item}`),
          ...left.organizations.filter((item) => right.organizations.includes(item)).map((item) => `组织 · ${item}`),
          ...left.story.filter((item) => right.story.includes(item)).map((item) => `情节 · ${item}`),
          ...left.milestones.filter((item) => right.milestones.includes(item)),
          ...left.secrets.filter((item) => right.secrets.includes(item)),
        ];
        if (refs.length) pairs.push({ from: nodes[i].name, to: nodes[j].name, refs });
      }
    }
    return pairs;
  }, [mainlineMilestones, mode, nodes]);

  function run(action: Promise<unknown>) {
    void action.catch((e) => setError(`未保存：${errMsg(e)}。刷新画布后可重新操作。`));
  }

  async function savePositions(next: MapCanvasPlacement[], previous: MapCanvasPlacement[] | null = null) {
    if (busy || !layout) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<MapCanvasLayout>("save_map_canvas_layout", {
        project, mapName, placements: next, expected: layout.fingerprint,
      });
      setLayout(saved);
      setUndo(previous);
      onStructureChanged({ ...structure, fingerprint: saved.fingerprint });
    } catch (e) {
      setError(`未保存：${errMsg(e)}。刷新画布后可重新操作。`);
      throw e;
    } finally {
      setBusy(false);
      setDragPreview(null);
    }
  }

  async function arrange(all: boolean) {
    if (busy || !layout) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<MapCanvasLayout>("arrange_map_canvas", {
        project, mapName, all, expected: layout.fingerprint,
      });
      setLayout(result);
      setUndo(layout.placements);
      onStructureChanged({ ...structure, fingerprint: result.fingerprint });
    } catch (e) {
      setError(`整理失败：${errMsg(e)}。刷新画布后可重新操作。`);
    } finally {
      setBusy(false);
    }
  }

  async function changeRelation(index: number | null, next: MapRelation | RegionRelation | null) {
    if (busy || !layout) return;
    setBusy(true);
    setError(null);
    try {
      const command = mapName === null ? "edit_map_relation" : "edit_region_relation";
      const result = await invoke<MapStructure>(command, {
        project, index, next, expected: layout.fingerprint,
      });
      setLayout((current) => current ? { ...current, fingerprint: result.fingerprint } : current);
      onStructureChanged(result);
      setRelationDialog(null);
    } catch (e) {
      setError(`关系未保存：${errMsg(e)}。刷新画布后可重新操作。`);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function point(e: ReactPointerEvent<SVGGElement>) {
    const svg = e.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
  }

  function startDrag(e: ReactPointerEvent<SVGGElement>, position: MapCanvasPlacement) {
    if (busy || !layout || e.button !== 0 || mode === "莲花" || drag.current) return;
    const start = point(e);
    if (!start) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { name: position.name, pointer: e.pointerId, startX: start.x, startY: start.y, origin: position, next: position, moved: false };
  }

  function moveDrag(e: ReactPointerEvent<SVGGElement>) {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    const cursor = point(e);
    if (!cursor) return;
    const dx = cursor.x - current.startX;
    const dy = cursor.y - current.startY;
    if (Math.hypot(dx, dy) < 4 && !current.moved) return;
    current.moved = true;
    current.next = { ...current.origin, x: Math.min(100000, Math.max(60, current.origin.x + dx)), y: Math.min(100000, Math.max(60, current.origin.y + dy)) };
    setDragPreview(current.next);
  }

  function endDrag(e: ReactPointerEvent<SVGGElement>, cancel = false) {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (cancel) { setDragPreview(null); return; }
    if (!current.moved) {
      setSelected((value) => value === current.name ? null : current.name);
      return;
    }
    run(savePositions(placements.map((place) => place.name === current.name ? current.next : place)));
  }

  function openRelation(index: number | null, relation?: MapRelation | RegionRelation) {
    if (nodes.length === 0 && index === null) return;
    const names = nodes.map((node) => node.name);
    setRelationDialog({
      index,
      relation: relation ?? {
        from: selected && names.includes(selected) ? selected : names[0],
        to: names.find((name) => name !== (selected && names.includes(selected) ? selected : names[0])) ?? names[0],
        kind: relationKinds[0] ?? "关系",
        extra: {},
      },
    });
  }

  function editNode(name: string) {
    const record = nodeByName.get(name);
    if (!record) return;
    if (record.map) onEditMap(record.map);
    if (record.region) onEditRegion(record.region);
  }

  function toggleOverlay(key: keyof typeof overlay) {
    setOverlay((current) => ({ ...current, [key]: !current[key] }));
  }

  const backgroundLabel = mapEntry?.backgroundImage
    ? backgroundPath && !backgroundFailed ? null : `背景图不可用，已保留引用：${mapEntry.backgroundImage}`
    : null;

  return (
    <section className="map-semantic-canvas" aria-label={mapName === null ? "全书地图画布" : `${mapName}地域画布`}>
      <div className="map-canvas-heading">
        <div>
          <h3>{mapName === null ? "全书地图画布" : `${mapName} · 地域画布`}</h3>
          <p className="hint">拖动整理位置；双击或按 F2 打开档案。关系与坐标保存到地图结构，视角和叠加只用于观察。</p>
        </div>
        <div className="page-actions">
          {mapName === null ? <button className="btn small" onClick={onCreateMap}>新建地图</button> : <button className="btn small" onClick={() => onCreateRegion(mapName)}>新建地域</button>}
          {mapName !== null && onSelectMap && <button className="btn small" onClick={() => onSelectMap("")}>返回全貌</button>}
          <button className="btn small" disabled={busy || loading} onClick={() => { setBackgroundFailed(false); onRefresh(); }}>刷新画布</button>
        </div>
      </div>

      {mapName !== null && mapEntry && (
        <div className="map-canvas-parent">
          <span className="map-canvas-parent-label">所属地图</span>
          <button className="link-like" onClick={() => onEditMap(mapEntry)}>{mapEntry.name}</button>
          {mapEntry.scale && <span className="card-cat">{mapEntry.scale}</span>}
          {mapEntry.coreSecret && <span className="hint">核心秘密：{oneLinePreview(mapEntry.coreSecret, 48)}</span>}
        </div>
      )}

      <div className="map-canvas-toolbar">
        <div className="subtabs" role="group" aria-label="地图方法视角">
          {(["常规", "千丝万缕", "莲花", "千层饼"] as ViewMode[]).map((item) => (
            <button key={item} className={`subtab ${mode === item ? "active" : ""}`} aria-pressed={mode === item} onClick={() => setMode(item)}>{item}</button>
          ))}
        </div>
        {mode === "莲花" && (
          <button className="btn small" disabled={busy || !nodes.length} title="采用前只预览位置，不会保存坐标" onClick={() => run(savePositions(visiblePositions, placements))}>采用此布局</button>
        )}
        {mode === "千层饼" && (
          <label className="map-canvas-era">时代
            <select value={era} onChange={(e) => setEra(e.target.value)}>
              <option value="">全部时代</option>
              {[...new Set([...eras, ...nodes.flatMap(nodeEra)])].map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
      </div>

      {mapName !== null && (
        <div className="map-canvas-overlays" role="group" aria-label="地域引用叠加">
          <span className="hint">叠加引用</span>
          <button className={`btn small ${overlay.people ? "primary" : ""}`} aria-pressed={overlay.people} onClick={() => toggleOverlay("people")}>人物</button>
          <button className={`btn small ${overlay.organizations ? "primary" : ""}`} aria-pressed={overlay.organizations} onClick={() => toggleOverlay("organizations")}>组织</button>
          <button className={`btn small ${overlay.story ? "primary" : ""}`} aria-pressed={overlay.story} onClick={() => toggleOverlay("story")}>矛盾 / 单元 / 里程碑 / 伏笔 / 隐秘</button>
        </div>
      )}

      <div className="map-canvas-actions">
        <span className="hint" role="status">{loading ? "正在读取画布…" : busy ? "正在保存…" : layout ? `已保存 · ${nodes.length} 个节点` : "画布未载入"}</span>
        <div className="page-actions">
          <button className="btn small" disabled={busy || loading || selected === null} onClick={() => selected && run(savePositions(placements.map((place) => place.name === selected ? { ...place, pinned: !place.pinned } : place)))}>{placements.some((place) => place.name === selected && place.pinned) ? "取消固定" : "固定选中"}</button>
          <button className="btn small" disabled={busy || loading || nodes.length === 0} onClick={() => void arrange(false)}>自动整理</button>
          <button className="btn small" disabled={busy || loading || nodes.length === 0} onClick={() => void arrange(true)}>全部重新布局</button>
          <button className="btn small" disabled={busy || !undo} onClick={() => undo && run(savePositions(undo))}>撤销布局</button>
          <button className="btn primary small" disabled={busy || loading || nodes.length < 2} onClick={() => openRelation(null)}>连一条关系</button>
          {mapName === null && <button className="btn small" disabled={busy || loading || nodes.length < 2} onClick={onCreateTransition}>新建转场</button>}
        </div>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
      {backgroundLabel && <div className="hint-box map-canvas-background-warning">{backgroundLabel}</div>}
      {mode === "千丝万缕" && sharedPairs.length > 0 && <p className="hint">已标出共用人物、组织和情节引用；这些连线是档案引用的临时预览。</p>}
      {mode === "莲花" && <p className="hint">中心节点按地图档案的「核心」作用或现有地图顺序推定；采用后才写入位置。</p>}
      {mode === "千层饼" && <p className="hint">按档案中的时代引用突出地图 / 地域；没有时代引用的节点会淡化显示。</p>}

      <div className="map-canvas-scroll">
        <svg className="map-semantic-graph" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="group" aria-label="空间关系画布">
          <defs><marker id={`${markerId}-arrow`} markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 Z" fill="var(--ink-soft)" /></marker></defs>
          {backgroundUrl && <image href={backgroundUrl} x="0" y="0" width={width} height={height} preserveAspectRatio="xMidYMid slice" opacity="0.2" onError={() => setBackgroundFailed(true)} />}
          {sharedPairs.map((pair) => {
            const a = visibleByName.get(pair.from); const b = visibleByName.get(pair.to);
            if (!a || !b) return null;
            return <g key={`${pair.from}:${pair.to}`} className="map-canvas-shared-link" pointerEvents="none">
              <path d={edgePath(a, b, -34)} />
              <title>{pair.refs.join("、")}</title>
            </g>;
          })}
          {mapName !== null && [...containedRegions].map((name) => {
            const region = visibleByName.get(name);
            if (!region) return null;
            return <g key={`contains-${name}`} className="map-canvas-containment" pointerEvents="none">
              <path d={`M ${width / 2} 66 L ${region.x} ${region.y - 38}`} markerEnd={`url(#${markerId}-arrow)`} />
              <text x={(width / 2 + region.x) / 2} y={(region.y + 26) / 2} textAnchor="middle">包含</text>
            </g>;
          })}
          {relations.map(({ relation, index }) => {
            const a = visibleByName.get(relation.from); const b = visibleByName.get(relation.to);
            if (!a || !b) return null;
            const path = edgePath(a, b, -24);
            return <g key={`relation-${index}`} className={`map-canvas-edge ${missingRelations.some((item) => item.index === index) ? "dangling" : ""} ${mode === "莲花" && (relation.from === coreName || relation.to === coreName) ? "core-spoke" : ""}`}>
              <path d={path} markerEnd={relationIsDirected(relation) ? `url(#${markerId}-arrow)` : undefined} />
              <path className="map-canvas-edge-hit" d={path} role="button" tabIndex={0} aria-label={`编辑关系：${relation.from} ${relation.kind} ${relation.to}`} onClick={() => openRelation(index, relation)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openRelation(index, relation); }} />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 28} textAnchor="middle" className="map-canvas-edge-label">{relation.kind}</text>
            </g>;
          })}
          {transitions.map((transition, index) => {
            const a = visibleByName.get(transition.from); const b = visibleByName.get(transition.to);
            if (!a || !b) return null;
            const path = edgePath(a, b, 30);
            return <g key={`transition-${index}`} className={`map-canvas-transition ${returningTransitionIndices.has(index) ? "return-loop" : ""}`}>
              <path d={path} markerEnd={`url(#${markerId}-arrow)`} />
              <path className="map-canvas-edge-hit" d={path} role="button" tabIndex={0} aria-label={`编辑转场：${transition.from} 到 ${transition.to}`} onClick={() => onEditTransition(transition, index)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onEditTransition(transition, index); }} />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 48} textAnchor="middle" className="map-canvas-transition-label">转场</text>
            </g>;
          })}
          {activeNodes.map((node) => {
            const actual = positions.get(node.name) ?? missingPositionByName.get(node.name);
            const display = visibleByName.get(node.name);
            if (!actual || !display) return null;
            const refs = nodeReferences(node, mainlineMilestones);
            const attachments = [
              ...(overlay.people ? refs.people.map((name) => ({ kind: "人物", name })) : []),
              ...(overlay.organizations ? refs.organizations.map((name) => ({ kind: "组织", name })) : []),
            ];
            const chips = [
              ...(mode === "莲花" && node.name === coreName && node.map?.coreSecret ? [`秘密 · ${node.map.coreSecret}`] : []),
              ...(overlay.story ? refs.milestones : []),
              ...(overlay.story ? refs.secrets : []),
              ...(overlay.story ? refs.story.map((name) => `情节 · ${name}`) : []),
            ].slice(0, 5);
            const isSelected = selected === node.name;
            const unrelatedToEra = mode === "千层饼" && !!era && !inEra(node);
            const summary = node.missing ? "引用失效 · 默认节点" : node.map?.role ?? node.region?.plotRole ?? (node.region ? "地域" : "地图");
            return <g key={`${node.missing ? "missing" : "node"}-${node.name}`} transform={`translate(${display.x}, ${display.y})`} className={`map-canvas-node ${node.missing ? "missing" : ""} ${isSelected ? "selected" : ""} ${unrelatedToEra ? "dimmed" : ""}`} role={node.missing ? "img" : "button"} tabIndex={node.missing ? -1 : 0} aria-label={`${node.name}${node.missing ? "，引用失效" : actual.pinned ? "，已固定" : ""}`} aria-pressed={node.missing ? undefined : isSelected}
              onPointerDown={node.missing ? undefined : (e) => startDrag(e, actual)} onPointerMove={node.missing ? undefined : moveDrag} onPointerUp={node.missing ? undefined : endDrag} onPointerCancel={node.missing ? undefined : (e) => endDrag(e, true)} onLostPointerCapture={node.missing ? undefined : (e) => endDrag(e, true)}
              onDoubleClick={() => { if (node.missing) return; if (node.map && onSelectMap) onSelectMap(node.name); else editNode(node.name); }}
              onKeyDown={(e) => {
                if (node.missing) return;
                if (e.key === "F2") { e.preventDefault(); editNode(node.name); }
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected((value) => value === node.name ? null : node.name); }
                const step: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
                if (step[e.key] && layout && mode !== "莲花") { e.preventDefault(); const [dx, dy] = step[e.key]; run(savePositions(placements.map((place) => place.name === node.name ? { ...place, x: Math.min(100000, Math.max(60, place.x + dx)), y: Math.min(100000, Math.max(60, place.y + dy)) } : place))); }
              }}>
              <title>{node.name} · {summary}。方向键移动，空格选中，双击或 F2 编辑。</title>
              <rect className="map-canvas-node-shape" x="-82" y="-34" width="164" height="68" rx="14" />
              <text className="map-canvas-node-name" textAnchor="middle" y="-3">{oneLinePreview(node.name, 12)}</text>
              <text className="map-canvas-node-summary" textAnchor="middle" y="19">{oneLinePreview(summary, 18)}</text>
              {!node.missing && actual.pinned && <text className="map-canvas-pin" x="44" y="-23">固定</text>}
              {attachments.map((attachment, index) => {
                const columnX = index % 2 === 0 ? -80 : 4;
                const rowY = 52 + Math.floor(index / 2) * 24;
                return <g key={`${attachment.kind}-${attachment.name}-${index}`} className={`map-canvas-reference-node ${attachment.kind === "人物" ? "person" : "organization"}`} pointerEvents="none">
                  <path d={`M 0 34 C 0 ${rowY - 4} ${columnX + 39} ${rowY - 8} ${columnX + 39} ${rowY}`} />
                  <rect x={columnX} y={rowY} width="78" height="19" rx="7" />
                  <text x={columnX + 39} y={rowY + 13} textAnchor="middle">{oneLinePreview(`${attachment.kind === "人物" ? "人" : "组织"} · ${attachment.name}`, 9)}</text>
                  <title>{attachment.kind} · {attachment.name}</title>
                </g>;
              })}
              {chips.map((chip, index) => <text key={`${chip}-${index}`} className="map-canvas-chip" textAnchor="middle" y={54 + Math.ceil(attachments.length / 2) * 24 + index * 15}>{oneLinePreview(chip, 22)}</text>)}
            </g>;
          })}
        </svg>
      </div>

      {mapName === null && maps.length > 0 && <p className="hint">双击地图进入其地域画布；F2 或「编辑选中」可修改完整档案。</p>}
      <div className="map-canvas-footer">
        <div className="page-actions">
          <button className="btn small" disabled={!selected || busy} onClick={() => selected && editNode(selected)}>编辑选中</button>
          {selected && <span className="hint">{selected}{placements.find((place) => place.name === selected)?.pinned ? " · 已固定" : ""}</span>}
        </div>
        {missingRelations.length > 0 && (
          <div className="hint-box map-canvas-missing"><strong>失效关系仍保留</strong>{missingRelations.map(({ relation, index }) => <p key={index}><button className="link-like" onClick={() => openRelation(index, relation)}>{relation.from} · {relation.kind} · {relation.to}</button></p>)}</div>
        )}
        {mapName === null && transitions.some((item) => !nodeByName.has(item.from) || !nodeByName.has(item.to)) && (
          <div className="hint-box map-canvas-missing"><strong>失效转场仍保留</strong>{transitions.map((item, index) => (!nodeByName.has(item.from) || !nodeByName.has(item.to)) && <p key={index}><button className="link-like" onClick={() => onEditTransition(item, index)}>{item.from} → {item.to}</button></p>)}</div>
        )}
      </div>

      {!loading && nodes.length === 0 && <p className="hint-box">{mapName === null ? "还没有地图；新建地图后可以在画布中整理全书关系。" : "这张地图还没有归属地域；新建地域并选择所属地图后会出现在这里。"}</p>}
      {relationDialog && (
        <MapRelationDialog
          title={relationDialog.index === null ? "新建空间关系" : "编辑空间关系"}
          names={[...new Set([...nodes.map((node) => node.name), relationDialog.relation.from, relationDialog.relation.to])]}
          kinds={relationKinds}
          initial={relationDialog.relation}
          onClose={() => setRelationDialog(null)}
          onSave={(next) => changeRelation(relationDialog.index, next)}
          onDelete={relationDialog.index === null ? undefined : () => changeRelation(relationDialog.index, null)}
        />
      )}
    </section>
  );
}
