import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_READER_PROMPTS,
  normalizeReaderPrompts,
  selectOverviewQuestion,
} from "../src/ideationGuidance.ts";

test("构思首页对未开始方向最多给一个问题且已有摘要时让路", () => {
  assert.deepEqual(
    selectOverviewQuestion(
      { premise: null, readerImaginations: [], characters: [], maps: [] },
      [],
    ),
    {
      id: "premise",
      tab: "大纲",
      text: "如果只用一句话介绍这本书，最想让读者记住什么？",
    },
  );
  assert.equal(
    selectOverviewQuestion(
      {
        premise: "失忆侦探追查消失的港城。",
        readerImaginations: ["抽丝剥茧"],
        characters: [{ name: "祁雁" }],
        maps: [{ name: "雾港" }],
      },
      [],
    ),
    null,
  );
});

test("关闭一个首页问题后选择下一方向而不生成完成度", () => {
  const question = selectOverviewQuestion(
    { premise: null, readerImaginations: [], characters: [], maps: [] },
    ["premise"],
  );
  assert.equal(question?.id, "reader-imagination");
  assert.equal("progress" in (question ?? {}), false);
});

test("读者遐想三类提示可自由改写和删除", () => {
  assert.equal(DEFAULT_READER_PROMPTS.length, 3);
  const prompts = normalizeReaderPrompts([
    { id: "expectation", label: "读者期待", text: "我改写后的问题" },
    { id: "unique", label: "独特吸引力", text: "这本书只有什么能做到？" },
  ]);
  assert.deepEqual(prompts.map((prompt) => prompt.id), ["expectation", "unique"]);
  assert.equal(prompts[0].text, "我改写后的问题");
});
