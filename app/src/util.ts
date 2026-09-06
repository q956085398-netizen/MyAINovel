import type { TropeSpan } from "./types";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 桥段章范围文案；起止是章标题序数（第几个章标题），非正文章号。 */
export function tropeSpanLabel(t: TropeSpan): string {
  return t.startChapter === t.endChapter
    ? `第${t.startChapter}章`
    : `第${t.startChapter}~${t.endChapter}章`;
}

/** 单行预览：折叠空白后压到 max 字，超长补省略号（卡片列表与导入预览共用）。 */
export function oneLinePreview(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}
