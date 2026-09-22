import { DEFAULT_SYSTEM_PROMPT } from "./ai.ts";
import { GENERAL_PRESET_ID } from "./presets.ts";
import type {
  AiConfig,
  AiProvider,
  AssistantPreset,
  AssistantPresetState,
  ChatPreset,
  ChatSession,
} from "./types";

/** 普通对话的预设绑定（工单 T07，docs/spec/AI助手预设.md §四、§六）。
 *  只放纯逻辑：快照、默认解析、三条路径的系统提示与请求通道解析、
 *  复制为新会话；界面消费在 AiSidebar。
 *
 *  隔离纪律：固定 AI 命令始终用自己的系统提示；人物对话用会话首条
 *  system 的人格底座；普通对话才读预设——三条路径互不掺和。 */

/** 创建会话那一刻的预设快照：之后预设怎么改、怎么删都不再影响这个会话。 */
export function presetSnapshot(preset: AssistantPreset): ChatPreset {
  return {
    id: preset.id,
    name: preset.name,
    icon: preset.icon,
    color: preset.color,
    systemPrompt: preset.systemPrompt,
    providerOverride: preset.providerOverride ?? null,
    modelOverride: preset.modelOverride ?? null,
  };
}

/** 兜底通用助手：预设表还没读到/读失败时也能按基线开聊。 */
function fallbackGeneral(): AssistantPreset {
  return {
    id: GENERAL_PRESET_ID,
    name: "通用助手",
    description: "普通问答，不主动套写作方法。",
    icon: "",
    color: "",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    providerOverride: null,
    modelOverride: null,
  };
}

/** 全部预设（内置在前）：表为 null 时返回空——调用方据此显示降级提示。 */
export function allPresetsOf(state: AssistantPresetState | null): AssistantPreset[] {
  return state ? [...state.builtins, ...state.userPresets] : [];
}

/** 新会话的默认预设：设置里定的默认；默认悬空或表没读到时退通用助手。 */
export function defaultPreset(state: AssistantPresetState | null): AssistantPreset {
  if (state) {
    const all = allPresetsOf(state);
    const hit = all.find((p) => p.id === state.defaultPresetId);
    if (hit) return hit;
    const general = state.builtins.find((p) => p.id === GENERAL_PRESET_ID);
    if (general) return general;
  }
  return fallbackGeneral();
}

/** 新会话草稿要绑的预设：点选的优先；没点选（或点选的已被删除）＝默认。 */
export function resolveDraftPreset(
  pickedId: string | null,
  state: AssistantPresetState | null,
): AssistantPreset {
  if (pickedId && state) {
    const hit = allPresetsOf(state).find((p) => p.id === pickedId);
    if (hit) return hit;
  }
  return defaultPreset(state);
}

/** 三条路径的系统提示解析（隔离纪律）：固定命令 > 人物底座 > 会话预设
 *  快照 > 通用助手基线。实际会话里三者不会同时出现——命令不进人格会话、
 *  人格会话不绑预设；优先级写死在这里，防未来接线时混人格。 */
export function resolveSystemPrompt(input: {
  commandSystem?: string | null;
  personaBase?: string | null;
  sessionPreset?: ChatPreset | null;
}): string {
  if (input.commandSystem?.trim()) return input.commandSystem;
  if (input.personaBase?.trim()) return input.personaBase;
  return input.sessionPreset?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
}

/** 请求通道解析结果。 */
export interface SessionTarget {
  provider: AiProvider | null;
  model: string;
  /** 快照的供应商覆盖指向的供应商已不存在，已整组回退全局
   *  （模型覆盖一并放弃：模型名换供应商常常不通用）。 */
  stale: boolean;
}

/** 会话的请求通道：普通会话用快照里的供应商/模型覆盖，没覆盖（或人物
 *  会话、旧会话）跟随全局当前选择。 */
export function resolveSessionTarget(
  preset: ChatPreset | null | undefined,
  config: AiConfig | null,
): SessionTarget {
  const global =
    config?.providers.find((p) => p.id === config.activeProviderId) ?? null;
  const overrideId = preset?.providerOverride?.trim();
  if (preset && overrideId && config) {
    const hit = config.providers.find((p) => p.id === overrideId) ?? null;
    if (hit) {
      return { provider: hit, model: preset.modelOverride?.trim() || hit.model, stale: false };
    }
    return { provider: global, model: global?.model ?? "", stale: true };
  }
  return { provider: global, model: global?.model ?? "", stale: false };
}

/** 会话胶囊的投影：名字/图标/识别色恒用快照（预设后来改名也不跟着变）；
 *  预设已删除只提示，会话照常用快照继续。 */
export interface SessionPresetView {
  name: string;
  icon: string;
  color: string;
  /** 预设已从设置里删除，会话按创建时的快照继续。 */
  deleted: boolean;
}

export function sessionPresetView(
  preset: ChatPreset | null | undefined,
  state: AssistantPresetState | null,
): SessionPresetView | null {
  if (!preset) return null;
  // 预设表读不到时不算「已删除」：按快照正常显示，别拿临时故障吓人。
  const all = allPresetsOf(state);
  return {
    name: preset.name,
    icon: preset.icon,
    color: preset.color,
    deleted: state !== null && !all.some((p) => p.id === preset.id),
  };
}

/** 「换预设＝复制为新会话」（spec §四）：新 id、新时间、换成目标预设
 *  快照，不在原会话里混人格。可见上下文可选复制——system 人格底座不
 *  复制；命令消息的 meta 原样保留（采纳上下文不丢）。 */
export function copyAsNewSession(
  session: ChatSession,
  target: AssistantPreset,
  includeVisible: boolean,
  newId: string,
  now: number,
): ChatSession {
  return {
    id: newId,
    title: session.title,
    createdAt: now,
    updatedAt: now,
    messages: includeVisible ? session.messages.filter((m) => m.role !== "system") : [],
    persona: null,
    preset: presetSnapshot(target),
  };
}
