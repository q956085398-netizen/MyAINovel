import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IMAGINATION_PROMPTS,
  editPrompt,
  firstOpenQuestion,
  removePrompt,
} from "../src/ideationGuidance.ts";

test("未开始方向最多返回一个可关闭问题", () => {
  const candidates = [
    { id: "logline", text: "一句话是什么？" },
    { id: "mainline", text: "主线怎么走？" },
  ];
  assert.equal(firstOpenQuestion(candidates, [])?.id, "logline");
  assert.equal(firstOpenQuestion(candidates, ["logline"])?.id, "mainline");
  assert.equal(firstOpenQuestion(candidates, ["logline", "mainline"]), null);
});

test("三类读者遐想提示可以自由改写和逐项删除", () => {
  assert.equal(DEFAULT_IMAGINATION_PROMPTS.length, 3);
  const edited = editPrompt(DEFAULT_IMAGINATION_PROMPTS, "reader-expectation", "我自己的问题");
  assert.equal(edited[0].text, "我自己的问题");
  const removed = removePrompt(edited, "genre-stereotype");
  assert.deepEqual(removed.map((item) => item.id), ["reader-expectation", "unique-attraction"]);
});
