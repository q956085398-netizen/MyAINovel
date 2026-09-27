import {
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type EditorState,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

/** 编辑器渲染层（工单 #31/#32，spec 编辑器渲染层.md）：文件永远是纯
 *  markdown 源码，一切渲染都是装饰——callout 块卡片化（聚焦块还原源码、
 *  失焦块回卡片）、本地附件图内联缩放。拆书/书写/便签三个编辑器挂同一
 *  扩展包；导出与保存链路零感知。
 *
 *  装饰放在 StateField（ViewPlugin 不允许提供跨行替换，折叠要整段藏），
 *  文档或选区变化即重算；折叠态存字段内、不持久化（刷新默认全展开）。 */

export interface EditorRenderOptions {
  /** md 所在目录（相对图片路径的解析基准）；不提供则不渲染图片。 */
  getResolveDir?: () => string | undefined;
  /** 点图片弹原图大图（查看器由宿主组件渲染）。 */
  onImageOpen?: (absPath: string, alt: string) => void;
  /** 点书档卡片标题行（工单 #38：弹四项表单）。 */
  onBookHeaderClick?: () => void;
}
/** 六已知块＋未知兜底：图标与配色列（spec §三「家族与样式」）。 */
const CALLOUT_ICONS: Record<string, string> = {
  点评: "✎",
  如果是我写: "✍",
  原文截图: "▣",
  出场人物: "👥",
  小结: "◈",
  书档: "📖",
};

const GENERIC_ICON = "▣";

/** 块引用行前缀（行首空白＋`>`＋其后空白）；BOM 容忍在行首。 */
const QUOTE_PREFIX_RE = /^[ \t\uFEFF]*>[\t ]*/;

/** callout 首行：`> [!类型]`（容忍折叠标记 `-`/`+`）。 */
const CALLOUT_HEAD_RE = /^[ \t\uFEFF]*>[\t ]*\[!([^\]\n]+?)([-+])?\]/;

/** markdown 图片语法：`![alt](path)` 或 `![](<含空格的路径>)`。 */
const IMAGE_RE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))\)/g;

function quotePrefixLength(text: string): number {
  const m = text.match(QUOTE_PREFIX_RE);
  return m ? m[0].length : 0;
}

/** 本地相对路径才渲染：网络 URL、绝对路径、锚点都不算（spec §二）。 */
function isLocalRelativePath(path: string): boolean {
  if (path.startsWith("#")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return false; // http(s) 等
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false; // 盘符绝对路径
  if (path.startsWith("\\\\")) return false; // UNC
  return true;
}

/** 相对路径并到基准目录（`../附件/x.png` → 项目附件），分隔符随基准。 */
export function resolveRelative(baseDir: string, rel: string): string {
  const sep = baseDir.includes("\\") && !baseDir.includes("/") ? "\\" : "/";
  const parts = [...baseDir.split(/[\\/]/), ...rel.split(/[\\/]/)];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join(sep);
}

/** 路径的目录部分（正反斜杠都认；无分隔符返回空串）。 */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : "";
}

// --- 书档（工单 #38）：块定位与四项读写，前端镜像 of Rust parse_book_header
//     （改一处要同步另一处，沿 chapterFile.ts 同款纪律）---

export interface BookHeaderValues {
  title: string | null;
  trackRecord: string | null;
  summary: string | null;
  goldenFinger: string | null;
}

const HEADER_KEY_RE = /^(书名|成绩|简介|金手指)[：:]\s*(.*)$/;
const HEADER_KEYS = ["书名", "成绩", "简介", "金手指"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];

/** 中文键名 → BookHeaderValues 字段（前端镜像 of Rust 键名行约定）。 */
function headerSlot(key: HeaderKey): keyof BookHeaderValues {
  switch (key) {
    case "书名":
      return "title";
    case "成绩":
      return "trackRecord";
    case "简介":
      return "summary";
    case "金手指":
      return "goldenFinger";
  }
}

function valueSlot(values: BookHeaderValues, key: HeaderKey): string | null {
  return values[headerSlot(key)];
}

interface CalloutBlockInfo {
  type: string;
  /** 块首行行号（1 起）。 */
  firstLine: number;
  /** 块末行行号（1 起，含）。 */
  lastLine: number;
  /** 同类型块中的序号（1 起）——折叠键的稳定身份。 */
  ordinal: number;
}

