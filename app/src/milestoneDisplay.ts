import type { Milestone, StoryLine } from "./types";

export interface MainlineMilestoneEntry {
  key: string;
  lineIndex: number;
  milestoneIndex: number;
  line: StoryLine;
  milestone: Milestone;
  context: string;
}

/** 大纲页顶部便笺投影：保留原主线位置与语境，重复标题仍各自可定位。 */
export function pendingMilestoneEntries(lines: StoryLine[]): MainlineMilestoneEntry[] {
  return lines.flatMap((line, lineIndex) => line.milestones.flatMap((milestone, milestoneIndex) => {
    if (!milestone.pending) return [];
    const source = milestone.source;
    return [{
      key: source
        ? `${source.lineIndex}:${source.milestoneIndex}`
        : `${lineIndex}:${milestoneIndex}`,
      lineIndex,
      milestoneIndex,
      line,
      milestone,
      context: `${line.isMain ? "主线" : "情节线"} · ${line.name || "未命名情节线"} · 原表第${(source?.lineIndex ?? lineIndex) + 1}条情节线，第${(source?.milestoneIndex ?? milestoneIndex) + 1}个里程碑`,
    }];
  }));
}

/** 普通卡与顶部待打磨便笺共用的完整已填内容。 */
export function milestoneDisplay(milestone: Milestone) {
  return {
    title: milestone.title,
    change: milestone.change?.trim() || null,
    readerFeeling: milestone.readerFeeling?.trim() || null,
    units: milestone.units.map((unit) => unit.trim()).filter(Boolean),
    note: milestone.note?.trim() || null,
  };
}
