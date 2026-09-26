import assert from "node:assert/strict";
import test from "node:test";
import { characterDetailRows, emptyCharacterProfile, membershipSummary } from "../src/characterProfile.ts";

test("旧人物与空档案不生成必填提示", () => {
  assert.deepEqual(characterDetailRows(), []);
  assert.deepEqual(characterDetailRows(emptyCharacterProfile()), []);
});

test("人物完整字段和多组织身份保持自由文本", () => {
  assert.deepEqual(characterDetailRows({ ...emptyCharacterProfile(), identity: "守门人", age: "看起来二十岁", weakness: "失聪一天", traits: ["谨慎", "执拗"] }), [
    ["一句话身份", "守门人"], ["年龄或年龄感", "看起来二十岁"], ["弱点或代价", "失聪一天"], ["性格关键词", "谨慎、执拗"],
  ]);
  assert.equal(membershipSummary({ person: "甲", organization: "山门", kind: "成员", role: "守门人", status: "前任", secret: true, note: "未公开离开" }), "山门 · 成员 · 守门人 · 前任 · 秘密 · 未公开离开");
});