/** 扫出全文全部 callout 块（连续引用行、首行带 `[!类型]`）。 */
function findCalloutBlocks(state: EditorState): CalloutBlockInfo[] {
  const doc = state.doc;
  const blocks: CalloutBlockInfo[] = [];
  const counts = new Map<string, number>();
  let li = 1;
  while (li <= doc.lines) {
    if (quotePrefixLength(doc.line(li).text) === 0) {
      li++;
      continue;
    }
    let last = li;
    while (last + 1 <= doc.lines && quotePrefixLength(doc.line(last + 1).text) > 0) last++;
    const head = doc.line(li).text.match(CALLOUT_HEAD_RE);
    if (head) {
      const type = head[1];
      const ordinal = (counts.get(type) ?? 0) + 1;
      counts.set(type, ordinal);
      blocks.push({ type, firstLine: li, lastLine: last, ordinal });
    }
    li = last + 1;
  }
  return blocks;
}

/** 解析书档四项（首个书档块；重复键取首见、空值不算）。无书档块返回空值。 */
export function parseBookHeaderValues(state: EditorState): BookHeaderValues {
  const values: BookHeaderValues = { title: null, trackRecord: null, summary: null, goldenFinger: null };
  const block = findCalloutBlocks(state).find((b) => b.type === "书档");
  if (!block) return values;
  const doc = state.doc;
  const seen = new Set<HeaderKey>();
  for (let li = block.firstLine + 1; li <= block.lastLine; li++) {
    const text = doc.line(li).text;
    const body = text.slice(quotePrefixLength(text));
    const m = body.match(HEADER_KEY_RE);
    if (!m || seen.has(m[1] as HeaderKey)) continue;
    const key = m[1] as HeaderKey;
    seen.add(key);
    const v = m[2].trim();
    values[headerSlot(key)] = v || null;
  }
  return values;
}

/** 表单保存写回书档块（文件是唯一源，走正常编辑路径＝可撤销、随自动保存
 *  落盘）：改键名行的值、保留自由行，缺的键补齐（空值也占行，与模板同形）；
 *  无书档块则在稿顶插一块（BOM 之后）。 */
