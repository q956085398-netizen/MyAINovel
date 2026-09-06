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
