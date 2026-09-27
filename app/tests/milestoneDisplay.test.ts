import assert from "node:assert/strict";
import test from "node:test";

import { milestoneDisplay, pendingMilestoneEntries } from "../src/milestoneDisplay.ts";
import type { Milestone, StoryLine } from "../src/types.ts";

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    title: "重复标题",
    change: null,
    readerFeeling: null,
    units: [],
    note: null,
    pending: false,
    source: null,
    ...overrides,
  };
}

test("大纲顶部便笺保留主线语境、重复标题与原位置次序", () => {
  const lines: StoryLine[] = [
    {
      name: "为父正名",
      isMain: true,
      milestones: [
        milestone({ pending: true, source: { lineIndex: 0, milestoneIndex: 0 } }),
        milestone({ pending: false, source: { lineIndex: 0, milestoneIndex: 1 } }),
        milestone({ pending: true, source: { lineIndex: 0, milestoneIndex: 2 } }),
      ],
    },
    {
      name: "感情线",
      isMain: false,
      milestones: [
        milestone({ pending: true, source: { lineIndex: 1, milestoneIndex: 0 } }),
      ],
    },
  ];

  const notes = pendingMilestoneEntries(lines);
  assert.deepEqual(notes.map((entry) => entry.key), ["0:0", "0:2", "1:0"]);
  assert.deepEqual(notes.map((entry) => entry.context), [
    "主线 · 为父正名 · 原表第1条情节线，第1个里程碑",
    "主线 · 为父正名 · 原表第1条情节线，第3个里程碑",
    "情节线 · 感情线 · 原表第2条情节线，第1个里程碑",
  ]);
  assert.deepEqual(notes.map((entry) => [entry.lineIndex, entry.milestoneIndex]), [
    [0, 0],
    [0, 2],
    [1, 0],
  ]);

  lines[0].milestones[0].pending = false;
  assert.deepEqual(
    pendingMilestoneEntries(lines).map((entry) => entry.key),
    ["0:2", "1:0"],
    "整理完成后该条目回归原主线数组位置，其余次序不变",
  );
  assert.deepEqual(pendingMilestoneEntries(lines.slice(0, 1)).map((entry) => entry.key), ["0:2"]);
  lines.forEach((line) => line.milestones.forEach((item) => { item.pending = false; }));
  assert.deepEqual(pendingMilestoneEntries(lines), [], "没有待打磨对象时顶部区域数量为零");
});

test("主线里程碑便笺投影呈现全部已填字段", () => {
  const note = milestone({
    title: "拿到旧账",
    change: "从猜测转为掌握证据",
    readerFeeling: "痛快又不安",
    units: ["初入京城", "朝堂对质"],
    note: "证人身份仍需核实。",
    pending: true,
    source: { lineIndex: 1, milestoneIndex: 2 },
  });

  assert.deepEqual(milestoneDisplay(note), {
    title: "拿到旧账",
    change: "从猜测转为掌握证据",
    readerFeeling: "痛快又不安",
    units: ["初入京城", "朝堂对质"],
    note: "证人身份仍需核实。",
  });
});
