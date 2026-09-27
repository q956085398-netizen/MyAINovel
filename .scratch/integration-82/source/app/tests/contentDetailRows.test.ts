import assert from "node:assert/strict";
import test from "node:test";

import { noteDetailRows, regionDetailRows } from "../src/contentDetailRows.ts";
import { emptyNoteDraft, emptyRegionDraft } from "../src/types.ts";

test("单元便笺显示情绪目标与章节区间", () => {
  const note = {
    ...emptyNoteDraft("单元", "破城"),
    path: "构思/单元/破城.md",
    pending: true,
    emotionGoal: "先压抑，后酣畅",
    startChapter: 12,
    endChapter: 16,
  };

  assert.deepEqual(noteDetailRows("单元", note), [
    ["单元情绪目标", "先压抑，后酣畅"],
    ["章节区间", "第 12–16 章"],
  ]);
});

test("没有来源的矛盾仍显示关联", () => {
  const note = {
    ...emptyNoteDraft("矛盾", "旧案"),
    path: "构思/矛盾/旧案.md",
    pending: true,
    links: ["《北境》/雪夜"],
  };

  assert.deepEqual(noteDetailRows("矛盾", note), [["关联", "《北境》/雪夜"]]);
});

test("地域便笺包含归属、展开地图与地域连接", () => {
  const region = {
    ...emptyRegionDraft(),
    name: "京城",
    path: "构思/地域/京城.md",
    pending: true,
    expandsTo: "皇城详图",
  };
  const connections = [{ from: "京城", to: "渡口", kind: "通道", extra: {} }];

  assert.deepEqual(regionDetailRows(region, "人间", connections), [
    ["所属地图", "人间"],
    ["展开为", "皇城详图"],
    ["地域连接", "通道：渡口"],
  ]);
});
