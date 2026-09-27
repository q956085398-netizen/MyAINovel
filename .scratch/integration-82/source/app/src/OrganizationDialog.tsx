import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ORG_FIELDS, type OrganizationDraft } from "./socialCanvasTypes";
import { errMsg } from "./util";
import MarkdownEditor from "./MarkdownEditor";
import { dirName } from "./editorRender";

/** 组织卡和画布共用同一档案编辑入口，携带原始版本以保护外部修改。 */
export default function OrganizationDialog({ project, initial, expected, path, onClose, onSaved }: {
  project: string; initial: OrganizationDraft; expected: string | null; path?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function perform(remove = false) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (remove) await invoke("delete_organization", { project, name: draft.name, expected });
      else await invoke("save_organization", { project, draft, expected });
      onSaved();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  }
  return <div className="dialog-overlay"><form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="organization-edit-title"
    onSubmit={(e) => { e.preventDefault(); void perform(); }}>
    <h2 id="organization-edit-title">{expected ? "编辑组织" : "新建组织"}</h2>
    {error && <div className="error-box" role="alert">{error}</div>}
    <label>组织名<input autoFocus required disabled={busy || !!expected} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
    {ORG_FIELDS.map(([field, label]) => <label key={field}>{label}<input disabled={busy} value={draft[field] ?? ""} onChange={(e) => setDraft({ ...draft, [field]: e.target.value || null })} /></label>)}
    <label>正文<MarkdownEditor value={draft.body} onChange={(body) => setDraft((old) => ({ ...old, body }))} resolveDir={path ? dirName(path) : undefined} height="240px" /></label>
    <p className="hint">所有说明都可留空；编辑时保留手补字段。</p>
    <div className="dialog-actions">
      {expected && <button type="button" className="btn danger" disabled={busy} onClick={() => {
        if (window.confirm(`删除组织「${draft.name}」？关系引用会保留，正文文件将删除。`)) void perform(true);
      }}>删除</button>}
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy}>{busy ? "正在保存…" : "保存"}</button>
    </div>
  </form></div>;
}
