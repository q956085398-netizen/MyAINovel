import assert from "node:assert/strict";
import test from "node:test";

import { saveRegionFlow } from "../src/regionSaveFlow.ts";
import { emptyRegionDraft } from "../src/types.ts";

test("归属保存失败后重试沿用已经落盘的新路径", async () => {
  const usedPrevPaths: Array<string | null> = [];
  let containmentAttempts = 0;
  let currentPath: string | null = "构思/地域/旧城.md";
  const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    if (command === "save_region") {
      usedPrevPaths.push(args.prevPath as string | null);
      return {
        ...emptyRegionDraft(),
        name: "新城",
        path: "构思/地域/新城.md",
        pending: false,
      } as T;
    }
    containmentAttempts += 1;
    if (containmentAttempts === 1) throw new Error("结构表暂时不可写");
    return undefined as T;
  };
  const request = {
    project: "项目/《山河》",
    draft: { ...emptyRegionDraft(), name: "新城" },
    prevName: "旧城",
    owner: "人间",
    ownerMap: "仙界",
  };

  await assert.rejects(() =>
    saveRegionFlow(invoke, { ...request, prevPath: currentPath }, (entry) => {
      currentPath = entry.path;
    }),
  );
  await saveRegionFlow(invoke, { ...request, prevPath: currentPath }, (entry) => {
    currentPath = entry.path;
  });

  assert.deepEqual(usedPrevPaths, ["构思/地域/旧城.md", "构思/地域/新城.md"]);
});
