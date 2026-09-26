import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { IdeationOverview, IdeationOverviewItem } from "./types";
import { selectOverviewQuestion } from "./ideationGuidance";
import { errMsg } from "./util";
import "./IdeationHome.css";

const DISMISSED_KEY = "gongbi.ideation.dismissed-questions";

function readDismissed(project: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(`${DISMISSED_KEY}.${project}`) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
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
  const dismissQuestion = () => {
    if (!question) return;
    const next = [...dismissed, question.id];
    localStorage.setItem(`${DISMISSED_KEY}.${project}`, JSON.stringify(next));
    setDismissed(next);
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
            <p>{question.text}</p>
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
