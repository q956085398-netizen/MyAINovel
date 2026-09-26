import { useSearchDestination } from "./globalSearchNavigation";
import { contentCardDomId } from "./contentSurfaceState";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ForeshadowView } from "./types";
import {
  FORESHADOW_OVERDUE_CHAPTERS,
  FORESHADOW_STATES,
  FORESHADOW_STATE_PLANTED,
  FORESHADOW_STATE_PARTIAL,
} from "./types";
import { chapterHead } from "./chapterFile";
import { errMsg } from "./util";
import { ForeshadowNameDialog } from "./ForeshadowDialog";

interface ForeshadowBoardProps {
  project: string;
  /** 项目章前缀，用于渲染「第N章」。 */
  chapterPrefix: string | null;
  /** 伏笔变了：让项目页刷新计数。 */
  onChanged: () => void;
  /** 点章名：跳到书写板块打开该章并选中引文。 */
  onOpenChapter: (ordinal: number, quote: string) => void;
}

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

/** 伏笔看板（工单 #6，docs/spec/伏笔系统.md）：长期管理半区——
 *  按状态分组、超期统计（埋了 N 章未收的清单）、引文失配提示。 */
export default function ForeshadowBoard({
  project,
  chapterPrefix,
  onChanged,
  onOpenChapter,
}: ForeshadowBoardProps) {
  const [views, setViews] = useState<ForeshadowView[]>([]);
  const destination = useSearchDestination();
  useEffect(() => {
    if (destination?.hit.kind !== "伏笔" || destination.hit.projectDir !== project) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(contentCardDomId(`${project}/伏笔/${destination.hit.title}`));
      card?.scrollIntoView({ block: "center" }); card?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [destination, project, views]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setViews(await invoke<ForeshadowView[]>("foreshadow_board", { project }));
    } catch (e) {
      setViews([]);
      setError(`读取伏笔失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function changeState(name: string, state: string) {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("set_foreshadow_state", { project, name, state });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`改状态失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (busy) return;
    if (!window.confirm(`删除伏笔「${name}」？\n（伏笔.yaml 里的这一条会整条删掉）`)) return;
    setBusy(true);
    try {
      await invoke("delete_foreshadow", { project, name });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function create(name: string) {
    setBusy(true);
    try {
      await invoke("add_foreshadow", { project, name });
      setCreating(false);
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`新建伏笔失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const overdueCount = views.filter((v) => v.overdue).length;
  // 五态各一组；手写的不在五态内的状态值也列出来（只提示不校验）。
  const knownStates = FORESHADOW_STATES as readonly string[];
  const groups = [
    ...FORESHADOW_STATES.map((state) => ({
      label: state as string,
      hint: STATE_HINTS[state],
      items: views.filter((v) => v.state === state).sort(groupSort(state)),
    })),
    {
      label: "其他状态",
      hint: "伏笔.yaml 里手写的状态不在五态内——选一个五态值即可归组。",
      items: views
        .filter((v) => !knownStates.includes(v.state))
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>伏笔看板</h2>
          <p className="hint">
            长期线索按状态管理：写作时选中正文右键设为伏笔/回收伏笔；这里看谁埋了太久没收。
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建伏笔
        </button>
      </div>

      {overdueCount > 0 && (
        <div className="hint-box">
          有 {overdueCount} 条伏笔埋了 {FORESHADOW_OVERDUE_CHAPTERS} 章以上还没收，先看它们。
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {!loading && !error && views.length === 0 && (
        <div className="empty-state">
          <p>还没有伏笔。</p>
          <p className="hint">
            到「书写」里选中一段正文右键「设为伏笔」，这里就会出现它；
            <br />
            也可以先「新建伏笔」记下名字（待埋），写作时再标注。
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.label} className="foreshadow-group">
          <h3 className="foreshadow-group-head">
            {group.label}
            <span className="foreshadow-group-count">{group.items.length}</span>
            <span className="hint">{group.hint}</span>
          </h3>
          <div className="card-list">
            {group.items.map((v) => {
              // 手写的状态值不在五态内：只提示不校验，原样列出让人改回来。
              const unknownState = !(FORESHADOW_STATES as readonly string[]).includes(v.state);
              return (
                <div key={v.name} id={contentCardDomId(`${project}/伏笔/${v.name}`)} tabIndex={-1} className={`card-item ${destination?.hit.kind === "伏笔" && destination.hit.title === v.name ? "is-search-hit" : ""}`}>
                  <div className="card-title-row">
                    <span className="card-title static">{v.name}</span>
                    {v.overdue && (
                      <span className="card-cat danger">超期 {v.uncollectedChapters} 章</span>
                    )}
                    {!v.overdue && v.uncollectedChapters !== null && (
                      <span className="card-cat">已 {v.uncollectedChapters} 章未收</span>
                    )}
                  </div>

                  {v.planted.map((a, i) => (
                    <p key={`p${i}`} className="foreshadow-anchor">
                      <button
                        className="link-btn"
                        title="跳到书写板块这一章，选中引文"
                        onClick={() => onOpenChapter(a.chapter, a.quote)}
                      >
                        埋于 {chapterHead(a.chapter, chapterPrefix)}
                      </button>
                      {a.quote && <span className="foreshadow-quote">「{a.quote}」</span>}
                      {a.stale && <span className="card-cat danger">引文失配</span>}
                    </p>
                  ))}
                  {v.recovered.map((r, i) => (
                    <p key={`r${i}`} className="foreshadow-anchor">
                      <button
                        className="link-btn"
                        title="跳到书写板块这一章，选中引文"
                        onClick={() => onOpenChapter(r.chapter, r.quote)}
                      >
                        收于 {chapterHead(r.chapter, chapterPrefix)} · {r.kind}
                      </button>
                      {r.quote && <span className="foreshadow-quote">「{r.quote}」</span>}
                      {r.note && <span className="foreshadow-note">{r.note}</span>}
                      {r.stale && <span className="card-cat danger">引文失配</span>}
                    </p>
                  ))}
                  {v.planted.length === 0 && v.recovered.length === 0 && (
                    <p className="hint">还没有埋设与回收记录。</p>
                  )}

                  <div className="card-actions">
                    <select
                      className="select small"
                      value={v.state}
                      disabled={busy}
                      title="改状态（约定值只提示不校验）"
                      onChange={(e) => void changeState(v.name, e.target.value)}
                    >
                      {unknownState && <option value={v.state}>{v.state}</option>}
                      {FORESHADOW_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button className="btn small danger" disabled={busy} onClick={() => void remove(v.name)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {creating && (
        <ForeshadowNameDialog
          title="新建伏笔（待埋）"
          label="伏笔名"
          hint="只是先记下这条线索；写作时在正文里选中文字标注，它就会升为「已埋」。"
          initial=""
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => void create(name)}
        />
      )}
    </div>
  );
}
