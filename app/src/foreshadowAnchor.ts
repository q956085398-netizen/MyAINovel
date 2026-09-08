import { WHITE_SPACE } from "./chapterFile";

/** 伏笔引文定位（工单 #6，docs/spec/伏笔系统.md）：与 Rust 侧
 *  `foreshadow::find_quote` 同一套规则（先精确子串，不中则去掉全部空白
 *  后再匹配），改一处必须同步另一处。返回 CM6 可用的 UTF-16 区间。 */

function isWhitespace(ch: string): boolean {
  return WHITE_SPACE.has(ch.codePointAt(0) ?? 0);
}

export function findQuote(text: string, quote: string): { from: number; to: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return { from: exact, to: exact + q.length };

  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isWhitespace(ch)) continue;
    norm += ch;
    map.push(i);
  }
  let normQuote = "";
  for (const ch of q) {
    if (!isWhitespace(ch)) normQuote += ch;
  }
  if (!normQuote) return null;
  const at = norm.indexOf(normQuote);
  if (at < 0) return null;
  return { from: map[at], to: map[at + normQuote.length - 1] + 1 };
}
