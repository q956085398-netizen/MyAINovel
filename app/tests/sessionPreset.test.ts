import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SYSTEM_PROMPT } from "../src/ai.ts";
import {
  copyAsNewSession,
  defaultPreset,
  presetSnapshot,
  resolveDraftPreset,
  resolveSessionTarget,
  resolveSystemPrompt,
  sessionPresetView,
} from "../src/sessionPreset.ts";
import type {
  AiConfig,
  AssistantPreset,
  AssistantPresetState,
  ChatMessage,
  ChatPreset,
  ChatSession,
} from "../src/types.ts";

function preset(overrides: Partial<AssistantPreset> = {}): AssistantPreset {
  return {
    id: "u-1",
    name: "我的军师",
    description: "说明",
    icon: "🧠",
    color: "#ae432e",
    systemPrompt: "你是军师，只谈兵法。",
    providerOverride: null,
    modelOverride: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ChatPreset> = {}): ChatPreset {
  return {
    id: "u-1",
    name: "我的军师",
    icon: "🧠",
    color: "#ae432e",
    systemPrompt: "你是军师，只谈兵法。",
    providerOverride: null,
    modelOverride: null,
    ...overrides,
  };
}

function state(overrides: Partial<AssistantPresetState> = {}): AssistantPresetState {
  return {
    builtins: [
      preset({ id: "builtin:general", name: "通用助手", description: "", icon: "", color: "", systemPrompt: DEFAULT_SYSTEM_PROMPT }),
      preset({ id: "builtin:analyst", name: "拆书教练", description: "", icon: "", color: "", systemPrompt: "你是拆书教练。" }),
    ],
    userPresets: [preset()],
    defaultPresetId: "builtin:general",
    builtinVersion: 1,
    ...overrides,
  };
}

const config: AiConfig = {
  providers: [
    { id: "p-a", name: "深度求索", baseUrl: "https://a", apiKey: "k", model: "deepseek-chat" },
    { id: "p-b", name: "本地 Ollama", baseUrl: "http://b", apiKey: "", model: "qwen" },
  ],
  activeProviderId: "p-a",
};

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "聊聊",
    createdAt: 1,
    updatedAt: 2,
    messages: [] as ChatMessage[],
    persona: null,
    preset: null,
    ...overrides,
  };
}

// ---------- 快照与默认解析 ----------

test("预设快照逐字段定格，空覆盖归一为 null", () => {
  const snap = presetSnapshot(preset({ providerOverride: undefined, modelOverride: "glm-5" }));
  assert.deepEqual(snap, snapshot({ providerOverride: null, modelOverride: "glm-5" }));
});

test("默认预设来自设置；默认悬空或表缺失时退通用助手", () => {
  assert.equal(defaultPreset(state({ defaultPresetId: "u-1" })).id, "u-1");
  assert.equal(defaultPreset(state({ defaultPresetId: "u-gone" })).id, "builtin:general");
  // 预设表读不到（未加载/损坏提示期）也能开聊：基线与内置通用助手同文。
  const fallback = defaultPreset(null);
  assert.equal(fallback.id, "builtin:general");
  assert.equal(fallback.systemPrompt, DEFAULT_SYSTEM_PROMPT);
});

test("草稿预设点选优先；点选的预设被删除后回默认", () => {
  assert.equal(resolveDraftPreset("builtin:analyst", state()).id, "builtin:analyst");
  assert.equal(resolveDraftPreset("u-gone", state()).id, "builtin:general");
  assert.equal(resolveDraftPreset(null, state()).id, "builtin:general");
});

// ---------- 三条路径的系统提示隔离（验收：命令/人物不吃普通预设） ----------

test("固定命令始终用自己的系统提示，不吃预设也不吃人格底座", () => {
  const system = resolveSystemPrompt({
    commandSystem: "你是「工笔」的拆书助手……",
    personaBase: "你是笔下人物……",
    sessionPreset: snapshot(),
  });
  assert.equal(system, "你是「工笔」的拆书助手……");
});

test("人物对话用会话里的人格底座，不读预设快照", () => {
  const system = resolveSystemPrompt({
    personaBase: "你是笔下人物「张三」……",
    sessionPreset: snapshot(),
  });
  assert.equal(system, "你是笔下人物「张三」……");
});

