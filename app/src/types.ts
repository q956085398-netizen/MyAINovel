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
  /** 封面文件（约定文件名 附件/封面.png|jpg|webp 现查现识别）；无封面为 null。 */
  cover: string | null;
  /** 封面目录（「设封面」的拷贝落点，Rust 侧约定）。 */
  coverDir: string;
}

/** 与 Rust 侧 book_file::BookMeta 对应（IPC 走 camelCase；yaml 落盘键为中文）。 */
export interface BookMeta {
  title: string | null;
  trackRecord: string | null;
  summary: string | null;
  goldenFinger: string | null;
  chapterPrefix: string | null;
}

// --- 构思项目（工单 #4，docs/spec/构思数据模型.md）；与 Rust 侧 project.rs 对应 ---

/** 与 Rust 侧 project::ProjectEntry 对应（IPC 走 camelCase）。 */
export interface ProjectEntry {
  /** 项目文件夹路径，即项目身份。 */
  dir: string;
  /** 文件夹名（应用新建时带《》）。 */
  name: string;
  /** 书名：项目.yaml 的「书名」，缺省＝文件夹名去《》。 */
  title: string;
  chapterCount: number;
  wordCount: number;
  unitCount: number;
  contradictionCount: number;
  characterCount: number;
  worldviewCount: number;
  openingCount: number;
  /** 伏笔条数（伏笔.yaml）。 */
  foreshadowCount: number;
  /** 三线条数（三线.yaml）。 */
  expectationCount: number;
  /** 封面文件（约定文件名 附件/封面.png|jpg|webp 现查现识别）；无封面为 null。 */
  cover: string | null;
  /** 封面目录（「设封面」的拷贝落点）＝项目内 附件/。 */
  coverDir: string;
}

/** 与 Rust 侧 project::PlotLine 对应（yaml 落盘键为「名/色」）。 */
export interface PlotLine {
  name: string;
  color: string | null;
}

/** 与 Rust 侧 project::ProjectMeta 对应（yaml 落盘键为中文）。 */
export interface ProjectMeta {
  title: string | null;
  chapterPrefix: string | null;
  plotLines: PlotLine[];
  maps: string[];
}

export function emptyProjectMeta(): ProjectMeta {
  return { title: null, chapterPrefix: null, plotLines: [], maps: [] };
}

/** 与 Rust 侧 project::NoteKind 对应（serde 值即中文类别名，也是构思下的目录名）。 */
export type NoteKind = "矛盾" | "单元" | "人物" | "世界观" | "开头";

export const NOTE_KINDS: NoteKind[] = ["矛盾", "单元", "人物", "世界观", "开头"];

/** 与 Rust 侧 project::NoteDraft 对应（IPC 走 camelCase）；
 *  五类共用一张宽表，落盘时只写本类别的键。 */
export interface NoteDraft {
  kind: NoteKind;
  /** 标题＝文件名（矛盾/单元名、人名、词条名、版本名）。 */
  name: string;
  /** 矛盾＝一句话核心；单元＝核心矛盾。 */
  core: string | null;
  types: string[];
  source: string | null;
  links: string[];
  /** 矛盾＝池中｜已成单元｜弃用；开头＝备选｜选定（约定值只提示不校验）。 */
  status: string | null;
  group: string | null;
  aliases: string[];
  /** 世界观＝力量体系｜地理｜势力｜其他。 */
  category: string | null;
  /** 单元专用：单元区间（起章/止章，书写侧栏按它反查「本章属于哪个单元」）。 */
  startChapter: number | null;
  endChapter: number | null;
  body: string;
}

export function emptyNoteDraft(kind: NoteKind, name = ""): NoteDraft {
  return {
    kind,
    name,
    core: null,
    types: [],
    source: null,
    links: [],
    status: null,
    group: null,
    aliases: [],
    category: null,
    startChapter: null,
    endChapter: null,
    body: "",
  };
}

/** 与 Rust 侧 project::NoteEntry 对应；path 即笔记身份。 */
export interface NoteEntry extends NoteDraft {
  path: string;
}

/** 与 Rust 侧 project::Circle 对应（构思/类型圈.md）。 */
export interface Circle {
  types: string[];
  body: string;
}

/** 与 Rust 侧 project::ArrangementItem 对应；下标即未知键（手补的行内
 *  字段，原样带回，不在界面上编辑）。 */
