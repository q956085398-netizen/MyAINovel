export type Layout = "scattered" | "folder-book";

/** 与 Rust 侧 trope.rs::TropeSpan 对应。起止为章标题序数（第几个章标题，1 起）。 */
export interface TropeSpan {
  startChapter: number;
  endChapter: number;
  types: string[];
  solution: string | null;
}

/** 与 Rust 侧 book_file::ChapterAnchor 对应。 */
export interface ChapterAnchor {
  ordinal: number;
  title: string;
  line: number;
}

/** 与 Rust 侧 search.rs::SearchHit 对应。 */
export interface SearchHit {
  bookName: string;
  primaryMd: string;
  line: number;
  snippet: string;
}

/** 与 Rust 侧 library::BookEntry 对应（serde camelCase）。 */
export interface BookEntry {
  name: string;
  layout: Layout;
  primaryMd: string;
  mdCount: number;
  chapterCount: number;
  wordCount: number;
  meta: BookMeta;
  tropes: TropeSpan[];
}

/** 与 Rust 侧 book_file::BookMeta 对应（IPC 走 camelCase；yaml 落盘键为中文）。 */
export interface BookMeta {
  title: string | null;
  trackRecord: string | null;
  summary: string | null;
  goldenFinger: string | null;
  chapterPrefix: string | null;
}

export function emptyBookMeta(): BookMeta {
  return { title: null, trackRecord: null, summary: null, goldenFinger: null, chapterPrefix: null };
}

/** 与 Rust 侧 inspiration.rs::CardCategory 对应（serde 值即中文类别名，
 *  也是「灵感库/」下的文件夹名）。 */
export type CardCategory =
  | "故事卡"
  | "金手指卡"
  | "题材卡"
  | "片段卡"
  | "角色卡"
  | "组织卡"
  | "世界观卡"
  | "技法卡"
  | "书名卡"
  | "未分类";

export const CARD_CATEGORIES: CardCategory[] = [
  "故事卡",
  "金手指卡",
  "题材卡",
  "片段卡",
  "角色卡",
  "组织卡",
  "世界观卡",
  "技法卡",
  "书名卡",
  "未分类",
];

/** 与 Rust 侧 inspiration.rs::CardDraft 对应（IPC 走 camelCase）。 */
export interface CardDraft {
  category: CardCategory;
  title: string;
  tags: string[];
  source: string | null;
  /** 关联：拆书记录/桥段/其他卡片，自由文本，按名解析跳转。 */
  links: string[];
  /** 一句话核心（人物＋困境＋爽点预期），故事卡专属。 */
  core: string | null;
  body: string;
}

/** 与 Rust 侧 inspiration.rs::InspirationCard 对应；path 即卡片身份。 */
export interface InspirationCard extends CardDraft {
  path: string;
  /** Unix 秒，最近在前排序。 */
  mtime: number;
}

/** 与 Rust 侧 inspiration.rs::ImportEntry 对应。 */
export interface ImportEntry {
  title: string;
  body: string;
  tags: string[];
  category: CardCategory;
}

export function emptyCardDraft(category: CardCategory = "故事卡"): CardDraft {
  return { category, title: "", tags: [], source: null, links: [], core: null, body: "" };
}