test("普通对话用创建时的预设快照；旧会话回退通用助手基线", () => {
  assert.equal(resolveSystemPrompt({ sessionPreset: snapshot() }), "你是军师，只谈兵法。");
  assert.equal(resolveSystemPrompt({ sessionPreset: null }), DEFAULT_SYSTEM_PROMPT);
  assert.equal(resolveSystemPrompt({}), DEFAULT_SYSTEM_PROMPT);
});

// ---------- 请求通道 ----------

test("没有快照覆盖时跟随全局供应商与模型（人物/旧会话同此路径）", () => {
  assert.deepEqual(resolveSessionTarget(null, config), {
    provider: config.providers[0],
    model: "deepseek-chat",
    stale: false,
  });
  assert.deepEqual(resolveSessionTarget(snapshot(), null), {
    provider: null,
    model: "",
    stale: false,
  });
});

test("快照覆盖命中时走覆盖供应商；模型覆盖缺省用该供应商的模型", () => {
  assert.deepEqual(
    resolveSessionTarget(snapshot({ providerOverride: "p-b" }), config),
    { provider: config.providers[1], model: "qwen", stale: false },
  );
  assert.deepEqual(
    resolveSessionTarget(snapshot({ providerOverride: "p-b", modelOverride: "glm-5" }), config),
    { provider: config.providers[1], model: "glm-5", stale: false },
  );
});

test("覆盖指向已删除的供应商时整组回退全局（模型覆盖一并放弃）", () => {
  assert.deepEqual(
    resolveSessionTarget(snapshot({ providerOverride: "p-gone", modelOverride: "glm-5" }), config),
    { provider: config.providers[0], model: "deepseek-chat", stale: true },
  );
});

// ---------- 会话胶囊 ----------

test("胶囊恒用快照名字；预设删除后标记 deleted 但不挡会话", () => {
  const view = sessionPresetView(snapshot(), state());
  assert.deepEqual(view, { name: "我的军师", icon: "🧠", color: "#ae432e", deleted: false });
  // 预设改名后：旧会话仍显示创建时的名字。
  const renamed = sessionPresetView(
    snapshot({ name: "我的军师" }),
    state({ userPresets: [preset({ name: "新军师" })] }),
  );
  assert.equal(renamed?.name, "我的军师");
  assert.equal(renamed?.deleted, false);
  // 预设删除后：会话照常用快照，胶囊说明已删除。
  const deleted = sessionPresetView(snapshot(), state({ userPresets: [] }));
  assert.equal(deleted?.deleted, true);
  assert.equal(deleted?.name, "我的军师");
  assert.equal(sessionPresetView(null, state()), null);
  // 预设表读不到（临时故障）不误报已删除。
  assert.equal(sessionPresetView(snapshot(), null)?.deleted, false);
});

// ---------- 换预设＝复制为新会话 ----------

test("复制为新会话：换预设快照、可选带上可见消息、人格标签不带走", () => {
  const origin = session({
    title: "聊聊大纲",
    messages: [
      { role: "user", content: "帮我看看第二卷" },
      { role: "assistant", content: "好，先说结论。", meta: { kind: "梳理", startLine: 3, endLine: 5 } },
    ],
    preset: snapshot(),
  });
  const withCopy = copyAsNewSession(origin, preset({ id: "u-2", name: "新军师" }), true, "n-1", 99);
  assert.equal(withCopy.id, "n-1");
  assert.equal(withCopy.title, "聊聊大纲");
  assert.equal(withCopy.createdAt, 99);
  assert.equal(withCopy.preset?.name, "新军师");
  assert.equal(withCopy.persona, null);
  assert.equal(withCopy.messages.length, 2);
  assert.deepEqual(withCopy.messages[1].meta, { kind: "梳理", startLine: 3, endLine: 5 });

  const bare = copyAsNewSession(origin, preset({ id: "u-2" }), false, "n-2", 100);
  assert.deepEqual(bare.messages, []);
  assert.equal(bare.preset?.id, "u-2");

  // system 人格底座不属于「可见上下文」，即使带着也不复制。
  const personaLike = session({
    messages: [
      { role: "system", content: "你是笔下人物……" },
      { role: "user", content: "在吗" },
    ],
  });
  const copied = copyAsNewSession(personaLike, preset(), true, "n-3", 101);
  assert.deepEqual(
    copied.messages.map((m) => m.role),
    ["user"],
  );
});
