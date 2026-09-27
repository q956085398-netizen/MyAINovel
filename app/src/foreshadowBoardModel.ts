import type { ForeshadowView } from "./types";

export interface ForeshadowSections {
  pending: ForeshadowView[];
  ordinary: ForeshadowView[];
}

/** 待打磨只改变看板位置；整理完成后回到原业务状态分组。 */
export function splitForeshadowViews(views: ForeshadowView[]): ForeshadowSections {
  return {
    pending: views.filter((view) => view.pending),
    ordinary: views.filter((view) => !view.pending),
  };
}