export interface ArrangementItem {
  unit: string;
  line: string | null;
  map: string | null;
  /** 升级｜战斗（2:1 体检用）。 */
  upgradeBattle: string | null;
  /** 紧绷｜舒缓（张弛交替用）。 */
  pace: string | null;
  /** 手补的行内未知键（原样带回，不在界面上编辑）。 */
  [extra: string]: string | null | undefined;
}

/** 与 Rust 侧 project::MapCount 对应。 */
export interface MapCount {
  map: string;
  count: number;
}

/** 与 Rust 侧 project::ArrangementCheck 对应（派生视图，只提示不拦截）。 */
export interface ArrangementCheck {
  ratioHint: string;
  paceHints: string[];
  refHints: string[];
  missingUnits: string[];
  unarrangedUnits: string[];
  mapCounts: MapCount[];
}

/** 排布属性的约定值（只提示不校验，词表同款纪律）。 */
export const UPGRADE_BATTLE_VALUES = ["升级", "战斗"];
export const PACE_VALUES = ["紧绷", "舒缓"];
export const WORLDVIEW_CATEGORIES = ["力量体系", "地理", "势力", "其他"];
export const OPENING_STATUS_VALUES = ["备选", "选定"];
export const CONTRADICTION_STATUS_VALUES = ["池中", "已成单元", "弃用"];

// --- 书写板块（工单 #5，docs/spec/书写编辑器.md）；与 Rust 侧 chapter.rs 对应 ---

/** 一章一文件 `正文/<NNNN 标题>.md`；序在文件名、标题可改、序不动。 */
export interface ChapterEntry {
  path: string;
  fileName: string;
  /** 文件名里的章序；未编号文件为 null。 */
  ordinal: number | null;
  title: string;
  /** 草稿｜完稿（缺省＝草稿）。 */
  status: string;
  /** 计费字数（去空白、含标点，不含 frontmatter）。 */
  wordCount: number;
  /** 纯汉字数。 */
  hanCount: number;
}

/** 保存前的历史版本（`.gongbi/历史/<章>/<时间戳>.md`）。 */
export interface SnapshotEntry {
  path: string;
  /** Unix 毫秒。 */
  time: number;
  wordCount: number;
}

/** 联动侧栏的单元摘要（本章所在单元＋它在排布里的位置）。 */
export interface UnitBrief {
  name: string;
  core: string | null;
  types: string[];
  body: string;
  startChapter: number | null;
  endChapter: number | null;
  /** 在排布.yaml 中的位次（1 起）；未排布＝null。 */
  index: number | null;
  total: number;
  line: string | null;
  map: string | null;
  upgradeBattle: string | null;
  pace: string | null;
}

/** 与 Rust 侧 chapter.rs::WritingStats 对应（应用状态，不进创作目录）。 */
export interface WritingStats {
  dailyGoal: number;
  /** 日期 YYYY-MM-DD → 当日净增量（可为负）。 */
  daily: Record<string, number>;
}

export function emptyWritingStats(): WritingStats {
  return { dailyGoal: 2000, daily: {} };
}

/** 章节状态两态（约定值只提示不校验）。 */
export const CHAPTER_STATUS_VALUES = ["草稿", "完稿"];
export const STATUS_DRAFT = "草稿";
export const STATUS_DONE = "完稿";

// --- 导出与发布（工单 #14，docs/spec/导出与发布.md）；与 Rust 侧 export.rs / proofread.rs 对应 ---

/** 章节范围；from/to 全空＝全书，单章＝from==to。 */
export interface ChapterRange {
  from: number | null;
  to: number | null;
}

/** 渠道模板：存应用状态，跨项目共用；章前缀始终取项目.yaml。 */
export interface ExportTemplate {
  name: string;
  /** txt（平台粘贴口径）｜md（保留 markdown）。 */
  format: string;
  chapterHeading: boolean;
  /** 标题模板，占位符 {章号}/{标题}；null＝「{章号} {标题}」。 */
  headingTemplate: string | null;
  /** 段间空行数（0｜1）。 */
  blankLines: number;
  indent: boolean;
  /** 单章字数提示下限（0＝不提示）。 */
  minWords: number;
  /** 单章字数提示上限（0＝不限）。 */
  maxWords: number;
}

export function defaultExportTemplate(): ExportTemplate {
  return {
    name: "默认",
    format: "txt",
    chapterHeading: true,
    headingTemplate: null,
    blankLines: 1,
    indent: false,
    minWords: 2000,
    maxWords: 0,
  };
}

