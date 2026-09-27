import { useState } from "react";
import type { BookHeaderValues } from "./editorRender";

interface BookHeaderDialogProps {
  initial: BookHeaderValues;
  onClose: () => void;
  onSave: (values: BookHeaderValues) => void;
}

/** 表单字段（与 editorRender HEADER_KEYS 同一套四项）。 */
const FIELDS: {
  key: keyof BookHeaderValues;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}[] = [
  { key: "title", label: "书名" },
  { key: "trackRecord", label: "成绩", placeholder: "如：均订、月票、完结字数" },
  { key: "summary", label: "简介", placeholder: "一两句话讲这本书卖什么", multiline: true },
  { key: "goldenFinger", label: "金手指", placeholder: "主角的超常能力或信息优势" },
];

/** 书档表单（工单 #38，spec 拆书保存与模板 §四）：点书档卡片标题行弹出，
 *  四项写回稿顶书档块——与光标进块直改键名行等价（文件是唯一源），
 *  走正常编辑路径（可撤销、随自动保存落盘），不碰 yaml。 */
export default function BookHeaderDialog({ initial, onClose, onSave }: BookHeaderDialogProps) {
  const [form, setForm] = useState<BookHeaderValues>({ ...initial });

  function save() {
    const trimmed = (s: string | null): string | null => (s?.trim() ? s.trim() : null);
    const values = {} as BookHeaderValues;
    for (const f of FIELDS) values[f.key] = trimmed(form[f.key]);
    onSave(values);
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <h2>书档</h2>
        {FIELDS.map((f) =>
          f.multiline ? (
            <label key={f.key}>
              {f.label}
              <textarea
                value={form[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value || null }))}
              />
            </label>
          ) : (
            <label key={f.key}>
              {f.label}
              <input
                value={form[f.key] ?? ""}
                autoFocus={f.key === "title"}
                placeholder={f.placeholder}
                onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value || null }))}
              />
            </label>
          ),
        )}
        <p className="hint">
          保存在稿顶「书档」块里（纯 markdown，纸面常驻）；与直接在正文里改
          书档文字等价。书库列表的书名/成绩列也从这里取数。
        </p>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
