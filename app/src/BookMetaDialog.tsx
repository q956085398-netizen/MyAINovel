import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BookMeta } from "./types";
import { errMsg } from "./util";

interface BookMetaDialogProps {
  mdPath: string;
  initial: BookMeta;
  warning?: string;
  onClose: () => void;
  onSaved: (meta: BookMeta) => void;
}

/** 书级资料（设计共识 §四）：书名/成绩/简介/金手指＋章前缀模板。
 *  保存写入同名 .yaml（双文件制，懒生成）。 */
export default function BookMetaDialog({
  mdPath,
  initial,
  warning,
  onClose,
  onSaved,
}: BookMetaDialogProps) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [score, setScore] = useState(initial.score ?? "");
  const [summary, setSummary] = useState(initial.summary ?? "");
  const [goldenFinger, setGoldenFinger] = useState(initial.goldenFinger ?? "");
  const [chapterPrefix, setChapterPrefix] = useState(initial.chapterPrefix ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    const meta: BookMeta = {
      title: title.trim() || null,
      score: score.trim() || null,
      summary: summary.trim() || null,
      goldenFinger: goldenFinger.trim() || null,
      chapterPrefix: chapterPrefix.trim() || null,
    };
    try {
      await invoke("save_book_meta", { mdPath, meta });
      onSaved(meta);
    } catch (e) {
      window.alert(`元数据保存失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <h2>书级资料</h2>
        {warning && <div className="error-box">{warning}</div>}
        <label>
          书名
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          成绩
          <input
            value={score}
            onChange={(e) => setScore(e.target.value)}
            placeholder="如：均订、月票、完结字数"
          />
        </label>
        <label>
          简介
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="一两句话讲这本书卖什么"
          />
        </label>
        <label>
          金手指
          <input
            value={goldenFinger}
            onChange={(e) => setGoldenFinger(e.target.value)}
            placeholder="主角的超常能力或信息优势"
          />
        </label>
        <label>
          章前缀模板
          <input
            value={chapterPrefix}
            onChange={(e) => setChapterPrefix(e.target.value)}
            placeholder="第{n}章（{n} 为章号占位）"
          />
        </label>
        <p className="hint">保存写入同目录同名 .yaml，正文不动；其余字段以后随拆随补。</p>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
