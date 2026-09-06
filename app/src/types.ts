export type Layout = "scattered" | "folder-book";

/** 与 Rust 侧 library::BookEntry 对应（serde camelCase）。 */
export interface BookEntry {
  name: string;
  layout: Layout;
  primaryMd: string;
  mdCount: number;
  yamlPath: string | null;
  chapterCount: number;
  wordCount: number;
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
