import type { AiConfig, AiProvider, AssistantPreset } from "./types";

/** 预设只作用于普通对话（docs/spec/AI助手预设.md §一）；这里的纯逻辑供
 *  设置页与后续会话侧（T07）共用：覆盖解析、草稿底线、复制草稿。 */

/** 内置通用助手的 id；与 Rust 侧 presets.rs::GENERAL_PRESET_ID 同值。
 *  未选默认、默认失效、旧会话缺预设字段时都回退到它。 */
export const GENERAL_PRESET_ID = "builtin:general";

/** 供应商覆盖的解析结果。 */
export interface ProviderOverrideView {
  /** null＝跟随全局（或覆盖已失效时的回退）。 */
  provider: AiProvider | null;
  /** 覆盖指向的供应商已不存在，界面需要给出修复提示。 */
  stale: boolean;
}

export function resolveProviderOverride(
  preset: AssistantPreset,
  config: AiConfig | null,
): ProviderOverrideView {
  const id = preset.providerOverride?.trim();
  if (!id || !config) return { provider: null, stale: false };
  const provider = config.providers.find((p) => p.id === id) ?? null;
  return { provider, stale: provider === null };
}

/** 覆盖说明文案（列表行与编辑器共用）。 */
export function providerOverrideText(view: ProviderOverrideView): string {
  if (view.stale) return "供应商已失效，回退全局";
  return view.provider?.name ?? "跟随全局";
}

/** 编辑草稿的即时报错；与 Rust 侧 presets.rs::validate 同一条底线，
 *  后端仍是最终闸（内置不可覆盖等表级规则只在那边）。 */
export function draftError(preset: AssistantPreset): string | null {
  if (!preset.name.trim()) return "预设需要名称。";
  if (!preset.systemPrompt.trim()) {
    return `「${preset.name.trim()}」需要系统提示。`;
  }
  if (preset.color && !/^#[0-9a-fA-F]{6}$/.test(preset.color)) {
    return "识别色需要 #rrggbb 格式。";
  }
  return null;
}

/** 复制预设（内置或个人）为可编辑草稿：换 id、名字加副本，正文照搬。 */
export function copyDraft(preset: AssistantPreset, newId: string): AssistantPreset {
  return {
    ...preset,
    id: newId,
    name: `${preset.name} 副本`,
  };
}
