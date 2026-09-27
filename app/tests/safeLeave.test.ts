/** 可安全离开约定的循环骨架（工单 #77）：有界收敛、被阻止与陈旧在途。 */
import assert from "node:assert/strict";
import test from "node:test";

import { settleForLeave, SETTLE_MAX_ROUNDS, type SettleableBuffer } from "../src/safeLeave.ts";

function manualBuffer(init: {
  dirty?: boolean;
  conflict?: boolean;
  /** 每轮保存后是否又变脏（模拟保存往返期间继续输入）。 */
  dirtyAfterRound?: boolean;
  roundFails?: boolean;
}) {
  let dirty = init.dirty ?? false;
  let rounds = 0;
  const buffer: SettleableBuffer = {
    isDirty: () => dirty,
    inConflict: () => init.conflict ?? false,
    inFlightSave: () => null,
    saveRound: async () => {
      rounds += 1;
      if (init.roundFails) return false;
      dirty = init.dirtyAfterRound ?? false;
      return true;
    },
  };
  return { buffer, roundsDone: () => rounds };
}

test("干净缓冲直接放行，不发起保存轮", async () => {
  const b = manualBuffer({ dirty: false });
  assert.equal(await settleForLeave(b.buffer), "done");
  assert.equal(b.roundsDone(), 0);
});

test("脏缓冲一轮保存后放行", async () => {
  const b = manualBuffer({ dirty: true });
  assert.equal(await settleForLeave(b.buffer), "done");
  assert.equal(b.roundsDone(), 1);
});

test("保存往返期间继续输入：逐轮收敛到稳定版本", async () => {
  // 前两轮保存完成后缓冲里仍有新输入（重新变脏），第三轮后干净。
  let retypesLeft = 2;
  let rounds = 0;
  let dirty = true;
  const buffer: SettleableBuffer = {
    isDirty: () => dirty,
    inConflict: () => false,
    inFlightSave: () => null,
    saveRound: async () => {
      rounds += 1;
      dirty = retypesLeft > 0;
      if (retypesLeft > 0) retypesLeft -= 1;
      return true;
    },
  };
  assert.equal(await settleForLeave(buffer), "done");
  assert.equal(rounds, 3);
});

test("持续输入不收敛：到轮次上限就报 busy 阻止导航（不无限重试）", async () => {
  const b = manualBuffer({ dirty: true, dirtyAfterRound: true });
  assert.equal(await settleForLeave(b.buffer), "busy");
  assert.equal(b.roundsDone(), SETTLE_MAX_ROUNDS);
});

test("冲突未裁决：不发起保存，直接以 conflict 阻止", async () => {
  const b = manualBuffer({ dirty: true, conflict: true });
  assert.equal(await settleForLeave(b.buffer), "conflict");
  assert.equal(b.roundsDone(), 0);
});

test("保存轮失败：立即以 failed 阻止，不无限重试", async () => {
  const b = manualBuffer({ dirty: true, roundFails: true });
  assert.equal(await settleForLeave(b.buffer), "failed");
  assert.equal(b.roundsDone(), 1);
});

test("已有在途保存：等它完成，不另起一轮挤门闩", async () => {
  let dirty = true;
  let release!: () => void;
  // 在途保存完成时清脏标（对应 saveNow 成功后清 dirtyRef）。
  const flight = new Promise<void>((resolve) => {
    release = resolve;
  }).then(() => {
    dirty = false;
  });
  let saveRoundCalls = 0;
  const buffer: SettleableBuffer = {
    isDirty: () => dirty,
    inConflict: () => false,
    inFlightSave: () => flight,
    saveRound: async () => {
      saveRoundCalls += 1;
      return true;
    },
  };
  const settled = settleForLeave(buffer);
  let done = false;
  void settled.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, "在途保存完成前结算不放行");
  release();
  assert.equal(await settled, "done");
  assert.equal(saveRoundCalls, 0, "在途保存存在时不另起保存轮");
});
