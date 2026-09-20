import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, AiProvider } from "./types";
import { errMsg } from "./util";

interface ProviderSettingsFormProps {
  initial: AiConfig;
  onSaved: (config: AiConfig) => void;
}

/** 供应商管理表单：既可嵌进独立设置页，也由兼容弹窗壳复用。 */
export function ProviderSettingsForm({
  initial,
  onSaved,
}: ProviderSettingsFormProps) {
  const [providers, setProviders] = useState<AiProvider[]>(initial.providers);
  const [activeId, setActiveId] = useState<string | null>(initial.activeProviderId);
  const [saving, setSaving] = useState(false);

  function patch(id: string, field: keyof AiProvider, value: string) {
    setProviders((list) => list.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }

  function addProvider() {
    const draft: AiProvider = {
      id: crypto.randomUUID(),
      name: "",
      baseUrl: "",
      apiKey: "",
      model: "",
    };
    setProviders((l) => [...l, draft]);
    setActiveId((cur) => cur ?? draft.id);
  }

  function removeProvider(id: string) {
    setProviders((l) => l.filter((p) => p.id !== id));
    if (activeId === id) {
      const rest = providers.filter((p) => p.id !== id);
      setActiveId(rest[0]?.id ?? null);
    }
  }

  async function save() {
    if (saving) return;
    const cleaned: AiProvider[] = providers.map((p) => ({
      ...p,
      name: p.name.trim(),
      baseUrl: p.baseUrl.trim(),
      apiKey: p.apiKey.trim(),
      model: p.model.trim(),
    }));
    for (const p of cleaned) {
      if (!p.name || !p.baseUrl || !p.model) {
        window.alert(`每个供应商都需要：名称、Base URL、模型。\n没填完的可以删掉再保存。`);
        return;
      }
      if (!/^https?:\/\//.test(p.baseUrl)) {
        window.alert(`「${p.name}」的 Base URL 需以 http:// 或 https:// 开头。`);
        return;
      }
    }
    setSaving(true);
    try {
      const config: AiConfig = {
        providers: cleaned,
        activeProviderId: activeId,
      };
      await invoke("save_ai_config", { config });
      onSaved(config);
      window.dispatchEvent(new CustomEvent("gongbi:ai-config-changed", { detail: config }));
    } catch (e) {
      window.alert(`供应商配置保存失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="provider-settings-form">
      <h2>供应商与模型</h2>
      <p className="hint">
        OpenAI 兼容接口（名称＋Base URL＋API Key＋模型）。配置与对话记录存在本机应用数据目录，
        不会写入库文件夹。
      </p>

      {providers.length === 0 && (
        <p className="hint">还没有供应商，点下面「新增供应商」开始配置。</p>
      )}

      {providers.map((p) => (
        <fieldset className="provider-fieldset" key={p.id}>
            <legend className="provider-legend">
              <label className="provider-active">
                <input
                  type="radio"
                  name="active-provider"
                  checked={activeId === p.id}
                  onChange={() => setActiveId(p.id)}
                />
                当前供应商
              </label>
            </legend>
            <label>
              名称
              <input
                value={p.name}
                onChange={(e) => patch(p.id, "name", e.target.value)}
                placeholder="如：深度求索、本地 Ollama"
              />
            </label>
            <label>
              Base URL
              <input
                value={p.baseUrl}
                onChange={(e) => patch(p.id, "baseUrl", e.target.value)}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                value={p.apiKey}
                onChange={(e) => patch(p.id, "apiKey", e.target.value)}
                placeholder="sk-…（本地服务可留空）"
                autoComplete="off"
              />
            </label>
            <label>
              模型
              <input
                value={p.model}
                onChange={(e) => patch(p.id, "model", e.target.value)}
                placeholder="如：deepseek-chat、gpt-4o-mini"
              />
            </label>
            <button className="btn small" onClick={() => removeProvider(p.id)}>
              删除这家
            </button>
        </fieldset>
      ))}

      <div className="dialog-actions">
        <button className="btn" onClick={addProvider}>
          新增供应商
        </button>
        <span className="grow" />
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          保存供应商设置
        </button>
      </div>
    </div>
  );
}