export interface ExportChapterReport {
  ordinal: number;
  title: string;
  fileName: string;
  wordCount: number;
  imagesDropped: number;
  /** 空章 / 字数越界 / frontmatter 未闭合等提示（只提示不拦截）。 */
  notes: string[];
}

export interface ExportReport {
  path: string;
  format: string;
  chapterCount: number;
  wordCount: number;
  chapters: ExportChapterReport[];
  /** 未编号文件跳过等整体警告。 */
  warnings: string[];
}

/** 写作页跳转落点：伏笔/三线看板带 ordinal＋引文，发布前校对带 path＋
 *  行号＋第几次出现（更精确）。line 给了就按行定位，否则全文找引文。 */
export interface WritingLocate {
  ordinal: number | null;
  path?: string;
  quote: string;
  /** 1 起行号（原始文件行）。 */
  line?: number;
  occurrence?: number;
}

/** 校对命中：line 为原始文件行号（与编辑器缓冲同口径），
 *  occurrence 为命中词在本行内第几次出现（0 起），跳回时据此定位。 */
export interface ProofIssue {
  ordinal: number | null;
  fileName: string;
  path: string;
  line: number;
  occurrence: number;
  word: string;
  suggestion: string | null;
  /** 敏感词｜的地得｜错词。 */
  kind: string;
  snippet: string;
}

export interface ProofReport {
  issues: ProofIssue[];
  scannedChapters: number;
  sensitiveWords: number;
  wrongWords: number;
  /** 库根「校对/敏感词.txt」是否存在（不存在时提示怎么建）。 */
  sensitiveFileExists: boolean;
}

export const PROOFREAD_KIND_SENSITIVE = "敏感词";
export const PROOFREAD_KIND_DE = "的地得";
export const PROOFREAD_KIND_WRONG = "错词";

// --- 伏笔系统（工单 #6，docs/spec/伏笔系统.md）；与 Rust 侧 foreshadow.rs 对应 ---

/** 埋设锚点：章序数（第几个章标题，1 起）＋选中引文（正文零污染）。 */
export interface ForeshadowAnchor {
  chapter: number;
  quote: string;
}

/** 回收记录：类型＝阶段｜终结。 */
export interface ForeshadowRecovery {
  chapter: number;
  quote: string;
  kind: string;
  note: string | null;
}

/** 伏笔条目（项目根 伏笔.yaml，应用受管、整表重写）。 */
export interface Foreshadow {
  name: string;
  /** 待埋｜已埋｜部分收｜已收｜弃用（约定值只提示不校验）。 */
  state: string;
  planted: ForeshadowAnchor[];
  recovered: ForeshadowRecovery[];
}

/** 看板条目：派生字段（未收章数、超期、引文失配）。 */
export interface ForeshadowView {
  name: string;
  state: string;
  planted: (ForeshadowAnchor & { stale: boolean })[];
  recovered: (ForeshadowRecovery & { stale: boolean })[];
  /** 距当前最大章序已过多少章未收（仅已埋/部分收有值）。 */
  uncollectedChapters: number | null;
  overdue: boolean;
}

export const FORESHADOW_STATES = ["待埋", "已埋", "部分收", "已收", "弃用"] as const;
export const FORESHADOW_STATE_PENDING = "待埋";
export const FORESHADOW_STATE_PLANTED = "已埋";
export const FORESHADOW_STATE_PARTIAL = "部分收";
export const FORESHADOW_STATE_DONE = "已收";
export const FORESHADOW_STATE_DROPPED = "弃用";
export const FORESHADOW_RECOVERY_KINDS = ["阶段", "终结"] as const;
export const FORESHADOW_RECOVERY_FINAL = "终结";
/** 超期阈值（与 Rust 侧 foreshadow::OVERDUE_CHAPTERS 一致）。 */
export const FORESHADOW_OVERDUE_CHAPTERS = 20;

// --- 期待感/目标三线（工单 #7，docs/spec/期待感三线.md）；与 Rust 侧 expectation.rs 对应 ---

/** 埋设锚点：章序数（第几个章标题，1 起）＋选中引文（正文零污染）。 */
export interface ExpectationAnchor {
  chapter: number;
  quote: string;
}

/** 兑现记录：类型＝阶段｜终结。 */
export interface ExpectationPayoff {
  chapter: number;
  quote: string;
  kind: string;
  note: string | null;
}

