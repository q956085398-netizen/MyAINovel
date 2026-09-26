import { useRevealSearchResult } from "./globalSearchNavigation";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./util";
import ContentSurface from "./ContentSurface";
import MarkdownEditor from "./MarkdownEditor";
import { dirName } from "./editorRender";
import { membershipSummary, type Membership } from "./characterProfile";

interface OrganizationDraft {
  name: string;
  purpose: string | null;
  location: string | null;
  conflict: string | null;
  secret: string | null;
  body: string;
}
interface Organization { path: string; draft: OrganizationDraft; fingerprint: string }
interface Workspace {
  organizations: Organization[];
  persons: string[];
  memberships: Membership[];
  fingerprint: string;
  upgraded: boolean;
  recoveryNeeded: boolean;
}
interface UpgradePreview {
  organizations: string[];
  changes: { path: string; before: string | null; after: string }[];
  guards: [string, string][];
}
const EMPTY_ORGANIZATION: OrganizationDraft = {
  name: "", purpose: null, location: null, conflict: null, secret: null, body: "",
};
const ORG_FIELDS = [
  ["purpose", "目的"], ["location", "所在地"], ["conflict", "矛盾"], ["secret", "秘密"],
] as const;

/** 复用现有完整卡片和宽编辑框；社会网只保存关系，档案仍是一文件一实体。 */
export default function SocialView({ project, onChanged }: { project: string; onChanged: () => void }) {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [organization, setOrganization] = useState<{ draft: OrganizationDraft; expected: string | null } | null>(null);
  const [member, setMember] = useState<{ next: Membership; previous: Membership | null } | null>(null);
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useRevealSearchResult(data?.organizations ?? [], (item) => { setOrganization({ draft: { ...item.draft }, expected: item.fingerprint }); });

  const load = useCallback(async () => {
    try {
      setData(await invoke<Workspace>("read_social_workspace", { project }));
      setError(null);
    } catch (e) {
      setData(null);
      setError(errMsg(e));
    }
  }, [project]);
  useEffect(() => { void load(); }, [load]);

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setOrganization(null);
      setMember(null);
      setPreview(null);
      await load();
      onChanged();
    } catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function openPreview() {
    if (busy) return;
    setBusy(true);
    try { setPreview(await invoke<UpgradePreview>("preview_social_upgrade", { project })); setError(null); }
    catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  function toggle(path: string) {
    setCollapsed((old) => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }
  function editMember(next: Membership, previous: Membership | null) { setMember({ next: { ...next }, previous }); }

  return (
    <div className="note-pane map-archive">
      <div className="pane-head">
        <div><h2>组织与归属</h2><p className="hint">一位人物可以同时属于多个组织；每段关系单独记录身份与秘密。</p></div>
        <div className="page-actions">
          <button className="btn" disabled={busy} onClick={() => void load()}>刷新</button>
          <button className="btn" disabled={busy} onClick={() => void openPreview()}>预览兼容升级</button>
          <button className="btn primary" disabled={busy || data?.recoveryNeeded} onClick={() => setOrganization({ draft: { ...EMPTY_ORGANIZATION }, expected: null })}>新建组织</button>
        </div>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {/* 即使结构损坏，恢复入口也必须可达。后端无日志时是只读空操作。 */}
      {(data?.recoveryNeeded || error) && <div className="hint-box"><p>若上次升级中断，可恢复升级前的文件；外部修改会保留并提示。</p><button className="btn" disabled={busy} onClick={() => void perform(() => invoke("recover_social_upgrade", { project }))}>恢复中断的升级</button></div>}
      {data && !data.upgraded && <p className="hint">旧人物分组继续兼容读取。预览并确认升级后，分组会变为组织归属；旧人物关系文件原样保留，新「关系.yaml」成为唯一来源。</p>}
      {data && <>
        <div className="card-list">
          {data.organizations.map((org) => (
            <ContentSurface key={org.path} identity={org.path} title={org.draft.name}
              expanded={!collapsed.has(org.path)} onToggleExpanded={() => toggle(org.path)}
              onEdit={() => setOrganization({ draft: { ...org.draft }, expected: org.fingerprint })}>
              <button className="btn small" onClick={() => document.getElementById("organization-memberships")?.scrollIntoView({ block: "start" })}>组织关系</button>
              {ORG_FIELDS.map(([field, label]) => org.draft[field] && <p className="field-line" key={field}><span className="field-label">{label}</span>{org.draft[field]}</p>)}
              {data.memberships.filter((m) => m.organization === org.draft.name).map((m, index) => <p className="field-line" key={index}><span className="field-label">成员关系</span>{membershipSummary(m, "person")}</p>)}
              {org.draft.body && <div className="card-body">{org.draft.body}</div>}
            </ContentSurface>
          ))}
        </div>
        {data.organizations.length === 0 && <p className="hint">还没有组织，可先新建，也可由旧人物分组升级。</p>}
        <div className="pane-head" id="organization-memberships"><h3>人物的组织关系</h3><button className="btn" disabled={busy || !data.upgraded || data.recoveryNeeded || !data.persons.length || !data.organizations.length} onClick={() => editMember({ person: data.persons[0], organization: data.organizations[0].draft.name, kind: "成员", role: null, status: "现任", secret: false, note: null }, null)}>添加组织关系</button></div>
        <div className="card-list">
          {data.memberships.map((m, index) => <article className="card-item" key={index}>
            <div className="card-title-row"><button className="card-title" onClick={() => editMember(m, m)}>{m.person} → {m.organization}</button><span className="card-cat">{m.kind} · {m.status} · {m.secret ? "秘密" : "公开"}</span></div>
            {m.role && <p>职位：{m.role}</p>}{m.note && <div className="card-body">{m.note}</div>}
            {(!data.persons.includes(m.person) || !data.organizations.some((o) => o.draft.name === m.organization)) && <p className="hint">引用的档案已失效，关系仍保留，可编辑或删除。</p>}
          </article>)}
        </div>
      </>}

      {organization && <div className="dialog-overlay"><form className="dialog wide" onSubmit={(e) => { e.preventDefault(); void perform(() => invoke("save_organization", { project, ...organization })); }}>
        <h2>{organization.expected ? "编辑组织" : "新建组织"}</h2>
        {error && <div className="error-box" role="alert">{error}</div>}
        <label>组织名<input autoFocus required disabled={busy || !!organization.expected} value={organization.draft.name} onChange={(e) => setOrganization({ ...organization, draft: { ...organization.draft, name: e.target.value } })} /></label>
        {ORG_FIELDS.map(([field, label]) => <label key={field}>{label}<input disabled={busy} value={organization.draft[field] ?? ""} onChange={(e) => setOrganization({ ...organization, draft: { ...organization.draft, [field]: e.target.value || null } })} /></label>)}
        <label>正文<MarkdownEditor value={organization.draft.body} onChange={(body) => setOrganization((old) => old && ({ ...old, draft: { ...old.draft, body } }))} resolveDir={organization.expected ? dirName(data?.organizations.find((org) => org.draft.name === organization.draft.name)?.path ?? "") : undefined} height="240px" /></label>
        <p className="hint">所有说明都可留空。保存为 构思/组织/组织名.md；编辑时保留手补字段。</p>
        <div className="dialog-actions">
          {organization.expected && <button type="button" className="btn danger" disabled={busy} onClick={() => { if (window.confirm(`删除组织「${organization.draft.name}」？关系引用会保留，正文文件将删除。`)) void perform(() => invoke("delete_organization", { project, name: organization.draft.name, expected: organization.expected })); }}>删除</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => setOrganization(null)}>取消</button><button className="btn primary" disabled={busy}>保存</button>
        </div>
      </form></div>}

      {member && data && <div className="dialog-overlay"><form className="dialog" onSubmit={(e) => { e.preventDefault(); void perform(() => invoke("edit_membership", { project, ...member, expected: data.fingerprint })); }}>
        <h2>{member.previous ? "编辑组织关系" : "添加组织关系"}</h2>
        {error && <div className="error-box" role="alert">{error}</div>}
        <label>人物<select autoFocus disabled={busy} value={member.next.person} onChange={(e) => setMember({ ...member, next: { ...member.next, person: e.target.value } })}>{[...new Set([member.next.person, ...data.persons])].map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>组织<select disabled={busy} value={member.next.organization} onChange={(e) => setMember({ ...member, next: { ...member.next, organization: e.target.value } })}>{[...new Set([member.next.organization, ...data.organizations.map((o) => o.draft.name)])].map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>关系类型<input required disabled={busy} value={member.next.kind} onChange={(e) => setMember({ ...member, next: { ...member.next, kind: e.target.value } })} /></label>
        <label>职位／身份<input disabled={busy} value={member.next.role ?? ""} onChange={(e) => setMember({ ...member, next: { ...member.next, role: e.target.value || null } })} /></label>
        <label>任职<select disabled={busy} value={member.next.status} onChange={(e) => setMember({ ...member, next: { ...member.next, status: e.target.value } })}><option>现任</option><option>前任</option></select></label>
        <label>公开程度<select disabled={busy} value={member.next.secret ? "秘密" : "公开"} onChange={(e) => setMember({ ...member, next: { ...member.next, secret: e.target.value === "秘密" } })}><option>公开</option><option>秘密</option></select></label>
        <label>描述<textarea disabled={busy} value={member.next.note ?? ""} onChange={(e) => setMember({ ...member, next: { ...member.next, note: e.target.value || null } })} /></label>
        <div className="dialog-actions">
          {member.previous && <button type="button" className="btn danger" disabled={busy} onClick={() => { if (window.confirm("删除这段组织关系？")) void perform(() => invoke("edit_membership", { project, next: null, previous: member.previous, expected: data.fingerprint })); }}>删除关系</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => setMember(null)}>取消</button><button className="btn primary" disabled={busy || data.recoveryNeeded}>保存</button>
        </div>
      </form></div>}

      {preview && <div className="dialog-overlay"><div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="social-upgrade-title">
        <h2 id="social-upgrade-title">预览社会关系升级</h2>
        {error && <div className="error-box" role="alert">{error}</div>}
        <p>旧分组转为组织与成员关系；人物正文与未知字段保留。旧人物关系文件原样留存，确认后改读新社会网。</p>
        <ul>{preview.changes.map((c) => <li key={c.path}>{c.before === null ? "创建" : "更改"}：{c.path}</li>)}</ul>
        {preview.organizations.length > 0 && <p>涉及组织：{preview.organizations.join("、")}</p>}
        {!preview.changes.length && <p>没有待升级内容。</p>}
        <p className="hint">取消不会修改任何文件。确认前会重新核对预览，文件已改变时拒绝升级。</p>
        <div className="dialog-actions"><button autoFocus className="btn" disabled={busy} onClick={() => setPreview(null)}>取消</button><button className="btn primary" disabled={busy || !preview.changes.length} onClick={() => void perform(() => invoke("confirm_social_upgrade", { project, preview }))}>{busy ? "正在升级…" : "确认升级"}</button></div>
      </div></div>}
    </div>
  );
}
