import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ExpectationBoard, ExpectationView } from "./types";
import {
  EXPECTATION_HORIZONS,
  EXPECTATION_HORIZON_MID,
  EXPECTATION_KINDS,
  EXPECTATION_KIND_EXPECT,
  EXPECTATION_KIND_GOAL,
  EXPECTATION_STATE_DONE,
  EXPECTATION_STATE_DROPPED,
  EXPECTATION_STATE_PARTIAL,
  EXPECTATION_STATE_PLANTED,
  EXPECTATION_STATES,
  expectationKindLabel,
  expectationOverdueChapters,
} from "./types";
import { chapterHead } from "./chapterFile";
import { errMsg } from "./util";
import { ExpectationFormDialog } from "./ExpectationDialog";

interface ExpectationBoardProps {
  project: string;
  /** 页签类别（期待｜目标）：看板只显示本类别的线，新建的类别也随它（工单 #36）。
   *  手写的未知类别归「期待感」页（与 Rust 侧计数、缺省读数一致）。 */
  kind: string;
  /** 项目章前缀，用于渲染「第N章」。 */
  chapterPrefix: string | null;
  /** 三线变了：让项目页刷新计数。 */
  onChanged: () => void;
  /** 点章名：跳到书写板块打开该章并选中引文。 */
  onOpenChapter: (ordinal: number, quote: string) => void;
}

/** 档位主名（工单 #36：行标签带含义，名字不再让人猜）。 */
const HORIZON_LABELS: Record<string, string> = { 短: "短期", 中: "中期", 长: "长期" };

/** 档位第二行小注（阈值即超期阈值，与 Rust 侧一致）。 */
function horizonSub(horizon: string): string | null {
  if (!(EXPECTATION_HORIZONS as readonly string[]).includes(horizon)) return null;
  return horizon === "短" ? `约${expectationOverdueChapters(horizon)}章内兑现` : `约${expectationOverdueChapters(horizon)}章`;
}

/** 每章一列的宽度（时间线网格的横向刻度）。 */
const COL_W = 18;
/** 一条线的高度与行间距；同一档位多条线时按泳道叠放。 */
const BAR_H = 20;
const LANE_H = 26;
const TRACK_PAD = 5;

const STATE_HINTS: Record<string, string> = {
  待埋: "先记下来、还没写进正文的线。",
  已埋: "已经写进正文，等着兑现。",
  部分兑现: "兑现了一半（阶段），还欠一个终结。",
  已兑现: "已经收干净。",
  弃用: "不打算收了（可随时改回其他状态）。",
};

interface Bar {
  view: ExpectationView;
  start: number;
  end: number;
  /** 最近一次锚点章（埋设或兑现）；未兑现的线从这里起画虚线尾巴。 */
  last: number;
  open: boolean;
}

function geometry(view: ExpectationView, axis: number): Bar | null {
  const chapters = [
    ...view.planted.map((a) => a.chapter),
    ...view.fulfilled.map((p) => p.chapter),
  ];
  if (chapters.length === 0) return null;
  const start = Math.min(...chapters);
  const last = Math.max(...chapters);
  const open = view.state === EXPECTATION_STATE_PLANTED || view.state === EXPECTATION_STATE_PARTIAL;
  return { view, start, last, end: open ? Math.max(axis, last) : last, open };
}

interface LaidBar {
  bar: Bar;
  lane: number;
}

/** 同一档位里按起点排泳道（贪心区间着色），避免多条线叠在一起。 */
function layout(bars: Bar[]): { laid: LaidBar[]; lanes: number } {
  const sorted = [...bars].sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  const laid: LaidBar[] = [];
  for (const bar of sorted) {
    let lane = laneEnds.findIndex((end) => end < bar.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.end);
    } else {
      laneEnds[lane] = bar.end;
    }
    laid.push({ bar, lane });
  }
  return { laid, lanes: Math.max(1, laneEnds.length) };
}

