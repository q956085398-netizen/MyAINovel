import assert from "node:assert/strict";
import test from "node:test";

import type { ForeshadowView } from "../src/types.ts";
import { splitForeshadowViews } from "../src/foreshadowBoardModel.ts";

function view(name: string, pending: boolean, state = "已埋"): ForeshadowView {
  return {
    name,
    state,
    pending,
    planted: [],
    recovered: [],
    uncollectedChapters: null,
    overdue: false,
  };
}

test("待打磨伏笔只出现在顶部便笺区，整理后按原业务状态回到分组", () => {
  const polishing = view("玉佩", true, "已收");
  const ordinary = view("黄铜钥匙", false, "已埋");

  const sections = splitForeshadowViews([polishing, ordinary]);

  assert.deepEqual(sections.pending, [polishing]);
  assert.deepEqual(sections.ordinary, [ordinary]);
  assert.equal(sections.pending.length + sections.ordinary.length, 2);
  assert.equal(splitForeshadowViews([ordinary]).pending.length, 0);
});
