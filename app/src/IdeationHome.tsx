import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IdeationOverview, IdeationOverviewItem } from "./types";
import type { ProjectTab } from "./ProjectPage";
import { errMsg } from "./util";
import { firstOpenQuestion, type IdeationQuestion } from "./ideationGuidance";
import "./IdeationHome.css";

interface IdeationHomeProps {
  project: string;
  onNavigate: (tab: ProjectTab, focus?: string | null) => void;
  onOpenMeta: () => void;
}

function itemText(item: IdeationOverviewItem): string {
  return item.detail ? `${item.name} · ${item.detail}` : item.name;
}

export default function IdeationHome({ project, onNavigate, onOpenMeta }: IdeationHomeProps) {
  const [overview, setOverview] = useState<IdeationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storageKey = `gongbi:ideation-home:dismissed:${project}`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await invoke<IdeationOverview>("read_ideation_overview", { project });
        if (!cancelled) {
          setOverview(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(`构思首页读取失败：${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const questions = useMemo<IdeationQuestion[]>(() => {
    if (!overview) return [];
    const next: IdeationQuestion[] = [];
    if (!overview.logline) next.push({ id: "logline", text: "如果只能用一句话介绍这本书，你最想让读者先记住什么？" });
    if (overview.mainlines.length === 0) next.push({ id: "mainline", text: "故事真正开始向前滚动时，第一条主线要解决什么？" });
    if (overview.characters.length === 0) next.push({ id: "characters", text: "谁最适合成为读者认识这个故事的第一扇窗？" });
    if (!overview.readerImagination) next.push({ id: "imagination", text: "读者点进这类故事时，最想看到什么？" });
    if (overview.maps.length === 0) next.push({ id: "maps", text: "故事最先在哪个地点真正发生？" });
    return next;
  }, [overview]);

  const question = firstOpenQuestion(questions, dismissed);

  function dismissQuestion(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function openItem(item: IdeationOverviewItem) {
    if (item.tab === "项目资料") {
      onOpenMeta();
      return;
    }
    onNavigate(item.tab as ProjectTab, item.focus);
  }

  if (error) return <div className="note-pane"><div className="error-box">{error}</div></div>;
  if (!overview) return <div className="note-pane"><p className="hint">正在读取构思首页……</p></div>;

  return (
    <div className="ideation-home">
      <section className="ideation-hero">
        <p className="eyebrow">构思首页</p>
        <h2>{overview.logline ?? "这本书的一句话还没写下"}</h2>
        <button className="link-btn" onClick={() => onNavigate("大纲")}>去大纲整理</button>
      </section>

      {question && (
        <section className="ideation-question">
          <div>
            <p className="eyebrow">可以想一想</p>
            <p>{question.text}</p>
          </div>
          <button className="btn" onClick={() => dismissQuestion(question.id)}>先关掉</button>
        </section>
      )}

      <div className="ideation-grid">
        <section className="ideation-card">
          <div className="ideation-card-head"><h3>主线</h3><button className="link-btn" onClick={() => onNavigate("大纲")}>打开</button></div>
          {overview.mainlines.length ? overview.mainlines.map((item) => (
            <button key={item.name} className="ideation-row" onClick={() => openItem(item)}>{itemText(item)}</button>
          )) : <p className="hint">还没有主线。</p>}
        </section>

        <section className="ideation-card">
          <div className="ideation-card-head"><h3>读者遐想（类型圈）</h3><button className="link-btn" onClick={() => onNavigate("类型圈")}>打开</button></div>
          <p className={overview.readerImagination ? "" : "hint"}>{overview.readerImagination ?? "还没有写读者想看到什么。"}</p>
        </section>

        <section className="ideation-card">
          <div className="ideation-card-head"><h3>人物</h3><button className="link-btn" onClick={() => onNavigate("人物")}>打开</button></div>
          {overview.characters.length ? overview.characters.slice(0, 6).map((item) => (
            <button key={item.name} className="ideation-row" onClick={() => openItem(item)}>{itemText(item)}</button>
          )) : <p className="hint">还没有人物卡。</p>}
        </section>

        <section className="ideation-card">
          <div className="ideation-card-head"><h3>地图</h3><button className="link-btn" onClick={onOpenMeta}>项目资料</button></div>
          {overview.maps.length ? overview.maps.map((item) => (
            <button key={item.name} className="ideation-row" onClick={() => openItem(item)}>{item.name}</button>
          )) : <p className="hint">项目资料里还没有地图名。</p>}
        </section>

        <section className="ideation-card">
          <div className="ideation-card-head"><h3>待处理内容</h3></div>
          {overview.pending.length ? overview.pending.map((item) => (
            <button key={`${item.tab}-${item.name}`} className="ideation-row" onClick={() => openItem(item)}>{itemText(item)}</button>
          )) : <p className="hint">没有标记为“待处理 / 待打磨”的内容。</p>}
        </section>

        <section className="ideation-card">
          <div className="ideation-card-head"><h3>尚未解决</h3><button className="link-btn" onClick={() => onNavigate("大纲")}>打开</button></div>
          {overview.unresolved.length ? overview.unresolved.map((item, index) => (
            <button key={`${index}-${item}`} className="ideation-row" onClick={() => onNavigate("大纲")}>{item}</button>
          )) : <p className="hint">大纲里没有列出“尚未解决”。</p>}
        </section>
      </div>
    </div>
  );
}
