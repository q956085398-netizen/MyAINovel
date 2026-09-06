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
 *  保存写入同名 .yaml（双文件制，懒生成；Rust 侧合并保留未知键）。 */
export default function BookMetaDialog({
  mdPath,
  initial,
  warning,
  onClose,
  onSaved,
}: BookMetaDialogProps) {
  const [form, setForm] = useState<BookMeta>({ ...initial });
  const [saving, setSaving] = useState(false);

  function setField(key: keyof BookMeta, value: string) {
    setForm((f) => ({ ...f, [key]: value || null }));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    const trimmed = (s: string | null): string | null => {
      const t = s?.trim();
      return t ? t : null;
    };
    const meta: BookMeta = {
      title: trimmed(form.title),
      trackRecord: trimmed(form.trackRecord),
      summary: trimmed(form.summary),
      goldenFinger: trimmed(form.goldenFinger),
      chapterPrefix: trimmed(form.chapterPrefix),
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
          <input value={form.title ?? ""} onChange={(e) => setField("title", e.target.value)} />
        </label>
        <label>
          成绩
          <input
            value={form.trackRecord ?? ""}
            onChange={(e) => setField("trackRecord", e.target.value)}
            placeholder="如：均订、月票、完结字数"
          />
        </label>
        <label>
          简介
          <textarea
            value={form.summary ?? ""}
            onChange={(e) => setField("summary", e.target.value)}
            placeholder="一两句话讲这本书卖什么"
          />
        </label>
        <label>
          金手指
          <input
            value={form.goldenFinger ?? ""}
            onChange={(e) => setField("goldenFinger", e.target.value)}
            placeholder="主角的超常能力或信息优势"
          />
        </label>
        <label>
          章前缀模板
          <input
            value={form.chapterPrefix ?? ""}
            onChange={(e) => setField("chapterPrefix", e.target.value)}
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