function barClass(view: ExpectationView): string {
  const parts = ["exp-bar"];
  if (view.kind === EXPECTATION_KIND_EXPECT) parts.push("expect");
  else if (view.kind === EXPECTATION_KIND_GOAL) parts.push("goal");
  if (view.state === EXPECTATION_STATE_DONE) parts.push("done");
  else if (view.state === EXPECTATION_STATE_DROPPED) parts.push("dropped");
  if (view.overdue) parts.push("overdue");
  return parts.join(" ");
}

/** 三线看板（工单 #7，docs/spec/期待感三线.md；工单 #36 拆页签）：时间线网格——
 *  行＝档位（短/中/长），列＝章；未兑现的线延伸到当前章，尾巴虚线，超期标红。
 *  期待感/目标两页签各挂一张，按 kind 过滤复用。 */
export default function ExpectationBoard({
  project,
  kind,
  chapterPrefix,
  onChanged,
  onOpenChapter,
}: ExpectationBoardProps) {
  const [board, setBoard] = useState<ExpectationBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBoard(await invoke<ExpectationBoard>("expectation_board", { project }));
    } catch (e) {
      setBoard(null);
      setError(`读取${expectationKindLabel(kind)}失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [project, kind]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const label = expectationKindLabel(kind);
  const goalTab = kind === EXPECTATION_KIND_GOAL;
  const items = (board?.items ?? []).filter((v) =>
    goalTab ? v.kind === EXPECTATION_KIND_GOAL : v.kind !== EXPECTATION_KIND_GOAL,
  );
  const axis = board?.maxChapter ?? 0;
  const placed = items.filter((v) => geometry(v, axis) !== null);
  const pending = items.filter((v) => geometry(v, axis) === null);
  const selectedView = items.find((v) => v.name === selected) ?? null;
  const overdueCount = items.filter((v) => v.overdue).length;
  const known = EXPECTATION_HORIZONS as readonly string[];

  // 行＝短/中/长；手写的未知档位单列一行（只提示不校验）。
  const rowDefs: { key: string; label: string; sub: string | null; bars: Bar[] }[] = [
    ...EXPECTATION_HORIZONS.map((h) => ({
      key: h as string,
      label: HORIZON_LABELS[h as string] ?? (h as string),
      sub: horizonSub(h as string),
      bars: placed
        .filter((v) => v.horizon === h)
        .map((v) => geometry(v, axis))
        .filter((b): b is Bar => b !== null),
    })),
  ];
  const otherBars = placed
    .filter((v) => !known.includes(v.horizon))
    .map((v) => geometry(v, axis))
    .filter((b): b is Bar => b !== null);
  if (otherBars.length > 0)
    rowDefs.push({ key: "其他", label: "其他档位", sub: null, bars: otherBars });
  const rows = rowDefs.map((row) => ({ ...row, ...layout(row.bars) }));

  const ticks: number[] = [];
  for (let ch = 1; ch <= axis; ch += 1) {
    if (ch === 1 || ch % 10 === 0) ticks.push(ch);
  }

  async function changeMeta(name: string, kind: string, horizon: string) {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("set_expectation_meta", { project, name, kind, horizon });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`改类别/档位失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function changeState(name: string, state: string) {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("set_expectation_state", { project, name, state });
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
    if (!window.confirm(`删除期待线「${name}」？\n（三线.yaml 里的这一条会整条删掉）`)) return;
    setBusy(true);
    try {
      await invoke("delete_expectation", { project, name });
      setSelected(null);
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function create(name: string, kind: string, horizon: string) {
    setBusy(true);
    try {
      await invoke("add_expectation", { project, name, kind, horizon });
      setCreating(false);
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`新建${label}失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>{label}看板</h2>
          <p className="hint">
            {goalTab ? "主角下一步去哪里" : "读者想知道结果"}的线，按档位铺在章节轴上：
            写作时选中正文右键「记为{label}」「兑现期待线」；
            这里看哪条线多久没推进、哪章埋的还没兑现。
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建{label}
        </button>
      </div>

      {overdueCount > 0 && (
        <div className="hint-box">有 {overdueCount} 条线超过档位阈值还没兑现，先看它们。</div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {!loading && !error && items.length === 0 && (
        <div className="empty-state">
          <p>还没有{label}。</p>
          <p className="hint">
            到「书写」板块写正文，选中一段文字右键「记为{label}」，这里就会出现它；
            <br />
            也可以先「新建{label}」把名字记下来（待埋），写作时再标注落位。
          </p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <>
          {pending.length > 0 && (
            <>
              <div className="exp-lane">
                <span className="exp-lane-label">还没落位（待埋）</span>
                {pending.map((v) => (
                  <button
                    key={v.name}
                    className={`exp-chip ${v.name === selected ? "active" : ""}`}
                    title="还没在正文里标注；标注后自动落到档位行"
                    onClick={() => setSelected(v.name)}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
              <p className="hint">
                「还没落位」＝记了名字、还没写进正文；到「书写」板块选中一段文字
                右键「记为{label}」，同名线就会落位到档位行。
              </p>
            </>
          )}

          {axis > 0 && placed.length > 0 && (
            <div className="exp-grid">
              <div className="exp-grid-labels">
                <div className="exp-tick-space" />
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="exp-row-label"
                    style={{ height: TRACK_PAD + row.lanes * LANE_H }}
                  >
                    <span>{row.label}</span>
                    {row.sub && <span className="exp-row-sub">{row.sub}</span>}
                  </div>
                ))}
              </div>
              <div className="exp-grid-scroll">
                <div className="exp-grid-canvas" style={{ width: axis * COL_W }}>
                  <div className="exp-ticks">
                    {ticks.map((ch) => (
                      <span
                        key={ch}
                        className="exp-tick"
                        style={{ left: (ch - 1) * COL_W }}
                        title={chapterHead(ch, chapterPrefix)}
                      >
                        {ch}
                      </span>
                    ))}
                  </div>
                  {rows.map((row) => (
                    <div
                      key={row.key}
                      className="exp-track"
                      style={{ height: TRACK_PAD + row.lanes * LANE_H }}
                    >
                      {row.laid.map(({ bar, lane }) => {
                          const { view } = bar;
                          const left = (bar.start - 1) * COL_W;
                          const width = (bar.end - bar.start + 1) * COL_W;
                          // 尾巴＝最近锚点之后那几列（含锚点列本身仍是实心）。
                          const tailLeft = (bar.last - bar.start + 1) * COL_W;
                          const tailWidth = (bar.end - bar.last) * COL_W;
                          const top = TRACK_PAD + lane * LANE_H;
                          const stale = [...view.planted, ...view.fulfilled].some((a) => a.stale);
                          const title = `${view.name} · ${view.kind}·${view.horizon} · ${
                            view.state
                          }${
                            view.unadvancedChapters !== null
                              ? ` · 已 ${view.unadvancedChapters} 章未推进`
                              : ""
                          }${stale ? " · 有引文失配" : ""}`;
                          return (
                            <div key={view.name}>
                              <button
                                className={`${barClass(view)} ${
                                  view.name === selected ? "selected" : ""
                                }`}
                                style={{ left, width, top }}
                                title={title}
                                onClick={() => setSelected(view.name)}
                              >
                                {bar.open && tailWidth > 0 && (
                                  <span
                                    className="exp-tail"
                                    style={{ left: tailLeft, width: tailWidth }}
                                  />
                                )}
                                <span className="exp-bar-name">{view.name}</span>
                                {[...view.planted, ...view.fulfilled].map((a, i) => (
                                  <span
                                    key={i}
                                    className={`exp-dot ${"kind" in a ? "fulfilled" : "planted"}`}
                                    style={{ left: (a.chapter - bar.start) * COL_W + COL_W / 2 }}
                                  />
                                ))}
                              </button>
                              {bar.open && view.unadvancedChapters !== null && (
                                <span
                                  className={`exp-bar-note ${view.overdue ? "danger" : ""}`}
                                  style={{ left: left + width + 6, top: top + BAR_H / 2 }}
                                >
                                  已 {view.unadvancedChapters} 章未推进
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {axis > 0 && placed.length > 0 && (
            <p className="hint">
              条越长＝欠得越久；虚线尾巴＝还没兑现、一直拖到当前第 {axis} 章。
            </p>
          )}

          {selectedView && (
            <section className="exp-detail">
              <div className="exp-detail-head">
                <h3>{selectedView.name}</h3>
                <span className="card-cat">{expectationKindLabel(selectedView.kind)}</span>
                <span className="card-cat">{selectedView.horizon}</span>
                {selectedView.overdue && (
                  <span className="card-cat danger">
                    超期 {selectedView.unadvancedChapters} 章
                  </span>
                )}
                {!selectedView.overdue && selectedView.unadvancedChapters !== null && (
                  <span className="card-cat">已 {selectedView.unadvancedChapters} 章未推进</span>
                )}
                <div className="card-actions">
                  <select
                    className="select small"
                    value={selectedView.kind}
                    disabled={busy}
                    title="类别（约定值只提示不校验）；改成另一类会换到另一个页签"
                    onChange={(e) =>
                      void changeMeta(selectedView.name, e.target.value, selectedView.horizon)
                    }
                  >
                    {!(EXPECTATION_KINDS as readonly string[]).includes(selectedView.kind) && (
                      <option value={selectedView.kind}>{expectationKindLabel(selectedView.kind)}</option>
                    )}
                    {EXPECTATION_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {expectationKindLabel(k)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select small"
                    value={selectedView.horizon}
                    disabled={busy}
                    title="档位（时间线网格的行）"
                    onChange={(e) =>
                      void changeMeta(selectedView.name, selectedView.kind, e.target.value)
                    }
                  >
                    {!known.includes(selectedView.horizon) && (
                      <option value={selectedView.horizon}>{selectedView.horizon}</option>
                    )}
                    {EXPECTATION_HORIZONS.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select small"
                    value={selectedView.state}
                    disabled={busy}
                    title="改状态（约定值只提示不校验）"
                    onChange={(e) => void changeState(selectedView.name, e.target.value)}
                  >
                    {!(EXPECTATION_STATES as readonly string[]).includes(selectedView.state) && (
                      <option value={selectedView.state}>{selectedView.state}</option>
                    )}
                    {EXPECTATION_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => void remove(selectedView.name)}
                  >
                    删除
                  </button>
                </div>
              </div>
              <p className="hint">
                {STATE_HINTS[selectedView.state] ?? "手写的状态值（只提示不校验）。"}
              </p>
              <p className="hint">
                档位阈值：
                {EXPECTATION_HORIZONS.map((h) => `${h} ${expectationOverdueChapters(h)} 章`).join(
                  " · ",
                )}
              </p>

              {selectedView.planted.map((a, i) => (
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
              {selectedView.fulfilled.map((p, i) => (
                <p key={`f${i}`} className="foreshadow-anchor">
                  <button
                    className="link-btn"
                    title="跳到书写板块这一章，选中引文"
                    onClick={() => onOpenChapter(p.chapter, p.quote)}
                  >
                    兑现于 {chapterHead(p.chapter, chapterPrefix)} · {p.kind}
                  </button>
                  {p.quote && <span className="foreshadow-quote">「{p.quote}」</span>}
                  {p.note && <span className="foreshadow-note">{p.note}</span>}
                  {p.stale && <span className="card-cat danger">引文失配</span>}
                </p>
              ))}
              {selectedView.planted.length === 0 && selectedView.fulfilled.length === 0 && (
                <p className="hint">还没落位：到正文里选中文字右键「记为{label}」。</p>
              )}
            </section>
          )}
        </>
      )}

      {creating && (
        <ExpectationFormDialog
          title={`新建${label}（待埋）`}
          hint="只是先记下这条线；写作时在正文里选中文字标注，它就会升为「已埋」并落到对应档位行。"
          initial=""
          fixedKind={kind}
          initialHorizon={EXPECTATION_HORIZON_MID}
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={(name, kind, horizon) => void create(name, kind, horizon)}
        />
      )}
    </div>
  );
}
