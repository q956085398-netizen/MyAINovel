import assert from "node:assert/strict";
import test from "node:test";

import {
  copyDraft,
  draftError,
  providerOverrideText,
  resolveProviderOverride,
} from "../src/presets.ts";
import type { AiConfig, AssistantPreset } from "../src/types.ts";

function preset(overrides: Partial<AssistantPreset> = {}): AssistantPreset {
  return {
    id: "u-1",
    name: "我的军师",
    description: "说明",
    icon: "",
    color: "",
    systemPrompt: "你是测试助手。",
    providerOverride: null,
    modelOverride: null,
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

test("没有覆盖时跟随全局，覆盖命中时给出供应商", () => {
  assert.deepEqual(resolveProviderOverride(preset(), config), {
    provider: null,
    stale: false,
  });
  assert.deepEqual(resolveProviderOverride(preset({ providerOverride: "p-b" }), config), {
    provider: config.providers[1],
    stale: false,
  });
});

test("覆盖指向已删除的供应商时标记失效并回退全局", () => {
  const view = resolveProviderOverride(preset({ providerOverride: "p-gone" }), config);
  assert.equal(view.provider, null);
  assert.equal(view.stale, true);
  // 配置缺失（还没配供应商）时覆盖只能显示跟随全局，不算失效。
  assert.deepEqual(resolveProviderOverride(preset(), null), { provider: null, stale: false });
});

test("覆盖说明文案三种形态", () => {
  assert.equal(providerOverrideText(resolveProviderOverride(preset(), config)), "跟随全局");
  assert.equal(
    providerOverrideText(resolveProviderOverride(preset({ providerOverride: "p-b" }), config)),
    "本地 Ollama",
  );
  assert.equal(
    providerOverrideText(resolveProviderOverride(preset({ providerOverride: "p-gone" }), config)),
    "供应商已失效，回退全局",
  );
});

test("编辑草稿的即时报错与后端同一条底线", () => {
  assert.equal(draftError(preset()), null);
  assert.equal(draftError(preset({ name: "  " })), "预设需要名称。");
  assert.equal(draftError(preset({ systemPrompt: "" })), "「我的军师」需要系统提示。");
  assert.equal(draftError(preset({ color: "红" })), "识别色需要 #rrggbb 格式。");
  assert.equal(draftError(preset({ color: "#ae432e" })), null);
});

test("复制预设得到新 id、名字带副本、正文保留", () => {
  const builtin = preset({ id: "builtin:analyst", name: "拆书教练" });
  const draft = copyDraft(builtin, "u-new");
  assert.equal(draft.id, "u-new");
  assert.equal(draft.name, "拆书教练 副本");
  assert.equal(draft.systemPrompt, builtin.systemPrompt);
  assert.ok(!draft.id.startsWith("builtin:"));
});
