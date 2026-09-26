import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { IdeationOverview, IdeationOverviewItem } from "./types";
import { selectOverviewQuestion } from "./ideationGuidance";
import { errMsg } from "./util";
import "./IdeationHome.css";

const DISMISSED_KEY = "gongbi.ideation.dismissed-questions";
const QUESTION_EDITS_KEY = "gongbi.ideation.question-edits";

function readProjectPreference<T>(
  key: string,
  project: string,
  normalize: (value: unknown) => T,
): T {
  try {
    const stored = localStorage.getItem(`${key}.${project}`);
    return normalize(stored ? JSON.parse(stored) : null);
  } catch {
    return normalize(null);
  }
}

function writeProjectPreference(key: string, project: string, value: unknown): void {
  try {
    localStorage.setItem(`${key}.${project}`, JSON.stringify(value));
  } catch {
    // 偏好写入失败时，本次交互仍留在组件状态中。
  }
}

function readDismissed(project: string): string[] {
  return readProjectPreference(DISMISSED_KEY, project, (value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
}

function readQuestionEdits(project: string): Record<string, string> {
  return readProjectPreference(QUESTION_EDITS_KEY, project, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  });
}

function SummaryList({
  items,
  empty,
  onOpen,
}: {
  items: IdeationOverviewItem[];
  empty: string;
  onOpen: (tab: string) => void;
}) {
  if (items.length === 0) return <p className="hint">{empty}</p>;
  return (
    <div className="overview-link-list">
      {items.map((item) => (
        <button key={`${item.tab}:${item.name}`} onClick={() => onOpen(item.tab)}>
          <strong>{item.name}</strong>
          {item.summary && <span>{item.summary}</span>}
        </button>
      ))}
    </div>
  );
}

export default function IdeationHome({
  project,
  onOpen,
}: {
  project: string;
  onOpen: (tab: string) => void;
}) {
  const [overview, setOverview] = useState<IdeationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed(project));
  const [questionEdits, setQuestionEdits] = useState(() => readQuestionEdits(project));

  useEffect(() => {
    setDismissed(readDismissed(project));
    setQuestionEdits(readQuestionEdits(project));
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    void invoke<IdeationOverview>("read_ideation_overview", { project })
      .then((value) => {
        if (!cancelled) setOverview(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(`读取构思首页失败：${errMsg(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (error) return <div className="error-box">{error}</div>;
  if (!overview) return <p className="hint">正在整理现有构思……</p>;

  const question = selectOverviewQuestion(overview, dismissed);
  const questionText = question ? questionEdits[question.id] ?? question.text : "";
  const dismissQuestion = () => {
    if (!question) return;
    const next = [...dismissed, question.id];
    writeProjectPreference(DISMISSED_KEY, project, next);
    setDismissed(next);
  };
  const editQuestion = (text: string) => {
    if (!question) return;
    const next = { ...questionEdits, [question.id]: text };
    setQuestionEdits(next);
    writeProjectPreference(QUESTION_EDITS_KEY, project, next);
  };

  return (
    <div className="ideation-overview">
      <div className="pane-head">
        <div>
          <h2>构思首页</h2>
          <p className="hint">从现有项目文件即时整理，不复制内容，也不计算完成度。</p>
        </div>
      </div>

      {question && (
        <div className="overview-question">
          <div>
            <span>想一想</span>
            <textarea
              className="overview-question-input"
              aria-label="改写构思首页引导问题"
              rows={2}
              value={questionText}
              onChange={(event) => editQuestion(event.target.value)}
            />
          </div>
          <div className="overview-question-actions">
            <button className="btn" onClick={() => onOpen(question.tab)}>去看看</button>
            <button className="link-like" onClick={dismissQuestion}>关闭</button>
          </div>
        </div>
      )}

      <div className="overview-grid">
        <section className="overview-card overview-card-wide">
          <button className="overview-card-title" onClick={() => onOpen("大纲")}>作品骨架</button>
          <p className={overview.premise ? "" : "hint"}>
            {overview.premise ?? "还没有写下作品一句话。"}
          </p>
          <p className={overview.mainline ? "overview-secondary" : "hint"}>
            {overview.mainline ? `主线：${overview.mainline}` : "主线还在生长。"}
          </p>
        </section>

        <section className="overview-card">
          <button className="overview-card-title" onClick={() => onOpen("读者遐想（类型圈）")}>
            读者遐想（类型圈）
          </button>
          {overview.readerImaginations.length > 0 ? (
            <div className="overview-tags">
              {overview.readerImaginations.map((item) => <span key={item}>{item}</span>)}
            </div>
          ) : <p className="hint">还没有写下读者期待。</p>}
        </section>

        <section className="overview-card">
          <button className="overview-card-title" onClick={() => onOpen("人物")}>人物</button>
          <SummaryList items={overview.characters} empty="人物还未登场。" onOpen={onOpen} />
        </section>

        <section className="overview-card">
          <button className="overview-card-title" onClick={() => onOpen("地图")}>地图</button>
          <SummaryList items={overview.maps} empty="故事空间还未展开。" onOpen={onOpen} />
        </section>

        <section className="overview-card">
          <h3>待处理内容</h3>
          <SummaryList items={overview.pending} empty="眼下没有待打磨内容。" onOpen={onOpen} />
        </section>

        <section className="overview-card overview-card-wide">
          <button className="overview-card-title" onClick={() => onOpen("大纲")}>尚未解决</button>
          {overview.unresolved.length > 0 ? (
            <ul>{overview.unresolved.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : <p className="hint">大纲里还没有记下未解问题。</p>}
        </section>
      </div>
    </div>
  );
}