export function applyBookHeaderValues(view: EditorView, values: BookHeaderValues): boolean {
  const doc = view.state.doc;
  const block = findCalloutBlocks(view.state).find((b) => b.type === "书档");
  const cleaned = (v: string | null) => (v ?? "").trim();

  if (!block) {
    const lines = ["> [!书档]", ...HEADER_KEYS.map((k) => `> ${k}：${cleaned(valueSlot(values, k))}`)];
    const bom = doc.length > 0 && doc.sliceString(0, 1) === "\uFEFF" ? 1 : 0;
    const at = bom;
    const insert = doc.length - bom === 0 ? `${lines.join("\n")}\n` : `${lines.join("\n")}\n\n`;
    view.dispatch({
      changes: { from: at, to: at, insert },
      selection: { anchor: at + insert.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  const first = doc.line(block.firstLine);
  const bodyLines: string[] = [];
  for (let li = block.firstLine + 1; li <= block.lastLine; li++) bodyLines.push(doc.line(li).text);

  // 单遍扫描：每键首见即键名行（换成新值），重复键行与自由行原样保留。
  const out: string[] = [];
  const done = new Set<HeaderKey>();
  let lastKeyIdx = -1;
  bodyLines.forEach((text) => {
    const m = text.slice(quotePrefixLength(text)).match(HEADER_KEY_RE);
    if (m && !done.has(m[1] as HeaderKey)) {
      const key = m[1] as HeaderKey;
      done.add(key);
      out.push(`> ${key}：${cleaned(valueSlot(values, key))}`);
      lastKeyIdx = out.length - 1;
    } else {
      out.push(text);
    }
  });
  // 缺的键补在最后一个键行之后；一个键行都没有则紧跟块首行。
  let insertAt = lastKeyIdx + 1;
  for (const key of HEADER_KEYS) {
    if (!done.has(key)) out.splice(insertAt++, 0, `> ${key}：${cleaned(valueSlot(values, key))}`);
  }

  // 单行块（只有语法行）时在标题行后补换行再接键名行；多行块整段重写。
  const from = block.lastLine > block.firstLine ? doc.line(block.firstLine + 1).from : first.to;
  const to = doc.line(block.lastLine).to;
  const insert =
    block.lastLine > block.firstLine ? out.join("\n") : `\n${out.join("\n")}`;
  view.dispatch({
    changes: { from, to, insert },
    userEvent: "input.bookHeader",
  });
  return true;
}

// --- 装饰构建 ---

interface CalloutTitleInfo {
  type: string;
  key: string;
  collapsed: boolean;
  summary: string;
}

class CalloutTitleWidget extends WidgetType {
  constructor(
    private readonly info: CalloutTitleInfo,
    private readonly onToggle: (key: string) => void,
    private readonly onHeader: (() => void) | undefined,
  ) {
    super();
  }

  eq(other: CalloutTitleWidget) {
    return (
      other.info.key === this.info.key &&
      other.info.collapsed === this.info.collapsed &&
      other.info.summary === this.info.summary
    );
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "callout-title";
    el.dataset.callout = this.info.type;
    const icon = document.createElement("span");
    icon.className = "callout-icon";
    icon.textContent = CALLOUT_ICONS[this.info.type] ?? GENERIC_ICON;
    const name = document.createElement("span");
    name.className = "callout-name";
    name.textContent = this.info.type;
    el.append(icon, name);
    if (this.info.collapsed && this.info.summary) {
      const summary = document.createElement("span");
      summary.className = "callout-summary";
      summary.textContent = this.info.summary;
      el.append(summary);
    }
    const chevron = document.createElement("span");
    chevron.className = "callout-chevron";
    chevron.textContent = this.info.collapsed ? "▸" : "▾";
    chevron.title = this.info.collapsed ? "展开" : "折叠";
    chevron.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    chevron.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onToggle(this.info.key);
    });
    el.append(chevron);
    // 标题行整行可点：书档弹表单（工单 #38），其余块折叠/展开。
    // mousedown 吃掉默认行为——不让编辑器把光标挪进块（那会整块还原源码）。
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.info.type === "书档" && this.onHeader) this.onHeader();
      else this.onToggle(this.info.key);
    });
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly rel: string,
    private readonly alt: string,
    private readonly abs: string,
    private readonly onOpen: ((abs: string, alt: string) => void) | undefined,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.abs === this.abs && other.rel === this.rel && other.alt === this.alt;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-img-wrap loading";
    const img = document.createElement("img");
    img.src = convertFileSrc(this.abs);
    img.alt = this.alt || this.rel;
    img.draggable = false;
    img.decoding = "async";
    img.title = this.rel;
    img.addEventListener("mousedown", (e) => e.preventDefault());
    img.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onOpen?.(this.abs, this.alt || this.rel);
    });
    // 异步解码不阻塞输入；加载完成才撤占位条（spec §二「占位」）。
    img.addEventListener("load", () => wrap.classList.remove("loading"));
    // 文件缺失：占位条（路径＋提示），不崩编辑器。
    img.addEventListener("error", () => {
      wrap.classList.remove("loading");
      wrap.classList.add("missing");
      img.remove();
      const label = document.createElement("span");
      label.className = "cm-img-missing";
      label.textContent = `缺图：${this.rel}`;
      wrap.appendChild(label);
    });
    wrap.appendChild(img);
    return wrap;
  }
}

