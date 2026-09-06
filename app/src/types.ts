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
