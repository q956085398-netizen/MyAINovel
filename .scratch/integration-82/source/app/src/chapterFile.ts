import type { ChapterEntry } from "./types";
import { STATUS_DONE, STATUS_DRAFT } from "./types";

/** 书写板块的纯函数（工单 #5）：字数口径与 Rust 侧 book_file.rs 同一套
 *  规则（前端算实时数、Rust 算扫盘数），改一处必须同步另一处；
 *  另有章节状态 frontmatter 的最小 upsert 与章号渲染。 */

/** 开头 frontmatter 块的行范围；没有块返回 null，未闭合时 close 为 -1。 */
function frontmatterBlock(text: string): { lines: string[]; inner: string[]; close: number } | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return { lines, inner: lines.slice(1, close === -1 ? undefined : close), close };
}

/** 去掉开头 frontmatter 块后的正文；未闭合时整块视为 frontmatter。 */
export function bodyAfterFrontmatter(content: string): string {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const block = frontmatterBlock(text);
  if (!block) return text;
  if (block.close === -1) return "";
  return block.lines.slice(block.close + 1).join("\n");
}

/** Unicode White_Space 集（与 Rust `char::is_whitespace` 对齐：JS 的
 *  `\s` 含 U+FEFF、不含 U+0085，直接用会算出不同的数）。 */
export const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Han 脚本码点区间（Unicode Scripts.txt；与 Rust book_file.rs::is_han
 *  同一张表——两边各一份，改一处要同步另一处）。 */
const HAN_RANGES: [number, number][] = [
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x3005, 0x3005],
  [0x3007, 0x3007],
  [0x3021, 0x3029],
  [0x3038, 0x303b],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b739],
  [0x2b740, 0x2b81d],
  [0x2b820, 0x2cea1],
  [0x2ceb0, 0x2ebe0],
  [0x2ebf0, 0x2ee5d],
  [0x30000, 0x3134a],
  [0x31350, 0x323af],
];

function isHan(cp: number): boolean {
  return HAN_RANGES.some(([from, to]) => cp >= from && cp <= to);
}

/** 计费字数：去空白、含标点（起点口径的近似）。 */
export function countBilled(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!WHITE_SPACE.has(ch.codePointAt(0) ?? 0)) n += 1;
  }
  return n;
}

/** 纯汉字数：Han 脚本字符（含扩展区、部首补充、々/〇）。 */
export function countHan(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (isHan(ch.codePointAt(0) ?? 0)) n += 1;
  }
  return n;
}

export function chapterStats(content: string): { wordCount: number; hanCount: number } {
  const body = bodyAfterFrontmatter(content);
  return { wordCount: countBilled(body), hanCount: countHan(body) };
}

/** 读 frontmatter 的「状态」键；缺省＝草稿。未闭合的块按无块处理
 *  （与 Rust 侧 split_frontmatter 的判法一致）。 */
export function readChapterStatus(content: string): string {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const block = frontmatterBlock(text);
  if (!block || block.close === -1) return STATUS_DRAFT;
  for (const line of block.inner) {
    const match = /^\s*状态\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    const comment = value.indexOf(" #");
    if (comment !== -1) value = value.slice(0, comment).trim();
    return value === STATUS_DONE ? STATUS_DONE : STATUS_DRAFT;
  }
  return STATUS_DRAFT;
}

/** frontmatter「状态」键的最小改动（保留其他键与正文、不动光标位置）。
 *  没有 frontmatter 块时在文首补一个；块未闭合时插在首行之后。 */
export function upsertFrontmatterStatus(
  doc: string,
  status: string,
): { from: number; to: number; insert: string } {
  const starts: number[] = [0];
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === "\n") starts.push(i + 1);
  }
  const lineAt = (n: number) => {
    const start = starts[n];
    const end = n + 1 < starts.length ? starts[n + 1] - 1 : doc.length;
    return { start, end, text: doc.slice(start, end) };
  };
  const first = lineAt(0);
  if (first.text.trim() !== "---") {
    return { from: 0, to: 0, insert: `---\n状态: ${status}\n---\n\n` };
  }
  let close = -1;
  for (let i = 1; i < starts.length; i++) {
    if (lineAt(i).text.trim() === "---") {
      close = i;
      break;
    }
  }
  const lastInner = close === -1 ? starts.length - 1 : close - 1;
  for (let i = 1; i <= lastInner; i++) {
    if (/^\s*状态\s*:/.test(lineAt(i).text)) {
      const line = lineAt(i);
      return { from: line.start, to: line.end, insert: `状态: ${status}` };
    }
  }
  return { from: first.end, to: first.end, insert: `\n状态: ${status}` };
}

/** 章号文案：按项目章前缀渲染（`第7章`）。 */
export function chapterHead(ordinal: number, prefix: string | null): string {
  const template = prefix?.trim() || "第{n}章";
  return template.includes("{n}")
    ? template.replace("{n}", String(ordinal))
    : `${template}${ordinal}`;
}

/** 列表与顶栏的章号文案：按项目章前缀渲染（`第7章 初入江湖`）。 */
export function chapterLabel(entry: ChapterEntry, prefix: string | null): string {
  if (entry.ordinal === null) return entry.fileName.replace(/\.md$/i, "");
  const head = chapterHead(entry.ordinal, prefix);
  return entry.title ? `${head} ${entry.title}` : `${head}（无标题）`;
}

/** 本地日期键 YYYY-MM-DD（今日字数的分桶）。 */
export function todayKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