function buildDecorations(
  state: EditorState,
  collapsed: Set<string>,
  options: EditorRenderOptions,
  toggle: (key: string) => void,
): DecorationSet {
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const collapsedSpans: { from: number; to: number }[] = [];
  const focusedSpans: { from: number; to: number }[] = [];

  for (const block of findCalloutBlocks(state)) {
    const first = doc.line(block.firstLine);
    const last = doc.line(block.lastLine);
    const from = first.from;
    const to = last.to;
    // 聚焦块＝源码（spec §三「编辑模型」）：光标/选区实质落在块内才还原。
    // 贴边不算——选区恰好止于块首或起于块尾，块仍是卡片。
    const focused = state.selection.ranges.some((r) =>
      r.empty ? r.head >= from && r.head <= to : r.from < to && r.to > from,
    );
    if (focused) {
      focusedSpans.push({ from, to });
      continue;
    }

    const key = `${block.type}#${block.ordinal}`;
    const isCollapsed = collapsed.has(key);
    const head = first.text.match(CALLOUT_HEAD_RE)!;
    const summary = summaryOf(doc, block);
    ranges.push(
      Decoration.replace({
        widget: new CalloutTitleWidget(
          { type: block.type, key, collapsed: isCollapsed, summary },
          toggle,
          options.onBookHeaderClick,
        ),
      }).range(first.from, first.from + head[0].length),
    );
    for (let li = block.firstLine; li <= block.lastLine; li++) {
      const line = doc.line(li);
      const cls =
        "cm-callout-line" +
        (li === block.firstLine ? " cm-callout-first" : "") +
        (li === block.lastLine ? " cm-callout-last" : "");
      ranges.push(
        Decoration.line({ class: cls, attributes: { "data-callout": block.type } }).range(line.from),
      );
    }
    if (isCollapsed) {
      // 折叠：标题行之后整段藏起（跨行替换，StateField 才允许）。
      if (first.to < to) {
        ranges.push(Decoration.replace({}).range(first.to, to));
        collapsedSpans.push({ from: first.to, to });
      }
    } else {
      // 内容行：藏掉 `> ` 引用前缀（行首空白＋`>`＋其后空白）。
      for (let li = block.firstLine + 1; li <= block.lastLine; li++) {
        const line = doc.line(li);
        const plen = quotePrefixLength(line.text);
        if (plen > 0) ranges.push(Decoration.replace({}).range(line.from, line.from + plen));
      }
    }
  }

  // 图片内联（spec §二）：聚焦块内的不渲染——聚焦块整块还原源码可直接
  // 编辑（spec §三），图贴成 widget 反而把语法锁成原子。普通段落里的
  // 图片与选区无关，始终渲染。
  const resolveDir = options.getResolveDir?.();
  if (resolveDir) {
    for (let li = 1; li <= doc.lines; li++) {
      const line = doc.line(li);
      IMAGE_RE.lastIndex = 0;
      for (const m of line.text.matchAll(IMAGE_RE)) {
        // 尖括号形态承载含空格的路径（markdown 语法），否则取裸路径。
        const rel = (m[2] ?? m[3] ?? "").trim();
        const alt = m[1] ?? "";
        if (!rel || !isLocalRelativePath(rel)) continue;
        const from = line.from + m.index;
        const to = from + m[0].length;
        const hidden =
          collapsedSpans.some((s) => from < s.to && to > s.from) ||
          focusedSpans.some((s) => from < s.to && to > s.from);
        if (hidden) continue;
        ranges.push(
          Decoration.replace({
            widget: new ImageWidget(rel, alt, resolveRelative(resolveDir, rel), options.onImageOpen),
          }).range(from, to),
        );
      }
    }
  }

  return Decoration.set(ranges, true);
}

/** 折叠态标题行摘要：首个非空内容行去引用前缀，压到 40 字。 */
function summaryOf(doc: Text, block: CalloutBlockInfo): string {
  for (let li = block.firstLine + 1; li <= block.lastLine; li++) {
    const text = doc.line(li).text;
    const body = text.slice(quotePrefixLength(text)).trim();
    if (!body) continue;
    const chars = [...body];
    return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : body;
  }
  return "";
}

/** 渲染层扩展包（三编辑器共用）：装饰走 StateField（跨行替换只有它允许），
 *  折叠翻转用 effect；ViewPlugin 只负责把当前 view 递给翻转回调。 */
export function editorRender(options: EditorRenderOptions = {}): Extension {
  const toggleCollapse = StateEffect.define<string>();

  interface RenderState {
    collapsed: Set<string>;
    decorations: DecorationSet;
  }

  const renderField = StateField.define<RenderState>({
    create: (state) => ({
      collapsed: new Set<string>(),
      decorations: buildDecorations(state, new Set<string>(), options, () => {}),
    }),
    update(prev, tr) {
      const collapsed = new Set(prev.collapsed);
      let toggled = false;
      for (const e of tr.effects) {
        if (e.is(toggleCollapse)) {
          if (collapsed.has(e.value)) collapsed.delete(e.value);
          else collapsed.add(e.value);
          toggled = true;
        }
      }
      if (tr.docChanged || tr.selection !== undefined || toggled) {
        const toggle = (key: string) => {
          currentView?.dispatch({ effects: toggleCollapse.of(key) });
        };
        return { collapsed, decorations: buildDecorations(tr.state, collapsed, options, toggle) };
      }
      return { collapsed, decorations: prev.decorations.map(tr.changes) };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (s) => s.decorations),
      // 隐藏区（语法行/引用前缀/折叠段）对光标原子：方向键跳过而非钻进暗处。
      EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
    ],
  });

  let currentView: EditorView | null = null;
  const viewPlugin = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        currentView = view;
      }
      update(u: ViewUpdate) {
        currentView = u.view;
      }
    },
  );

  return [renderField, viewPlugin];
}
