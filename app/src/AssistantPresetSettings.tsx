import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpen, Icon, MessageCircle, PenLine, Sparkles, ICON_SIZE_DENSE } from "./icons";
import {
  GENERAL_PRESET_ID,
  copyDraft,
  draftError,
  providerOverrideText,
  resolveProviderOverride,
} from "./presets";
import type {
  AiConfig,
  AssistantPreset,
  AssistantPresetSave,
  AssistantPresetState,
} from "./types";
import { errMsg } from "./util";

/** 内置预设的固定图标；个人预设显示自己填的 emoji，没填就退通用图标。 */
const BUILTIN_ICONS: Record<string, typeof MessageCircle> = {
  "builtin:general": MessageCircle,
  "builtin:analyst": BookOpen,
  "builtin:ideator": Sparkles,
  "builtin:editor": PenLine,
};

/** 预设管理区（工单 T06，docs/spec/AI助手预设.md §五.2）：设置 → AI 的
 *  「AI 助手预设」节。内置只读可复制；个人预设增删改、设默认；删除默认
 *  预设时先选新默认。整表经 save_assistant_presets 校验落盘。 */
export default function AssistantPresetSettings({ aiConfig }: { aiConfig: AiConfig | null }) {
  const [state, setState] = useState<AssistantPresetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 编辑中的草稿（新建/复制/编辑共用一个表单）。 */
  const [draft, setDraft] = useState<AssistantPreset | null>(null);
  const [draftErrorText, setDraftErrorText] = useState<string | null>(null);
  /** 删除默认预设时需要先选新默认，用小对话框承接。 */
  const [deleting, setDeleting] = useState<AssistantPreset | null>(null);
  const [deleteDefault, setDeleteDefault] = useState<string>(GENERAL_PRESET_ID);

  useEffect(() => {
    void invoke<AssistantPresetState>("load_assistant_presets")
      .then((loaded) => {
        setState(loaded);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  function reload() {
    setError(null);
    void invoke<AssistantPresetState>("load_assistant_presets")
      .then((loaded) => setState(loaded))
      .catch((e) => setError(errMsg(e)));
  }

  async function persist(nextUser: AssistantPreset[], nextDefault: string) {
    if (saving) return;
    setSaving(true);
    try {
      const payload: AssistantPresetSave = {
        defaultPresetId: nextDefault,
        userPresets: nextUser,
      };
      const saved = await invoke<AssistantPresetState>("save_assistant_presets", { save: payload });
      setState(saved);
      window.dispatchEvent(new CustomEvent("gongbi:ai-presets-changed", { detail: saved }));
    } catch (e) {
      window.alert(`预设保存失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function setDefault(id: string) {
    if (!state || state.defaultPresetId === id) return;
    void persist(state.userPresets, id);
  }

  function saveDraft() {
    if (!state || !draft) return;
    const problem = draftError(draft);
    setDraftErrorText(problem);
    if (problem) return;
    const exists = state.userPresets.some((p) => p.id === draft.id);
    const next = exists
      ? state.userPresets.map((p) => (p.id === draft.id ? draft : p))
      : [...state.userPresets, draft];
    void persist(next, state.defaultPresetId);
    setDraft(null);
  }

  function requestDelete(preset: AssistantPreset) {
    if (!state) return;
    if (preset.id === state.defaultPresetId) {
      setDeleteDefault(GENERAL_PRESET_ID);
      setDeleting(preset);
      return;
    }
    if (!window.confirm(`确定删除预设「${preset.name}」？`)) return;
    void persist(
      state.userPresets.filter((p) => p.id !== preset.id),
      state.defaultPresetId,
    );
  }

  function confirmDeleteDefault() {
    if (!state || !deleting) return;
    void persist(
      state.userPresets.filter((p) => p.id !== deleting.id),
      deleteDefault,
    );
    setDeleting(null);
  }

  const presetIcon = (preset: AssistantPreset) => {
    if (BUILTIN_ICONS[preset.id]) {
      return <Icon as={BUILTIN_ICONS[preset.id]} size={ICON_SIZE_DENSE} />;
    }
    return preset.icon ? <span className="preset-emoji">{preset.icon}</span> : (
      <Icon as={MessageCircle} size={ICON_SIZE_DENSE} />
    );
  };

  const presetRow = (preset: AssistantPreset, builtin: boolean) => {
    const isDefault = state?.defaultPresetId === preset.id;
    const override = resolveProviderOverride(preset, aiConfig);
    return (
      <div className="preset-row" key={preset.id}>
        <label className="preset-default">
          <input
            type="radio"
            name="default-preset"
            checked={isDefault}
            onChange={() => setDefault(preset.id)}
            aria-label={`把「${preset.name}」设为默认助手`}
          />
          默认
        </label>
        <span className="preset-icon" style={preset.color ? { color: preset.color } : undefined}>
          {presetIcon(preset)}
        </span>
        <div className="preset-body">
          <p className="preset-title">
            <strong>{preset.name}</strong>
            {builtin && <span className="preset-badge">内置</span>}
            {isDefault && <span className="preset-badge preset-badge-default">默认助手</span>}
          </p>
          {preset.description && <p className="preset-desc">{preset.description}</p>}
          <p className={`preset-provider${override.stale ? " preset-warn" : ""}`}>
            供应商：{providerOverrideText(override)}
            {preset.modelOverride ? ` · 模型：${preset.modelOverride}` : ""}
            {override.stale && "——编辑预设可改回跟随全局"}
          </p>
        </div>
        <div className="preset-actions">
          {!builtin && (
            <button
              className="btn small"
              onClick={() => {
                setDraftErrorText(null);
                setDraft({ ...preset });
              }}
            >
              编辑
            </button>
          )}
          <button
            className="btn small"
            onClick={() => {
              setDraftErrorText(null);
              setDraft(copyDraft(preset, crypto.randomUUID()));
            }}
          >
            复制
          </button>
          {!builtin && (
            <button className="btn small" onClick={() => requestDelete(preset)}>
              删除
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="settings-section preset-settings" aria-label="AI 助手预设">
      <h2>AI 助手预设</h2>
      <p className="hint">
        预设只影响普通对话；固定 AI 命令与人物对话各有各的提示，不会被预设改写。
        内置预设可直接使用、可复制，不可修改或删除。未指定供应商/模型时跟随上方全局选择。
      </p>

      {aiConfig && aiConfig.providers.length === 0 && (
        <div className="error-box">
          还没有配置任何供应商——预设仍可管理，但对话要等上方「供应商与模型」配好后才能用。
        </div>
      )}

      {error && (
        <div className="error-box">
          读取助手预设失败：{error}
          <br />
          若预设文件（应用数据目录 ai/presets.json）被改坏，修好或删掉它后重试即可回到内置预设。
          <button className="btn small" onClick={reload}>
            重试
          </button>
        </div>
      )}

      {state && (
        <>
          <h3 className="preset-group-title">内置</h3>
          {state.builtins.map((p) => presetRow(p, true))}

          <h3 className="preset-group-title">我的预设</h3>
          {state.userPresets.length === 0 && (
            <p className="hint">还没有个人预设；可从内置复制一份开始改。</p>
          )}
          {state.userPresets.map((p) => presetRow(p, false))}

          <div className="dialog-actions">
            <button
              className="btn"
              onClick={() => {
                setDraftErrorText(null);
                setDraft({
                  id: crypto.randomUUID(),
                  name: "",
                  description: "",
                  icon: "",
                  color: "",
                  systemPrompt: "",
                  providerOverride: null,
                  modelOverride: null,
                });
              }}
            >
              新建预设
            </button>
          </div>
        </>
      )}

      {draft && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDraft(null);
          }}
        >
          <div className="dialog preset-dialog">
            <h2>{state?.userPresets.some((p) => p.id === draft.id) ? `编辑预设：${draft.name || "未命名"}` : "新建预设"}</h2>
            <label>
              名称
              <input
                autoFocus
                value={draft.name}
                placeholder="如：毒舌责编"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              一句话说明
              <input
                value={draft.description}
                placeholder="这个助手是干什么的"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <div className="preset-form-row">
              <label>
                图标（emoji）
                <input
                  value={draft.icon}
                  placeholder="如：🦊"
                  onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                />
              </label>
              <label>
                识别色
                <span className="preset-color-row">
                  <input
                    type="color"
                    value={draft.color || "#7a746a"}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                    aria-label="识别色"
                  />
                  <button
                    className="btn small"
                    onClick={() => setDraft({ ...draft, color: "" })}
                  >
                    不用色
                  </button>
                </span>
              </label>
            </div>
            <label>
              系统提示
              <textarea
                rows={6}
                value={draft.systemPrompt}
                placeholder="这个助手怎么说话、干什么、不干什么"
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              />
            </label>
            <div className="preset-form-row">
              <label>
                供应商覆盖
                <select
                  value={draft.providerOverride ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, providerOverride: e.target.value || null })
                  }
                >
                  <option value="">跟随全局</option>
                  {(aiConfig?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {draft.providerOverride &&
                    !(aiConfig?.providers ?? []).some((p) => p.id === draft.providerOverride) && (
                      <option value={draft.providerOverride}>
                        {draft.providerOverride}（已失效）
                      </option>
                    )}
                </select>
              </label>
              <label>
                模型覆盖
                <input
                  value={draft.modelOverride ?? ""}
                  placeholder="留空＝跟随全局供应商的模型"
                  onChange={(e) => setDraft({ ...draft, modelOverride: e.target.value || null })}
                />
              </label>
            </div>
            <p className="hint">预设只保存在本机应用状态，不写进创作库。</p>
            {draftErrorText && <div className="error-box">{draftErrorText}</div>}
            <div className="dialog-actions">
              <button className="btn" onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="btn primary" disabled={saving} onClick={saveDraft}>
                保存预设
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && state && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleting(null);
          }}
        >
          <div className="dialog preset-dialog">
            <h2>删除默认预设</h2>
            <p>
              「{deleting.name}」是默认助手。删除后需要选一个新的默认，历史会话不受影响。
            </p>
            <div className="preset-default-list" role="radiogroup" aria-label="新的默认助手">
              {[
                ...state.builtins.filter((p) => p.id !== deleting.id),
                ...state.userPresets.filter((p) => p.id !== deleting.id),
              ].map((p) => (
                <label key={p.id}>
                  <input
                    type="radio"
                    name="delete-new-default"
                    checked={deleteDefault === p.id}
                    onChange={() => setDeleteDefault(p.id)}
                  />
                  {p.name}
                  {p.id === GENERAL_PRESET_ID ? "（内置通用助手）" : ""}
                </label>
              ))}
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button className="btn primary" disabled={saving} onClick={confirmDeleteDefault}>
                删除并换默认
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
