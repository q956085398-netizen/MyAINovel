export type Layout = "scattered" | "folder-book";

/** 与 Rust 侧 book_file::MdContent 对应；fingerprint 为内容指纹的
 *  不透明令牌（字符串形态避开 u64 超 JS 安全整数），保存时带回对账（ADR 0004）。 */
export interface MdContent {
  content: string;
  fingerprint: string;
}

/** 与 Rust 侧 book_file::SaveResult 对应（serde 按状态打标签）。 */
export type SaveResult =
  | { status: "saved"; fingerprint: string }
  | { status: "conflict" };

/** 与 Rust 侧 trope.rs::TropeSpan 对应。起止为章标题序数（第几个章标题，1 起）。 */
export interface TropeSpan {
  startChapter: number;
  endChapter: number;
  types: string[];
  solution: string | null;
}

/** 与 Rust 侧 vocabulary.rs::Vocabulary 对应。合成提示 =
 *  词表.yaml 的词（文件序在前）＋库内已用词（按使用次数降序），去重。 */
export interface Vocabulary {
  types: string[];
  solutions: string[];
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

// --- AI 侧边栏（设计共识 §七）；与 Rust 侧 ai.rs 对应（IPC 走 camelCase） ---

/** 与 Rust 侧 ai.rs::AiProvider 对应。 */
export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 与 Rust 侧 ai.rs::AiConfig 对应。 */
export interface AiConfig {
  providers: AiProvider[];
  activeProviderId: string | null;
}

export type ChatRole = "system" | "user" | "assistant";

/** 与 Rust 侧 ai.rs::ChatMessage 对应；meta 为编辑器命令的选区信息等 opaque 载荷。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  meta?: MessageMeta | null;
}

/** 编辑器三命令落在消息上的上下文：采纳回写按选区行号定位
 *  （callout 插入选区末行行尾、标注按行号换算章范围；正文改动后行号可能过期，越界收敛）。 */
export interface MessageMeta {
  kind: AiCommandKind;
  startLine: number;
  endLine: number;
}

/** 与 Rust 侧 ai.rs::ChatSession 对应；id 由前端 crypto.randomUUID() 生成。 */
export interface ChatSession {
  id: string;
  title: string;
  /** Unix 秒。 */
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** 与 Rust 侧 ai.rs::ChatSessionSummary 对应。 */
export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** chat_stream 的 onEvent Channel 事件；与 Rust 侧 ai.rs::ChatStreamEvent 对应。 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; reason: string | null };

/** 编辑器三命令（设计共识 §七：AI 给初稿，人确认后才落盘）。 */
export type AiCommandKind = "梳理" | "标注" | "小结";

/** 编辑器发给 AI 面板的命令种子：选区文本＋行号（1 起）。 */
export interface AiSeed {
  kind: AiCommandKind;
  bookName: string;
  text: string;
  startLine: number;
  endLine: number;
  /** 小结命令带的章标题等说明。 */
  note?: string;
}

/** AI 面板当前文档快照（由编辑器注册的桥提供）。 */
export interface DocSnapshot {
  bookName: string;
  path: string;
  content: string;
}

/** 「建议类型/解法标注」的解析结果，与 TropeSpan 字段对齐。 */
export interface TropeSuggestion {
  types: string[];
  solution: string | null;
}

/** 编辑器向 AI 面板暴露的回写桥：采纳 AI 初稿的唯一落盘通道。 */
export interface EditorBridge {
  getDoc(): DocSnapshot | null;
  /** 在选区末行（anchorLine，1 起）行尾插入 callout 块，返回是否成功（编辑器未就绪则 false）。 */
  adoptCallout(kind: "点评" | "小结", text: string, anchorLine: number): boolean;
  /** 按选区行号换算章范围，预填并打开桥段标注对话框。 */
  adoptTrope(startLine: number, endLine: number, s: TropeSuggestion): void;
}
