import assert from "node:assert/strict";
import test from "node:test";

import { createPowerSystemDraft } from "../src/powerSystem.ts";

test("力量体系可从可删提示或空白正文开始，不要求等级字段", () => {
  const guided = createPowerSystemDraft(true);
  assert.equal(guided.kind, "世界观");
  assert.equal(guided.category, "力量体系");
  assert.equal(guided.name, "");
  for (const heading of ["等级边界", "力量来源", "成长条件", "代价限制", "主角例外", "剧情展示", "下一阶段期待"]) {
    assert.ok(guided.body.includes(`## ${heading}`), heading);
  }
  const blank = createPowerSystemDraft(false);
  assert.equal(blank.body, "");
  assert.equal(blank.category, "力量体系");
  assert.equal(blank.startChapter, null);
});
