import type { ExpectationView } from "./types.ts";
import { EXPECTATION_KIND_GOAL, EXPECTATION_KIND_EXPECT } from "./types.ts";

export interface ExpectationPageSections {
  items: ExpectationView[];
  pending: ExpectationView[];
  grid: ExpectationView[];
}

/** 每个页签只展示原类别；待打磨线另进顶部便笺，不受时间线布局过滤。 */
export function expectationPageSections(
  items: ExpectationView[],
  kind: string,
): ExpectationPageSections {
  const pageItems = items.filter((item) =>
    kind === EXPECTATION_KIND_GOAL ? item.kind === EXPECTATION_KIND_GOAL : item.kind !== EXPECTATION_KIND_GOAL,
  );
  return {
    items: pageItems,
    pending: pageItems.filter((item) => item.pending),
    grid: pageItems.filter((item) => !item.pending),
  };
}

export function isExpectationSearchDestination(
  hit: { kind: string; projectDir: string | null; category: string | null } | null | undefined,
  project: string,
  kind: string,
): boolean {
  if (hit?.kind !== "期待线" || hit.projectDir !== project) return false;
  const hitKind = hit.category === EXPECTATION_KIND_GOAL ? EXPECTATION_KIND_GOAL : EXPECTATION_KIND_EXPECT;
  return hitKind === kind;
}