/** 期待线条目（项目根 三线.yaml，应用受管、整表重写）。 */
export interface Expectation {
  name: string;
  /** 期待｜目标（约定值只提示不校验）。 */
  kind: string;
  /** 短｜中｜长（时间线网格的行）。 */
  horizon: string;
  /** 待埋｜已埋｜部分兑现｜已兑现｜弃用（约定值只提示不校验）。 */
  state: string;
  planted: ExpectationAnchor[];
  fulfilled: ExpectationPayoff[];
}

/** 看板条目：派生字段（未推进章数、超期、引文失配）。 */
export interface ExpectationView {
  name: string;
  kind: string;
  horizon: string;
  state: string;
  planted: (ExpectationAnchor & { stale: boolean })[];
  fulfilled: (ExpectationPayoff & { stale: boolean })[];
  /** 距当前最大章序已过多少章未推进（仅已埋/部分兑现有值）。 */
  unadvancedChapters: number | null;
  overdue: boolean;
}

/** 时间线网格数据：轴长＋条目。 */
export interface ExpectationBoard {
  /** 轴长＝max(全书最大章序, 锚点最大章)。 */
  maxChapter: number;
  items: ExpectationView[];
}

export const EXPECTATION_KINDS = ["期待", "目标"] as const;
export const EXPECTATION_KIND_EXPECT = "期待";
export const EXPECTATION_KIND_GOAL = "目标";
export const EXPECTATION_HORIZONS = ["短", "中", "长"] as const;
export const EXPECTATION_HORIZON_MID = "中";
export const EXPECTATION_STATES = ["待埋", "已埋", "部分兑现", "已兑现", "弃用"] as const;
export const EXPECTATION_STATE_PLANTED = "已埋";
export const EXPECTATION_STATE_PARTIAL = "部分兑现";
export const EXPECTATION_STATE_DONE = "已兑现";
export const EXPECTATION_STATE_DROPPED = "弃用";
export const EXPECTATION_PAYOFF_KINDS = ["阶段", "终结"] as const;
export const EXPECTATION_PAYOFF_FINAL = "终结";
/** 超期阈值按档位（与 Rust 侧 expectation::OVERDUE_* 一致）。 */
export const EXPECTATION_OVERDUE_CHAPTERS: Record<string, number> = { 短: 8, 中: 20, 长: 50 };
export function expectationOverdueChapters(horizon: string): number {
  return EXPECTATION_OVERDUE_CHAPTERS[horizon] ?? EXPECTATION_OVERDUE_CHAPTERS["中"];
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

// --- 人物关系画布（工单 #8，docs/spec/人物关系画布.md）；与 Rust 侧 relationship.rs 对应 ---

/** 图例项：画布级「可命名、有序、可绑定方向的分类集合」。 */
export interface LegendItem {
  name: string;
  color: string;
  /** 方向是图例项的属性，边继承它（不逐条设）。 */
  directed: boolean;
}

/** 一条关系（边）：起→止 只表示有向边的方向，不表示归属——关系网是一张网。 */
export interface Relationship {
  from: string;
  to: string;
  /** 类型，按名引用图例项（图例外照画兜底样式，只提示）。 */
  kind: string;
  note: string | null;
  /** 秘密标记：可叠加在任何类型上的布尔（方法论「未解之谜」）。 */
  secret: boolean;
}

/** 关系表（构思/人物关系.yaml，应用受管、整表重写）。 */
export interface RelationshipTable {
  legend: LegendItem[];
  edges: Relationship[];
}

/** 画布数据（派生，只读）。 */
export interface RelationshipView {
  legend: LegendItem[];
  /** 文件里的**全部**边，保文件次序——**保存时的唯一底稿**：失效引用的边
   *  也在里面，整表写回才不会把它们悄悄丢掉（画布只画两端都在的那些）。 */
  edges: Relationship[];
  /** `edges` 里引用了不存在人物的那些（画不出来，只列给人看）。 */
  missing: Relationship[];
  /** 边引用的、图例里没有的类型（照画兜底样式）。 */
  unknownKinds: string[];
  /** 边表坏了（画布降级为缺省图例＋空表）时的显式告警。 */
  warning: string | null;
}

/** 人物交汇：他们之间的边 ＋ 共同出现的单元。 */
export interface Confluence {
  edges: Relationship[];
  units: ConfluenceUnit[];
}

/** 一个提到过 ≥2 个选中人物的单元（人名纯文本提及，零结构）。 */
export interface ConfluenceUnit {
  name: string;
  /** 这个单元正文里提到过的**选中**人物。 */
  persons: string[];
}

/** 图例外类型的兜底样式（与 Rust 侧 relationship::FALLBACK_* 一致）。 */
export const RELATION_FALLBACK_COLOR = "#7f8c8d";
export const RELATION_FALLBACK_DIRECTED = true;
/** 图例的色板（与 Rust 侧 relationship::PALETTE 一致）：新增图例项按位置取色。 */
export const RELATION_PALETTE = [
  "#c0392b",
  "#7f8c8d",
  "#8e44ad",
  "#2e86c1",
  "#d68910",
  "#16a085",
  "#c2185b",
  "#5d6d7e",
];

export function relationPaletteColor(index: number): string {
  return RELATION_PALETTE[index % RELATION_PALETTE.length];
}

/** 一条边在画布上的样式：类型命中图例就用图例的色与方向，否则走兜底。 */
export function relationStyle(
  kind: string,
  legend: LegendItem[],
): { color: string; directed: boolean; known: boolean } {
  const item = legend.find((l) => l.name === kind);
  return item
    ? { color: item.color, directed: item.directed, known: true }
    : { color: RELATION_FALLBACK_COLOR, directed: RELATION_FALLBACK_DIRECTED, known: false };
}

export function emptyLegendItem(index: number): LegendItem {
  return { name: "", color: relationPaletteColor(index), directed: false };
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

/** 命令落在消息上的上下文：采纳回写按选区行号定位
 *  （callout 插入选区末行行尾、标注按行号换算章范围；正文改动后行号可能过期，越界收敛）。
 *  体检类命令没有行号，只有 kind——它们不带采纳动作。 */
export interface MessageMeta {
  kind: AiCommandKind;
  startLine?: number;
  endLine?: number;
}

/** 与 Rust 侧 ai.rs::ChatPersona 对应（工单 #16）：会话在跟哪本书的哪个人物聊。
 *  项目记《书名》（与卡片「关联」同款带书名号），只用于显示与落盘时按名解析。 */
export interface ChatPersona {
  project: string;
  person: string;
}

/** 与 Rust 侧 ai.rs::ChatSession 对应；id 由前端 crypto.randomUUID() 生成。 */
export interface ChatSession {
  id: string;
  title: string;
  /** Unix 秒。 */
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** 人物对话标签；普通会话没有。 */
  persona?: ChatPersona | null;
}

/** 与 Rust 侧 ai.rs::ChatSessionSummary 对应。 */
export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  persona?: ChatPersona | null;
}

/** chat_stream 的 onEvent Channel 事件；与 Rust 侧 ai.rs::ChatStreamEvent 对应。 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; reason: string | null };

/** AI 命令（设计共识 §七、docs/spec/AI命令集.md：AI 给初稿，人确认后才落盘）。
 *  拆书三条＝梳理/标注/小结（选区＋行号）；构思三条＝排布体检/矛盾梳理/人物关系梳理；
 *  书写两条＝本章体检（材料由后端组装）/润色（材料＝选区）。
 *  「人物对话」（docs/spec/人物对话.md）不是命令：材料进系统提示建人格会话，不自动发送。 */
export type AiCommandKind =
  | "梳理"
  | "标注"
  | "小结"
  | "排布体检"
  | "矛盾梳理"
  | "人物关系梳理"
  | "本章体检"
  | "润色"
  | "人物对话";

/** 板块发给 AI 面板的命令种子：`text` 既是选区文本也是后端组装的材料。 */
export interface AiSeed {
  kind: AiCommandKind;
  /** 书名（拆书稿或构思项目）——只进提示词与消息元数据。 */
  bookName: string;
  text: string;
  /** 拆书三条命令的选区行号（1 起）；体检/润色没有行号。 */
  startLine?: number;
  endLine?: number;
  /** 命令带的说明（小结的章标题、润色的章名、人物对话的人名等）。 */
  note?: string;
  /** 人物对话种子专有：带它＝只建人格会话、不自动发送（工单 #16）。 */
  persona?: ChatPersona;
}

/** AI 面板当前文档快照（由编辑器注册的桥提供）。 */
export interface DocSnapshot {
  bookName: string;
  /** 更细的定位（书写＝章名；拆书没有）。 */
  label?: string;
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

/** 写作页向 AI 面板暴露的回写桥（工单 #15）：`润色` 的采纳＝替换选中，
 *  走 CodeMirror 正常编辑路径（自动保存与 Ctrl+Z 都照旧）。 */
export interface WritingBridge {
  getDoc(): DocSnapshot | null;
  /** 用润色稿替换当前选区；没有选区/编辑器未就绪返回 false。 */
  replaceSelection(text: string): boolean;
}
