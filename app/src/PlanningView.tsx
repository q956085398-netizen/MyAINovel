import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MainlinePlan, Milestone, Outline, SaveResult, StoryLine } from "./types";
import { emptyMilestone, emptyStoryLine } from "./types";
import { errMsg, splitList } from "./util";
import MarkdownEditor from "./MarkdownEditor";

const OUTLINE_TEMPLATE = "## 立意\n\n## 主线总览\n\n## 阶段构想\n\n## 尚未解决\n";

interface PlanningViewProps {
  project: string;
  unitNames: string[];
}

/** 大纲纸面与主线图：自由文本和结构化里程碑各自只有一份来源。 */
export default function PlanningView({ project, unitNames }: PlanningViewProps) {
  const [outline, setOutline] = useState<Outline>({ body: "", fingerprint: null });
  const [plan, setPlan] = useState<MainlinePlan>({ lines: [], fingerprint: null });
  const [loading, setLoading] = useState(true);
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);
  const [savingOutline, setSavingOutline] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [outlineConflict, setOutlineConflict] = useState(false);
  const [planConflict, setPlanConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextOutline, nextPlan] = await Promise.all([
          invoke<Outline>("read_outline", { project }),
          invoke<MainlinePlan>("read_mainlines", { project }),
        ]);
        if (!cancelled) {
          setOutline(nextOutline);
          setPlan(nextPlan);
          setOutlineDirty(false);
          setPlanDirty(false);
        }
      } catch (e) {
        if (!cancelled) setError(`读取规划失败：${errMsg(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  async function saveOutline(force = false) {
    if (savingOutline) return;
    setSavingOutline(true);
    try {
      const result = await invoke<SaveResult>("save_outline", { project, outline, force });
      if (result.status === "conflict") {
        setOutlineConflict(true);
        return;
      }
      setOutline((current) => ({ ...current, fingerprint: result.fingerprint }));
      setOutlineConflict(false);
      setOutlineDirty(false);
    } catch (e) {
      window.alert(`保存大纲失败：${errMsg(e)}`);
    } finally {
      setSavingOutline(false);
    }
  }

  async function reloadOutline() {
    try {
      setOutline(await invoke<Outline>("read_outline", { project }));
      setOutlineDirty(false);
      setOutlineConflict(false);
    } catch (e) {
      window.alert(`重新读取大纲失败：${errMsg(e)}`);
    }
  }

  async function savePlan(force = false) {
    if (savingPlan) return;
    setSavingPlan(true);
    try {
      const result = await invoke<SaveResult>("save_mainlines", { project, plan, force });
      if (result.status === "conflict") {
        setPlanConflict(true);
        return;
      }
      setPlan((current) => ({ ...current, fingerprint: result.fingerprint }));
      setPlanConflict(false);
      setPlanDirty(false);
    } catch (e) {
      window.alert(`保存主线失败：${errMsg(e)}`);
    } finally {
      setSavingPlan(false);
    }
  }

  async function reloadPlan() {
    try {
      setPlan(await invoke<MainlinePlan>("read_mainlines", { project }));
      setPlanDirty(false);
      setPlanConflict(false);
    } catch (e) {
      window.alert(`重新读取主线失败：${errMsg(e)}`);
    }
  }

  function updateLine(index: number, next: StoryLine) {
    setPlan((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? next : line)),
    }));
    setPlanDirty(true);
  }

  function updateMilestone(lineIndex: number, milestoneIndex: number, next: Milestone) {
    const line = plan.lines[lineIndex];
    updateLine(lineIndex, {
      ...line,
      milestones: line.milestones.map((milestone, i) => (i === milestoneIndex ? next : milestone)),
    });
  }

  function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  if (loading) return <p className="hint">正在读取规划……</p>;

  return (
    <div className="planning-pane">
      {error && <div className="error-box">{error}</div>}

      <section className="outline-paper">
        <div className="pane-head">
          <div>
            <h2>大纲</h2>
            <p className="hint">自由写下这本书为何向前、将走到哪里。它不重复主线里的里程碑卡。</p>
          </div>
          <button
            className="btn primary"
            disabled={savingOutline || !outlineDirty}
            onClick={() => void saveOutline()}
          >
            {savingOutline ? "保存中…" : outlineDirty ? "保存大纲" : "已保存"}
          </button>
        </div>
        {!outline.body && (
          <button
            className="btn small"
            onClick={() => {
              setOutline({ body: OUTLINE_TEMPLATE, fingerprint: outline.fingerprint });
              setOutlineDirty(true);
            }}
          >
            使用轻模板
          </button>
        )}
        <MarkdownEditor
          value={outline.body}
          onChange={(body) => {
            setOutline((current) => ({ ...current, body }));
            setOutlineDirty(true);
            setOutlineConflict(false);
          }}
          height="360px"
        />
        {outlineConflict && (
          <div className="conflict-box">
            磁盘上的大纲已被外部修改。请重新读取，或确认以当前内容覆盖。
            <div className="conflict-actions">
              <button className="btn small" onClick={() => void reloadOutline()}>重新读取</button>
              <button className="btn small" onClick={() => void saveOutline(true)}>确认覆盖</button>
            </div>
          </div>
        )}
        <p className="hint">文件：构思/大纲.md；提示标题可删、可改，也可以从空白开始。</p>
      </section>

      <section className="mainline-board">
        <div className="pane-head">
          <div>
            <h2>主线图</h2>
            <p className="hint">从上到下是作者亲自确定的叙事次序；关联单元只作定位，不会改动顺序。</p>
          </div>
          <button
            className="btn primary"
            disabled={savingPlan || !planDirty}
            onClick={() => void savePlan()}
          >
            {savingPlan ? "保存中…" : planDirty ? "保存主线" : "已保存"}
          </button>
        </div>

        {plan.lines.length === 0 ? (
          <div className="empty-state">
            <p>还没有情节线。</p>
            <p className="hint">先写大纲也完全可以；想画出故事脊梁时，再加一条主线。</p>
          </div>
        ) : (
          <div className="mainline-tracks">
            {plan.lines.map((line, lineIndex) => (
              <section className={`mainline-track ${line.isMain ? "is-main" : ""}`} key={lineIndex}>
                <div className="track-head">
                  <label className="field track-name">
                    {line.isMain ? "主线" : "重要情节线"}
                    <input
                      value={line.name}
                      placeholder="如：为父正名"
                      onChange={(e) => updateLine(lineIndex, { ...line, name: e.target.value })}
                    />
                  </label>
                  <div className="track-actions">
                    <button
                      className="btn small"
                      disabled={lineIndex === 0}
                      onClick={() => {
                        setPlan((current) => ({ ...current, lines: move(current.lines, lineIndex, -1) }));
                        setPlanDirty(true);
                      }}
                    >
                      上移
                    </button>
                    <button
                      className="btn small"
                      disabled={lineIndex === plan.lines.length - 1}
                      onClick={() => {
                        setPlan((current) => ({ ...current, lines: move(current.lines, lineIndex, 1) }));
                        setPlanDirty(true);
                      }}
                    >
                      下移
                    </button>
                    <button
                      className="btn small"
                      onClick={() => {
                        setPlan((current) => ({
                          ...current,
                          lines: current.lines.map((currentLine, i) => ({
                            ...currentLine,
                            isMain: i === lineIndex,
                          })),
                        }));
                        setPlanDirty(true);
                      }}
                    >
                      {line.isMain ? "当前主线" : "设为主线"}
                    </button>
                    <button
                      className="text-danger"
                      onClick={() => {
                        setPlan((current) => {
                          const lines = current.lines.filter((_, i) => i !== lineIndex);
                          if (lines.length > 0 && !lines.some((currentLine) => currentLine.isMain)) {
                            lines[0] = { ...lines[0], isMain: true };
                          }
                          return { ...current, lines };
                        });
                        setPlanDirty(true);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="milestone-stack">
                  {line.milestones.map((milestone, milestoneIndex) => (
                    <MilestoneCard
                      key={milestoneIndex}
                      milestone={milestone}
                      unitNames={unitNames}
                      onChange={(next) => updateMilestone(lineIndex, milestoneIndex, next)}
                      onMove={(direction) => updateLine(lineIndex, {
                        ...line,
                        milestones: move(line.milestones, milestoneIndex, direction),
                      })}
                      onDelete={() => updateLine(lineIndex, {
                        ...line,
                        milestones: line.milestones.filter((_, i) => i !== milestoneIndex),
                      })}
                      canMoveUp={milestoneIndex > 0}
                      canMoveDown={milestoneIndex < line.milestones.length - 1}
                    />
                  ))}
                  <button
                    className="btn add-milestone"
                    onClick={() => updateLine(lineIndex, {
                      ...line,
                      milestones: [...line.milestones, emptyMilestone()],
                    })}
                  >
                    新增里程碑
                  </button>
                </div>
              </section>
            ))}
          </div>
        )}
        <button
          className="btn primary add-line"
          onClick={() => {
            setPlan((current) => ({
              ...current,
              lines: [
                ...current.lines,
                { ...emptyStoryLine(), isMain: !current.lines.some((line) => line.isMain) },
              ],
            }));
            setPlanDirty(true);
          }}
        >
          新增情节线
        </button>
        {planConflict && (
          <div className="conflict-box">
            磁盘上的主线图已被外部修改。请重新读取，或确认以当前内容覆盖。
            <div className="conflict-actions">
              <button className="btn small" onClick={() => void reloadPlan()}>重新读取</button>
              <button className="btn small" onClick={() => void savePlan(true)}>确认覆盖</button>
            </div>
          </div>
        )}
        <p className="hint">文件：构思/主线.yaml。单元若被改名或删除，会保留引用并以提示显示。</p>
      </section>
    </div>
  );
}

interface MilestoneCardProps {
  milestone: Milestone;
  unitNames: string[];
  onChange: (milestone: Milestone) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

function MilestoneCard({
  milestone,
  unitNames,
  onChange,
  onMove,
  onDelete,
  canMoveUp,
  canMoveDown,
}: MilestoneCardProps) {
  const missingUnits = milestone.units.filter((name) => !unitNames.includes(name));
  return (
    <article className="milestone-card">
      <div className="milestone-head">
        <label className="field milestone-title">
          里程碑标题
          <input
            value={milestone.title}
            placeholder="如：得知冤案"
            onChange={(e) => onChange({ ...milestone, title: e.target.value })}
          />
        </label>
        <div className="milestone-actions">
          <button className="btn small" disabled={!canMoveUp} onClick={() => onMove(-1)}>上移</button>
          <button className="btn small" disabled={!canMoveDown} onClick={() => onMove(1)}>下移</button>
          <button className="text-danger" onClick={onDelete}>删除</button>
        </div>
      </div>
      <div className="milestone-summary">
        {milestone.change || milestone.readerFeeling || milestone.units.length > 0 ? (
          <>
            {milestone.change && <span>{milestone.change}</span>}
            {milestone.readerFeeling && <span>读者感受：{milestone.readerFeeling}</span>}
            {milestone.units.map((unit) => <span className="tag" key={unit}>{unit}</span>)}
          </>
        ) : (
          <span className="pending-mark">待落地</span>
        )}
      </div>
      {missingUnits.length > 0 && (
        <p className="soft-warning">关联的单元暂未找到：{missingUnits.join("、")}。引用已保留，不会自动修复。</p>
      )}
      <details>
        <summary>补充变化、感受与关联</summary>
        <div className="milestone-details">
          <label className="field">
            变化
            <input
              value={milestone.change ?? ""}
              placeholder="人物处境、信息、目标或主动权发生的改变"
              onChange={(e) => onChange({ ...milestone, change: e.target.value || null })}
            />
          </label>
          <label className="field">
            读者感受
            <input
              value={milestone.readerFeeling ?? ""}
              placeholder="如：不甘与期待"
              onChange={(e) => onChange({ ...milestone, readerFeeling: e.target.value || null })}
            />
          </label>
          <label className="field">
            关联单元（多个用、隔开）
            <input
              value={milestone.units.join("、")}
              placeholder="可留空；仅帮助定位"
              onChange={(e) => onChange({ ...milestone, units: splitList(e.target.value) })}
            />
          </label>
          <label className="field">
            备注
            <textarea
              rows={3}
              value={milestone.note ?? ""}
              onChange={(e) => onChange({ ...milestone, note: e.target.value || null })}
            />
          </label>
        </div>
      </details>
    </article>
  );
}
