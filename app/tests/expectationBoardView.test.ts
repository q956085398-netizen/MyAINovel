import assert from "node:assert/strict";
import test from "node:test";

import {
  expectationPageSections,
  isExpectationSearchDestination,
} from "../src/expectationBoardView.ts";
import type { ExpectationView } from "../src/types.ts";

function line(name: string, kind: string, pending: boolean): ExpectationView {
  return {
    name,
    kind,
    horizon: "短",
    state: "部分兑现",
    pending,
    planted: [],
    fulfilled: [],
    unadvancedChapters: null,
    overdue: false,
  };
}

test("待打磨线分别留在期待感与目标顶部，不进入时间线网格", () => {
  const items = [
    line("期待便笺", "期待", true),
    line("普通期待线", "期待", false),
    line("目标便笺", "目标", true),
    line("普通目标线", "目标", false),
  ];

  const expectation = expectationPageSections(items, "期待");
  assert.deepEqual(expectation.items.map((item) => item.name), ["期待便笺", "普通期待线"]);
  assert.deepEqual(expectation.pending.map((item) => item.name), ["期待便笺"]);
  assert.deepEqual(expectation.grid.map((item) => item.name), ["普通期待线"]);

  const goals = expectationPageSections(items, "目标");
  assert.deepEqual(goals.items.map((item) => item.name), ["目标便笺", "普通目标线"]);
  assert.deepEqual(goals.pending.map((item) => item.name), ["目标便笺"]);
  assert.deepEqual(goals.grid.map((item) => item.name), ["普通目标线"]);
  assert.deepEqual(expectationPageSections([], "目标").pending, []);

  const targetHit = { kind: "期待线", projectDir: "项目/《书》", category: "目标" };
  assert.equal(isExpectationSearchDestination(targetHit, "项目/《书》", "目标"), true);
  assert.equal(isExpectationSearchDestination(targetHit, "项目/《书》", "期待"), false);
  assert.equal(isExpectationSearchDestination(targetHit, "项目/《另一本书》", "目标"), false);
  assert.equal(
    isExpectationSearchDestination(
      { ...targetHit, category: "手写类别" },
      "项目/《书》",
      "期待",
    ),
    true,
  );
});
