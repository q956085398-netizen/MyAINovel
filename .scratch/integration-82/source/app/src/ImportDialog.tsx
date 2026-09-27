import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportEntry } from "./types";
import { CARD_CATEGORIES } from "./types";
import { errMsg, oneLinePreview } from "./util";

interface Row {
  entry: ImportEntry;
  included: boolean;
}

interface ImportDialogProps {
  libraryPath: string;
  sourcePath: string;
  initialEntries: ImportEntry[];
  onClose: () => void;
  onImported: () => void;
}

/** 导入旧「灵感.md」的第二步：预览按标签推出的归类（可逐条改类别、
 *  剔除条目），确认后逐张落盘到 灵感库/<类别>/，来源记为原文件名。
 *  原文件不动。 */
export default function ImportDialog({
  libraryPath,
  sourcePath,
  initialEntries,
  onClose,
  onImported,
}: ImportDialogProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialEntries.map((entry) => ({ entry, included: true })),
  );
  const [busy, setBusy] = useState(false);

  const includedCount = rows.filter((r) => r.included).length;

  function setCategory(idx: number, category: ImportEntry["category"]) {
    setRows((rs) =>
      rs.map((r, i) => (i === idx ? { ...r, entry: { ...r.entry, category } } : r)),
    );
  }

  function toggle(idx: number) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, included: !r.included } : r)));
  }

  async function confirmImport() {
    if (busy) return;
    const entries = rows.filter((r) => r.included).map((r) => r.entry);
    if (entries.length === 0) {
      window.alert("没有勾选任何条目。");
      return;
    }
    setBusy(true);
    try {
      const paths = await invoke<string[]>("confirm_import_inspirations", {
        root: libraryPath,
        entries,
        sourcePath,
      });
      window.alert(`已导入 ${paths.length} 张卡片到「灵感库/」。`);
      onImported();
    } catch (e) {
      window.alert(`导入失败：${errMsg(e)}`);
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>导入旧灵感</h2>
        <p className="hint" title={sourcePath}>
          来源：{sourcePath} · 共 {rows.length} 条。按 markdown 标题分节、按标签归类，
          类别可逐条改；原文件不会被改动，同名卡片自动续号。
        </p>
        <table className="trope-table">
          <thead>
            <tr>
              <th className="import-check"></th>
              <th>标题</th>
              <th>类别</th>
              <th>标签</th>
              <th>正文预览</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, included }, i) => (
              <tr key={i}>
                <td className="import-check">
                  <input type="checkbox" checked={included} onChange={() => toggle(i)} />
                </td>
                <td className="import-title" title={entry.title}>
                  {entry.title}
                </td>
                <td>
                  <select
                    value={entry.category}
                    onChange={(e) => setCategory(i, e.target.value as ImportEntry["category"])}
                  >
                    {CARD_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="import-tags">
                  {entry.tags.length > 0 ? entry.tags.join("、") : "—"}
                </td>
                <td className="import-preview" title={entry.body}>
                  {oneLinePreview(entry.body, 40) || "（无正文）"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || includedCount === 0} onClick={() => void confirmImport()}>
            导入{includedCount > 0 ? ` ${includedCount} 条` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
