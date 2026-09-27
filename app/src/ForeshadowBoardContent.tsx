import { contentCardDomId } from "./contentSurfaceState";
import { chapterHead } from "./chapterFile";
import PendingZone from "./PendingZone";
import { splitForeshadowViews } from "./foreshadowBoardModel";
import type { ForeshadowView } from "./types";
import {
  FORESHADOW_STATES,
  FORESHADOW_STATE_PARTIAL,
  FORESHADOW_STATE_PLANTED,
} from "./types";

const STATE_HINTS: Record<string, string> = {
  待埋: "先记下来、还没写进正文的线索。",
  已埋: "已经写进正文，等着回收。",
  部分收: "收了一半（阶段回收），还欠一个终结。",
  已收: "已经彻底回收。",
  弃用: "不打算收了（可随时改回其他状态）。",
};

function groupSort(state: string) {
  return (a: ForeshadowView, b: ForeshadowView) => {
    if (state === FORESHADOW_STATE_PLANTED || state === FORESHADOW_STATE_PARTIAL) {
      const ua = a.uncollectedChapters ?? -1;
      const ub = b.uncollectedChapters ?? -1;
      if (ua !== ub) return ub - ua;
    }
    return a.name.localeCompare(b.name, "zh");
  };
}

interface ForeshadowBoardContentProps {
  project: string;
  chapterPrefix: string | null;
  views: ForeshadowView[];
  busy: boolean;
  searchHitName: string | null;
  onOpenChapter: (ordinal: number, quote: string) => void;
  onChangeState: (name: string, state: string) => void;
  onChangePending: (name: string, pending: boolean) => void;
  onRemove: (name: string) => void;
}

/** 顶部待打磨便笺和普通状态分组共用一张完整伏笔卡。 */
export default function ForeshadowBoardContent({
  project,
  chapterPrefix,
  views,
  busy,
  searchHitName,
  onOpenChapter,
  onChangeState,
  onChangePending,
  onRemove,
}: ForeshadowBoardContentProps) {
  const { pending, ordinary } = splitForeshadowViews(views);
  const knownStates = FORESHADOW_STATES as readonly string[];
  const groups = [
    ...FORESHADOW_STATES.map((state) => ({
      label: state as string,
      hint: STATE_HINTS[state],
      items: ordinary.filter((view) => view.state === state).sort(groupSort(state)),
    })),
    {
      label: "其他状态",
      hint: "伏笔.yaml 里手写的状态不在五态内——选一个五态值即可归组。",
      items: ordinary
        .filter((view) => !knownStates.includes(view.state))
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    },
  ].filter((group) => group.items.length > 0);

  const renderCard = (view: ForeshadowView) => {
    const unknownState = !knownStates.includes(view.state);
    const searchHit = searchHitName === view.name;
    return (
      <div
        key={view.name}
        id={contentCardDomId(`${project}/伏笔/${view.name}`)}
        tabIndex={-1}
        className={`card-item ${view.pending ? "is-pending " : ""}${searchHit ? "is-search-hit" : ""}`}
      >
        <div className="card-title-row">
          <span className="card-title static">{view.name}</span>
          <span className="card-cat">{view.state}</span>
          {view.overdue && (
            <span className="card-cat danger">超期 {view.uncollectedChapters} 章</span>
          )}
          {!view.overdue && view.uncollectedChapters !== null && (
            <span className="card-cat">已 {view.uncollectedChapters} 章未收</span>
          )}
        </div>

        {view.planted.map((anchor, index) => (
          <p key={`p${index}`} className="foreshadow-anchor">
            <button
              className="link-btn"
              title="跳到书写板块这一章，选中引文"
              onClick={() => onOpenChapter(anchor.chapter, anchor.quote)}
            >
              埋于 {chapterHead(anchor.chapter, chapterPrefix)}
            </button>
            {anchor.quote && <span className="foreshadow-quote">「{anchor.quote}」</span>}
            {anchor.stale && <span className="card-cat danger">引文失配</span>}
          </p>
        ))}
        {view.recovered.map((recovery, index) => (
          <p key={`r${index}`} className="foreshadow-anchor">
            <button
              className="link-btn"
              title="跳到书写板块这一章，选中引文"
              onClick={() => onOpenChapter(recovery.chapter, recovery.quote)}
            >
              收于 {chapterHead(recovery.chapter, chapterPrefix)} · {recovery.kind}
            </button>
            {recovery.quote && <span className="foreshadow-quote">「{recovery.quote}」</span>}
            {recovery.note && <span className="foreshadow-note">{recovery.note}</span>}
            {recovery.stale && <span className="card-cat danger">引文失配</span>}
          </p>
        ))}
        {view.planted.length === 0 && view.recovered.length === 0 && (
          <p className="hint">还没有埋设与回收记录。</p>
        )}

        <div className="card-actions">
          <select
            className="select small"
            value={view.state}
            disabled={busy}
            title="改状态（约定值只提示不校验）"
            onChange={(event) => onChangeState(view.name, event.target.value)}
          >
            {unknownState && <option value={view.state}>{view.state}</option>}
            {FORESHADOW_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          <button
            className={`btn small ${view.pending ? "primary" : ""}`}
            disabled={busy}
            title={view.pending ? "整理完成后回到原业务状态分组" : "移到伏笔页顶部的待打磨区"}
            onClick={() => onChangePending(view.name, !view.pending)}
          >
            {view.pending ? "整理完成" : "待打磨"}
          </button>
          <button className="btn small danger" disabled={busy} onClick={() => onRemove(view.name)}>
            删除
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <PendingZone
        label="待打磨的伏笔"
        count={pending.length}
        hint="完整保留名称、状态、埋设与回收记录；整理完成后回到原状态分组。"
      >
        <div className="card-list">{pending.map(renderCard)}</div>
      </PendingZone>
      {groups.map((group) => (
        <section key={group.label} className="foreshadow-group">
          <h3 className="foreshadow-group-head">
            {group.label}
            <span className="foreshadow-group-count">{group.items.length}</span>
            <span className="hint">{group.hint}</span>
          </h3>
          <div className="card-list">{group.items.map(renderCard)}</div>
        </section>
      ))}
    </>
  );
}
