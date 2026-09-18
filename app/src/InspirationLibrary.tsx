import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BookEntry,
  CardCategory,
  CardDraft,
  ImportEntry,
  InspirationCard,
  NoteEntry,
  ProjectEntry,
} from "./types";
import { CARD_CATEGORIES, emptyCardDraft } from "./types";
import { errMsg, oneLinePreview, stripBookMarks } from "./util";
import CardDialog from "./CardDialog";
import ImportDialog from "./ImportDialog";
import TransmuteDialog, { type TransmuteTarget } from "./TransmuteDialog";
import type { ProjectTab } from "./ProjectPage";

function formatCount(n: number): string {
  return n.toLocaleString("zh-Hans-CN");
}

function formatDate(unixSec: number): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function newestFirst(a: InspirationCard, b: InspirationCard): number {
  return b.mtime - a.mtime || a.title.localeCompare(b.title, "zh-Hans-CN");
}

/** 卡片类别 → 转生落点（只开两条通道：故事卡→单元 #9、角色卡→人物 #8）。 */
const TRANSMUTE_ACTIONS: Partial<
  Record<CardCategory, { target: TransmuteTarget; label: string; hint: string }>
> = {
  故事卡: {
    target: "单元",
    label: "转生为单元",
    hint: "新建到某个构思项目：核心矛盾与类型预填，正文只给骨架",
  },
  角色卡: {
    target: "人物",
    label: "转生为人物",
    hint: "新建到某个构思项目：卡片正文进小传，分组与关系留给你自己填",
  },
};

/** 卡片上的转生按钮；不能转生的类别不渲染。 */
function TransmuteButton({
  card,
  onPick,
}: {
  card: InspirationCard;
  onPick: (card: InspirationCard, target: TransmuteTarget) => void;
}) {
  const action = TRANSMUTE_ACTIONS[card.category];
  if (!action) return null;
  return (
    <div className="card-actions">
      <button className="btn small" title={action.hint} onClick={() => onPick(card, action.target)}>
        {action.label}
      </button>
    </div>
  );
}

