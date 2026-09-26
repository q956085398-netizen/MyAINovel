import type { NoteEntry, NoteKind, RegionDraft, RegionRelation } from "./types";

export type DetailRow = [label: string, value: string];

function listText(values: string[]): string | null {
  return values.length > 0 ? values.join("、") : null;
}

function pushRow(rows: DetailRow[], label: string, value: string | null | undefined) {
  if (value?.trim()) rows.push([label, value]);
}

function chapterRange(start: number | null, end: number | null): string | null {
  if (start !== null && end !== null) {
    return start === end ? `第 ${start} 章` : `第 ${start}–${end} 章`;
  }
  if (start !== null) return `第 ${start} 章起`;
  if (end !== null) return `至第 ${end} 章`;
  return null;
}

/** 构思笔记完整字段投影；普通卡与待打磨便笺共用，避免两套字段漂移。 */
export function noteDetailRows(kind: NoteKind, note: NoteEntry): DetailRow[] {
  const rows: DetailRow[] = [];
  pushRow(rows, kind === "单元" ? "核心矛盾" : "一句话核心", note.core);
  if (kind === "矛盾") {
    pushRow(rows, "来源", note.source);
    pushRow(rows, "关联", listText(note.links));
  }
  if (kind === "单元") {
    pushRow(rows, "单元情绪目标", note.emotionGoal);
    pushRow(rows, "章节区间", chapterRange(note.startChapter, note.endChapter));
  }
  return rows;
}

/** 地域完整字段投影；归属与连接来自结构表，但与档案字段一起呈现。 */
export function regionDetailRows(
  region: RegionDraft,
  owner: string | null,
  connections: RegionRelation[],
): DetailRow[] {
  const rows: DetailRow[] = [];
  pushRow(rows, "所属地图", owner);
  pushRow(rows, "剧情功能", region.plotRole);
  pushRow(rows, "当地主线", region.localMainline);
  pushRow(rows, "秘密", region.secret);
  pushRow(rows, "人物", listText(region.people));
  pushRow(rows, "组织", listText(region.organizations));
  pushRow(rows, "矛盾", listText(region.contradictions));
  pushRow(rows, "单元", listText(region.units));
  pushRow(rows, "伏笔", listText(region.foreshadows));
  pushRow(rows, "时代", listText(region.eras));
  pushRow(rows, "展开为", region.expandsTo);
  pushRow(
    rows,
    "地域连接",
    connections.length > 0
      ? connections
          .map((relation) =>
            `${relation.kind}：${relation.from === region.name ? relation.to : relation.from}`,
          )
          .join("；")
      : null,
  );
  return rows;
}