function InspirationCardItem({
  card,
  onEdit,
  onOpenLink,
  onTransmute,
}: {
  card: InspirationCard;
  onEdit: (draft: CardDraft, prevPath: string) => void;
  onOpenLink: (text: string) => Promise<void>;
  onTransmute: (card: InspirationCard, target: TransmuteTarget) => void;
}) {
  return (
    <div className="card-item">
      <div className="card-title-row">
        <button className="card-title" title="编辑这张卡片" onClick={() => onEdit(card, card.path)}>
          {card.title}
        </button>
        <span className="card-cat">{card.category}</span>
        {card.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        <span className="card-date">{formatDate(card.mtime)}</span>
      </div>
      {card.core && (
        <p className="card-core" title="一句话核心（人物＋困境＋爽点预期）">
          一句话核心：{card.core}
        </p>
      )}
      {(card.source || card.links.length > 0) && (
        <p className="card-meta">
          {card.source && (
            <span className="card-source" title="来源">
              来源：{card.source}
            </span>
          )}
          {card.links.map((link) => (
            <button
              key={link}
              className="link-like card-link"
              title="打开关联的卡片或拆书稿"
              onClick={() => void onOpenLink(link)}
            >
              {link}
            </button>
          ))}
        </p>
      )}
      {card.body && (
        <p className="card-preview" title={card.body}>
          {oneLinePreview(card.body, 120)}
        </p>
      )}
      <TransmuteButton card={card} onPick={onTransmute} />
    </div>
  );
}

interface InspirationLibraryProps {
  libraryPath: string | null;
  onChooseFolder: () => void;
  /** 新建空库：选空文件夹即设为当前库（工单 #21）。 */
  onCreateLibrary: () => void;
  onOpenBook: (book: BookEntry) => void;
  /** 「关联」里的项目去向（《书名》/名字）→ 打开该项目的页签；给出人名则落到画布。 */
  onOpenProject: (project: ProjectEntry, tab?: ProjectTab, focus?: string) => void;
  /** 转生时没有项目可去：切到「构思」板块新建。 */
  onGoIdeation: () => void;
}

/** 灵感库（设计共识 §六）：九类卡片＋未分类，一卡一文件存于库根
 *  「灵感库/<类别>/<标题>.md」。 */
export default function InspirationLibrary({
  libraryPath,
  onChooseFolder,
  onCreateLibrary,
  onOpenBook,
  onOpenProject,
  onGoIdeation,
}: InspirationLibraryProps) {
  const [cards, setCards] = useState<InspirationCard[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeCategory, setActiveCategory] = useState<CardCategory | null>(null);
  const [query, setQuery] = useState("");
  const [quickCapture, setQuickCapture] = useState("");
  const [capturing, setCapturing] = useState(false);

  const [editing, setEditing] = useState<{ draft: CardDraft; prevPath: string | null } | null>(
    null,
  );
  const [importing, setImporting] = useState<{ sourcePath: string; entries: ImportEntry[] } | null>(
    null,
  );
  const [transmuting, setTransmuting] = useState<{
    card: InspirationCard;
    target: TransmuteTarget;
  } | null>(null);

  const scan = useCallback(async (root: string) => {
    setScanning(true);
    setError(null);
    try {
      setCards(await invoke<InspirationCard[]>("scan_inspirations", { root }));
    } catch (e) {
      setCards([]);
      setError(`扫描失败：${errMsg(e)}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (libraryPath) void scan(libraryPath);
  }, [libraryPath, scan]);

  /** 关联跳转：卡片标题 → 打开卡片；「《书名》/名字」（转生去向）→ 打开
   *  该项目的对应页签（先单元、再人物、再矛盾/世界观/开头，工单 #8 §五）；
   *  拆书稿书名 → 打开拆书稿。 */
  async function openLink(text: string) {
    if (!libraryPath) return;
    const t = text.trim();
    const card = cards.find((c) => c.title === t);
    if (card) {
      setEditing({ draft: card, prevPath: card.path });
      return;
    }
    try {
      const slash = t.indexOf("/");
      if (slash > 0) {
        const title = stripBookMarks(t.slice(0, slash));
        const name = t.slice(slash + 1).trim();
        const projects = await invoke<ProjectEntry[]>("scan_projects", { root: libraryPath });
        const project = projects.find(
          (p) => p.title === title || p.name === title || p.name === `《${title}》`,
        );
        if (project && name) {
          // 按名在书内各构思笔记里找：先单元（#9 原样，既有卡片不失联），
          // 再人物（落到画布并选中这个人）、矛盾、世界观、开头；
          // 同名歧义由这个固定次序裁决。
          for (const kind of ["单元", "人物", "矛盾", "世界观", "开头"] as const) {
            const notes = await invoke<NoteEntry[]>("scan_notes", { project: project.dir, kind });
            if (notes.some((n) => n.name === name)) {
              onOpenProject(project, kind, kind === "人物" ? name : undefined);
              return;
            }
          }
        }
        if (project) {
          // 名字对不上（单元改了名之类）按 #9 兜底：打开项目的单元页，不自动改条目。
          onOpenProject(project, "单元");
          return;
        }
      }
      const books = await invoke<BookEntry[]>("scan_library", { root: libraryPath });
      const book = books.find((b) => b.name === t || b.meta.title === t);
      if (book) {
        onOpenBook(book);
        return;
      }
      window.alert(`没有找到「${t}」对应的灵感卡片、构思项目或拆书稿。`);
    } catch (e) {
      window.alert(`查找关联失败：${errMsg(e)}`);
    }
  }

  async function startImport() {
    const picked = await open({
      multiple: false,
      title: "选择旧的灵感.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const entries = await invoke<ImportEntry[]>("import_inspiration_preview", {
        path: picked,
      });
      if (entries.length === 0) {
        window.alert("没有从这份文件里解析出条目（按 markdown 标题分节）。");
        return;
      }
      setImporting({ sourcePath: picked, entries });
    } catch (e) {
      window.alert(`解析失败：${errMsg(e)}`);
    }
  }

  async function saveQuickCapture() {
    if (!libraryPath || !quickCapture.trim() || capturing) return;
    setCapturing(true);
    try {
      await invoke<InspirationCard>("capture_inspiration", {
        root: libraryPath,
        body: quickCapture,
      });
      setQuickCapture("");
      await scan(libraryPath);
    } catch (e) {
      window.alert(`灵感速记保存失败：${errMsg(e)}`);
    } finally {
      setCapturing(false);
    }
  }

  const categoryCounts = useMemo(() => {
    const counts = new Map<CardCategory, number>();
    for (const c of cards) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    return counts;
  }, [cards]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards
      .filter((c) => !activeCategory || c.category === activeCategory)
      .filter((c) => {
        if (!q) return true;
        const haystack = [c.title, c.body, c.source ?? "", c.core ?? "", c.tags.join(" "), c.links.join(" ")]
          .join("\n")
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort(newestFirst);
  }, [cards, activeCategory, query]);

  // 待整理灵感始终常驻顶部，不随搜索或类别筛选隐藏；只有手动改为其他类别才离开。
  const pending = useMemo(
    () =>
      cards
        .filter((card) => card.category === "未分类")
        .sort(newestFirst),
    [cards],
  );

  // 待整理灵感已经在顶部展示，普通列表不再重复；选择「未分类」筛选时也只看顶部。
  const listed = activeCategory === "未分类" ? [] : visible.filter((card) => card.category !== "未分类");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>灵感库</h1>
          {libraryPath && (
            <p className="library-path" title={libraryPath}>
              {libraryPath}
            </p>
          )}
        </div>
        <div className="page-actions">
          {libraryPath ? (
            <>
              <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
                刷新
              </button>
              <button className="btn" disabled={scanning} onClick={() => void startImport()}>
                导入旧灵感.md
              </button>
              <button
                className="btn"
                onClick={() => setEditing({ draft: emptyCardDraft(), prevPath: null })}
              >
                新建卡片
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={onChooseFolder}>
              打开库文件夹
            </button>
          )}
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {!libraryPath && (
        <div className="empty-state">
          <p>还没有打开库文件夹。</p>
          <p className="hint">
            灵感卡存在库文件夹的「灵感库/」子目录里（按类别分文件夹），
            <br />
            可以直接用现有的拆书库文件夹。
          </p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={onChooseFolder}>
              打开库文件夹
            </button>
            <button className="btn" onClick={onCreateLibrary}>
              新建空库
            </button>
          </div>
        </div>
      )}

      {libraryPath && scanning && <div className="empty-state">正在扫描……</div>}

      {libraryPath && !scanning && (
        <section className="quick-capture" aria-label="灵感速记">
          <div className="quick-capture-heading">
            <div>
              <h2>灵感速记</h2>
              <p>先写下来，标题和归类以后再补。</p>
            </div>
            <button
              className="btn primary"
              disabled={capturing || !quickCapture.trim()}
              onClick={() => void saveQuickCapture()}
            >
              {capturing ? "保存中……" : "收下灵感"}
            </button>
          </div>
          <textarea
            value={quickCapture}
            onChange={(e) => setQuickCapture(e.target.value)}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key === "Enter") {
                e.preventDefault();
                void saveQuickCapture();
              }
            }}
            placeholder="把刚冒出来的念头写在这里；Ctrl + Enter 保存，Enter 换行。"
            rows={4}
          />
        </section>
      )}

      {libraryPath && !scanning && pending.length > 0 && (
        <section className="pending-inspirations" aria-labelledby="pending-inspirations-title">
          <div className="section-heading">
            <div>
              <h2 id="pending-inspirations-title">待整理灵感（{formatCount(pending.length)}）</h2>
              <p>归类后会从这里离开。</p>
            </div>
          </div>
          <div className="card-list">
            {pending.map((card) => (
              <InspirationCardItem
                key={card.path}
                card={card}
                onEdit={(draft, prevPath) => setEditing({ draft, prevPath })}
                onOpenLink={openLink}
                onTransmute={(picked, target) => setTransmuting({ card: picked, target })}
              />
            ))}
          </div>
        </section>
      )}

      {libraryPath && !scanning && !error && cards.length === 0 && (
        <div className="empty-state">
          <p>还没有灵感卡片。</p>
          <p className="hint">
            新建一张，或把旧的 灵感.md 导入进来（按标签自动归类，杂项落未分类）。
          </p>
          <div className="empty-state-actions">
            <button
              className="btn"
              onClick={() => setEditing({ draft: emptyCardDraft(), prevPath: null })}
            >
              新建卡片
            </button>
            <button className="btn" onClick={() => void startImport()}>
              导入旧灵感.md
            </button>
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <>
          <div className="cat-chips">
            <button
              className={`chip ${activeCategory === null ? "active" : ""}`}
              onClick={() => setActiveCategory(null)}
            >
              全部（{formatCount(cards.length)}）
            </button>
            {CARD_CATEGORIES.map((cat) => (
              <button
                key={cat}
                className={`chip ${activeCategory === cat ? "active" : ""}`}
                onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
              >
                {cat}（{formatCount(categoryCounts.get(cat) ?? 0)}）
              </button>
            ))}
          </div>

          <form className="search-bar" onSubmit={(e) => e.preventDefault()}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜标题、正文、标签、来源、关联……"
            />
          </form>

          <p className="stats">
            共 {formatCount(cards.length)} 张卡片{activeCategory && ` · 当前 ${activeCategory} ${formatCount(visible.length)} 张`}
          </p>

          {listed.length === 0 ? (
            <p className="hint">这个筛选下没有卡片。</p>
          ) : (
            <div className="card-list">
              {listed.map((card) => (
                <InspirationCardItem
                  key={card.path}
                  card={card}
                  onEdit={(draft, prevPath) => setEditing({ draft, prevPath })}
                  onOpenLink={openLink}
                  onTransmute={(picked, target) => setTransmuting({ card: picked, target })}
                />
              ))}
            </div>
          )}
        </>
      )}

      {editing && libraryPath && (
        <CardDialog
          libraryPath={libraryPath}
          initial={editing.draft}
          prevPath={editing.prevPath}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void scan(libraryPath);
          }}
          onDeleted={() => {
            setEditing(null);
            void scan(libraryPath);
          }}
        />
      )}

      {transmuting && libraryPath && (
        <TransmuteDialog
          libraryPath={libraryPath}
          card={transmuting.card}
          target={transmuting.target}
          onClose={() => setTransmuting(null)}
          onGoIdeation={onGoIdeation}
          onDone={(project, target) => {
            setTransmuting(null);
            void scan(libraryPath);
            onOpenProject(project, target);
          }}
        />
      )}

      {importing && libraryPath && (
        <ImportDialog
          libraryPath={libraryPath}
          sourcePath={importing.sourcePath}
          initialEntries={importing.entries}
          onClose={() => setImporting(null)}
          onImported={() => {
            setImporting(null);
            void scan(libraryPath);
          }}
        />
      )}
    </div>
  );
}
