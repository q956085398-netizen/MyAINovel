//! 构思/书写板块的 AI 命令材料（工单 #15，docs/spec/AI命令集.md）。
//!
//! 命令的「材料」＝后端按固定口径从盘上现读组装的一段纯文本（ADR 0002：
//! 文件是唯一数据源，界面可能落后于盘）；提示词在前端 `ai.ts`，两处各管
//! 一段、互不重复。**只读**：不写任何创作文件——写回只经「采纳」闸
//! （ADR 0003：AI 给建议，人确认后才落盘）。

use std::path::Path;

use crate::book_file::{body_after_frontmatter, read_book_md};
use crate::chapter::{self, UnitBrief};
use crate::expectation::{self, ExpectationView};
use crate::foreshadow::{self, ForeshadowView};
use crate::planning;
use crate::project::{self, ArrangementItem, NoteEntry, NoteKind};
use crate::relationship::{self, LegendItem, Relationship};
use crate::thread::{AnchorView, PayoffView};

/// 命令：构思侧三条、书写侧报告命令（`润色` 的材料是选区本身，不走后端）。
const KIND_ARRANGEMENT: &str = "排布体检";
const KIND_CONTRADICTIONS: &str = "矛盾梳理";
const KIND_RELATIONSHIPS: &str = "人物关系梳理";
const KIND_CHAPTER: &str = "本章体检";
const KIND_CHAPTER_COMPANION: &str = "AI 陪看本章";
/// 人物对话的人格材料（工单 #16）：不进用户消息，进系统提示。
const KIND_CHARACTER_DIALOGUE: &str = "人物对话";

/// 本章正文带上限（网文单章 2000~4000 字，12000 已很宽裕）；超出截断并注明。
const CHAPTER_TEXT_LIMIT: usize = 12000;
/// 引文预览上限。
const QUOTE_PREVIEW_LIMIT: usize = 30;
/// 一句话核心的预览上限。
const CORE_PREVIEW_LIMIT: usize = 80;
/// 矛盾「一句话核心」缺失时，取正文开头多少字兜底。
const BODY_PREVIEW_LIMIT: usize = 60;
/// 全书未收的线最多列多少条。
const OPEN_LINES_LIMIT: usize = 30;
/// 人物小传正文进材料的上限。
const PERSON_BODY_LIMIT: usize = 400;
/// 人物对话的小传正文上限（人格底座要全文，比梳理的单行预览宽得多）。
const PERSONA_BODY_LIMIT: usize = 4000;

/// 组装命令材料。`subjects` 只有「人物关系梳理」用（选中的人名）；
/// 其余命令传空切片。`润色` 由前端带选区，不进这里。
pub fn build_context(
    kind: &str,
    project: &Path,
    chapter: Option<u32>,
    subjects: &[String],
) -> Result<String, String> {
    match kind {
        KIND_ARRANGEMENT => arrangement_context(project),
        KIND_CONTRADICTIONS => contradiction_context(project),
        KIND_RELATIONSHIPS => relationship_context(project, subjects),
        KIND_CHAPTER => {
            let ordinal = chapter.ok_or_else(|| "「本章体检」需要指定章序".to_string())?;
            chapter_context(project, ordinal)
        }
        KIND_CHAPTER_COMPANION => {
            let ordinal = chapter.ok_or_else(|| "「AI 陪看本章」需要指定章序".to_string())?;
            chapter_companion_context(project, ordinal)
        }
        KIND_CHARACTER_DIALOGUE => character_context(project, subjects),
        other => Err(format!("未知的 AI 命令「{other}」")),
    }
}

// ---------- 小工具 ----------

/// 按字符截断（中文按字算，不按字节——不截出半个字）。
fn truncate_chars(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_string(), false);
    }
    (text.chars().take(limit).collect(), true)
}

/// 折叠为单行并截断：连续空白压成一个空格；截断了就带省略号。
fn one_line(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (cut, truncated) = truncate_chars(&flat, limit);
    if truncated {
        format!("{cut}…")
    } else {
        cut
    }
}

/// 引文进材料：失配的明说，空的给占位，其余单行截断。
fn quote_text(quote: &str, stale: bool) -> String {
    if stale {
        return "引文失配".to_string();
    }
    if quote.trim().is_empty() {
        return "引文（空）".to_string();
    }
    format!("引文：{}", one_line(quote, QUOTE_PREVIEW_LIMIT))
}

fn opt_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn join_or(items: &[String], empty: &str) -> String {
    if items.is_empty() {
        empty.to_string()
    } else {
        items.join("、")
    }
}

/// 项目书名：`项目.yaml` 的「书名」，缺省＝文件夹名去《》；都没有给占位。
fn project_title(project: &Path) -> Result<String, String> {
    if let Some(title) = project::read_project_meta(project)?.title {
        let title = title.trim();
        if !title.is_empty() {
            return Ok(title.to_string());
        }
    }
    let name = project::strip_book_marks(
        project.file_name().and_then(|n| n.to_str()).unwrap_or(""),
    );
    Ok(if name.is_empty() {
        "（未命名）".to_string()
    } else {
        name
    })
}

/// 类型圈里的类型列表（去掉空白项）。
fn circle_types(project: &Path) -> Result<Vec<String>, String> {
    Ok(project::read_circle(project)?
        .types
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect())
}

fn unit_core(units: &[NoteEntry], unit: &str) -> String {
    units
        .iter()
        .find(|u| u.name == unit)
        .and_then(|u| u.core.as_deref())
        .map(|c| one_line(c, CORE_PREVIEW_LIMIT))
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "（空）".to_string())
}

/// 排布项属性行：只列定了的（线/地图/升级战斗/节奏）。
fn arrangement_attrs(item: &ArrangementItem) -> String {
    let mut attrs: Vec<String> = Vec::new();
    if let Some(v) = opt_text(item.line.as_deref()) {
        attrs.push(format!("线：{v}"));
    }
    if let Some(v) = opt_text(item.map.as_deref()) {
        attrs.push(format!("地图：{v}"));
    }
    if let Some(v) = opt_text(item.upgrade_battle.as_deref()) {
        attrs.push(v.to_string());
    }
    if let Some(v) = opt_text(item.pace.as_deref()) {
        attrs.push(v.to_string());
    }
    if attrs.is_empty() {
        String::new()
    } else {
        format!(" ｜ {}", attrs.join(" ｜ "))
    }
}

/// 单元区间文案：两侧齐＝`第 a-b 章`，单侧＝半开，无区间＝None。
fn range_text(start: Option<u32>, end: Option<u32>) -> Option<String> {
    match (start, end) {
        (Some(a), Some(b)) => Some(format!("第 {a}-{b} 章")),
        (Some(a), None) => Some(format!("第 {a} 章起")),
        (None, Some(b)) => Some(format!("至第 {b} 章")),
        (None, None) => None,
    }
}

// ---------- 排布体检 ----------

fn arrangement_context(project: &Path) -> Result<String, String> {
    let title = project_title(project)?;
    let types = circle_types(project)?;
    let items = project::read_arrangement(project)?;
    let units = project::scan_notes(project, NoteKind::Unit)?;
    // 机检是纯函数派生（与排布页同一个落地函数），材料里带上是给 AI 一个地板。
    let check = project::check_project_arrangement(project, &items)?;

    let mut out = String::new();
    out.push_str("【体检对象】全书排布（大纲）\n");
    out.push_str(&format!("【书名】《{title}》\n"));
    out.push_str(&format!("【类型圈】{}\n", join_or(&types, "（类型圈还没定）")));

    if items.is_empty() {
        out.push_str("【排布】（排布还是空的）\n");
    } else {
        out.push_str(&format!("【排布】共 {} 项（按全书次序）\n", items.len()));
        for (i, item) in items.iter().enumerate() {
            out.push_str(&format!(
                "{}. {}{}\n   核心：{}\n",
                i + 1,
                item.unit.trim(),
                arrangement_attrs(item),
                unit_core(&units, item.unit.trim())
            ));
        }
    }

    out.push_str("【机检提示】\n");
    out.push_str(&format!("- {}\n", check.ratio_hint));
    for hint in check
        .pace_hints
        .iter()
        .chain(check.ref_hints.iter())
    {
        out.push_str(&format!("- {hint}\n"));
    }
    if !check.missing_units.is_empty() {
        out.push_str(&format!(
            "- 排布引用了不存在的单元：{}\n",
            check.missing_units.join("、")
        ));
    }
    if !check.unarranged_units.is_empty() {
        out.push_str(&format!(
            "- 还没排布的单元：{}\n",
            check.unarranged_units.join("、")
        ));
    }
    if !check.map_counts.is_empty() {
        let counts = check
            .map_counts
            .iter()
            .map(|m| format!("{} {}", m.map, m.count))
            .collect::<Vec<_>>()
            .join(" · ");
        out.push_str(&format!("- 地图分布：{counts}\n"));
    }
    Ok(out)
}

// ---------- 矛盾梳理 ----------

fn contradiction_context(project: &Path) -> Result<String, String> {
    let title = project_title(project)?;
    let types = circle_types(project)?;
    let contradictions = project::scan_notes(project, NoteKind::Contradiction)?;
    let units = project::scan_notes(project, NoteKind::Unit)?;

    let mut out = String::new();
    out.push_str("【体检对象】矛盾池（剧情种子）\n");
    out.push_str(&format!("【书名】《{title}》\n"));
    out.push_str(&format!("【类型圈】{}\n", join_or(&types, "（类型圈还没定）")));
    let unit_names: Vec<String> = units.iter().map(|u| u.name.clone()).collect();
    out.push_str(&format!(
        "【已有单元】{}\n",
        match unit_names.len() {
            0 => "（还没有单元）".to_string(),
            n => format!("共 {n} 个：{}", unit_names.join("、")),
        }
    ));

    if contradictions.is_empty() {
        out.push_str("【矛盾池】（矛盾池是空的）\n");
        return Ok(out);
    }
    out.push_str(&format!("【矛盾池】共 {} 条\n", contradictions.len()));
    for note in &contradictions {
        let mut parts = vec![note.name.clone()];
        if let Some(v) = opt_text(note.status.as_deref()) {
            parts.push(format!("状态：{v}"));
        }
        let type_text = join_or(&note.types, "");
        if !type_text.is_empty() {
            parts.push(format!("类型：{type_text}"));
        }
        // 核心优先；没写就退到正文开头（明说是摘要，AI 才知道这是残缺信息）。
        match opt_text(note.core.as_deref()) {
            Some(core) => parts.push(format!("核心：{}", one_line(core, CORE_PREVIEW_LIMIT))),
            None => parts.push(format!(
                "核心（正文摘）：{}",
                {
                    let head = one_line(&note.body, BODY_PREVIEW_LIMIT);
                    if head.is_empty() {
                        "（空）".to_string()
                    } else {
                        head
                    }
                }
            )),
        }
        out.push_str(&format!("- {}\n", parts.join(" ｜ ")));
    }
    Ok(out)
}

// ---------- 人物关系梳理（工单 #8 §6.3） ----------

/// 材料：选中人物的小传（正文＋分组/别名）＋ 他们相关的**全部边**（含不在
/// 选中集里的邻居人名）＋ 项目类型圈 ＋ 矛盾池现有标题。
/// 带类型圈与矛盾标题的理由：类型圈是判断「这条关系能不能长出圈内剧情」的
/// 唯一依据，矛盾标题是防重复的唯一依据；**不塞全书人物名单**——那与
/// 「选中几个人」的动作意图冲突。表坏了显式报错（#15 纪律）。
fn relationship_context(project: &Path, names: &[String]) -> Result<String, String> {
    let subjects = relationship::clean_names(names)?;
    if subjects.len() < 2 {
        return Err("「人物关系梳理」至少要选两个人物".to_string());
    }

    let title = project_title(project)?;
    let types = circle_types(project)?;
    let table = relationship::read_table(project)?;
    let persons = project::scan_notes(project, NoteKind::Character)?;
    let contradictions = project::scan_notes(project, NoteKind::Contradiction)?;

    let mut out = String::new();
    out.push_str("【体检对象】选中人物的关系网\n");
    out.push_str(&format!("【书名】《{title}》\n"));
    out.push_str(&format!("【类型圈】{}\n", join_or(&types, "（类型圈还没定）")));

    out.push_str("【选中人物】\n");
    for name in &subjects {
        match persons.iter().find(|p| &p.name == name) {
            Some(note) => {
                let mut head = vec![note.name.clone()];
                if let Some(group) = opt_text(note.group.as_deref()) {
                    head.push(format!("分组：{group}"));
                }
                let aliases = join_or(&note.aliases, "");
                if !aliases.is_empty() {
                    head.push(format!("别名：{aliases}"));
                }
                out.push_str(&format!("- {}\n", head.join(" ｜ ")));
                let body = one_line(&note.body, PERSON_BODY_LIMIT);
                out.push_str(&format!(
                    "  小传：{}\n",
                    if body.is_empty() { "（空）" } else { &body }
                ));
            }
            // 选中的人没了要说出来，别让 AI 以为资料是齐的。
            None => out.push_str(&format!("- {name}（没有找到这个小传）\n")),
        }
    }

    out.push_str("【关系图例】\n");
    if table.legend.is_empty() {
        out.push_str("- （图例是空的）\n");
    }
    for item in &table.legend {
        out.push_str(&format!(
            "- {}（{}）\n",
            item.name,
            if item.directed { "有向" } else { "无向" }
        ));
    }

    out.push_str("【关系】（选中人物相关的全部关系，含不在选中名单里的那一端）\n");
    let related: Vec<&Relationship> = table
        .edges
        .iter()
        .filter(|e| subjects.contains(&e.from) || subjects.contains(&e.to))
        .collect();
    if related.is_empty() {
        out.push_str("- （他们身上还没有连过线）\n");
    }
    for edge in related {
        out.push_str(&edge_text(edge, &table.legend));
    }

    let titles: Vec<String> = contradictions
        .iter()
        .map(|c| c.name.clone())
        .filter(|n| !n.trim().is_empty())
        .collect();
    out.push_str(&format!(
        "【已有矛盾】{}\n",
        match titles.len() {
            0 => "（矛盾池是空的）".to_string(),
            n => format!("共 {n} 条：{}", titles.join("、")),
        }
    ));
    Ok(out)
}

/// 一条关系进材料：两端＋类型＋描述＋秘密标记。
fn edge_text(edge: &Relationship, legend: &[LegendItem]) -> String {
    let arrow = if relationship::directed_of(&edge.kind, legend) {
        "→"
    } else {
        "—"
    };
    let mut parts = vec![format!(
        "{} {arrow} {} ｜ 类型：{}",
        edge.from, edge.to, edge.kind
    )];
    if let Some(note) = opt_text(edge.note.as_deref()) {
        parts.push(format!("描述：{}", one_line(note, CORE_PREVIEW_LIMIT)));
    }
    if edge.secret {
        parts.push("秘密".to_string());
    }
    format!("- {}\n", parts.join(" ｜ "))
}

// ---------- 人物对话（工单 #16，docs/spec/人物对话.md §四） ----------

/// 人格材料：一个人的小传全文（含分组/别名）＋ 他相关的全部关系边 ＋
/// 类型圈。这份材料由前端放进**系统提示**（人格底座），不是用户消息。
/// 不塞正文与全书人物名单——「跟这个人聊」不等于「替这本书开会」。
/// 人物文件/边表/类型圈读不动一律显式报错：人格不能建立在缺页的小传上。
fn character_context(project: &Path, subjects: &[String]) -> Result<String, String> {
    let names = relationship::clean_names(subjects)?;
    let [name] = names.as_slice() else {
        return Err("「人物对话」一次只聊一个人物".to_string());
    };

    let title = project_title(project)?;
    let types = circle_types(project)?;
    let persons = project::scan_notes(project, NoteKind::Character)?;
    let Some(note) = persons.iter().find(|p| &p.name == name) else {
        return Err(format!("没有找到「{name}」的人物文件"));
    };

    let mut out = String::new();
    out.push_str(&format!("【书名】《{title}》\n"));
    out.push_str(&format!("【类型圈】{}\n", join_or(&types, "（类型圈还没定）")));

    let mut head = vec![note.name.clone()];
    if let Some(group) = opt_text(note.group.as_deref()) {
        head.push(format!("分组：{group}"));
    }
    let aliases = join_or(&note.aliases, "");
    if !aliases.is_empty() {
        head.push(format!("别名：{aliases}"));
    }
    out.push_str(&format!("【人物】{}\n", head.join(" ｜ ")));

    // 小传全文进人格底座（换行保留），超上限才截断并注明。
    let (body, truncated) = truncate_chars(note.body.trim(), PERSONA_BODY_LIMIT);
    out.push_str("【小传】\n");
    if body.is_empty() {
        out.push_str("（小传还是空的）\n");
    } else {
        if truncated {
            out.push_str(&format!("（小传已截断：只带前 {PERSONA_BODY_LIMIT} 字）\n"));
        }
        out.push_str(&body);
        out.push('\n');
    }

    // 边表读不动＝报错（与 relationship_view 的降级不同：人格材料宁可不给）。
    let table = relationship::read_table(project)?;
    let related: Vec<&Relationship> = table
        .edges
        .iter()
        .filter(|e| &e.from == name || &e.to == name)
        .collect();
    out.push_str("【关系】（与他相关的全部关系，另一端的人名照列）\n");
    if related.is_empty() {
        out.push_str("- （他身上还没有连过线）\n");
    }
    for edge in related {
        out.push_str(&edge_text(edge, &table.legend));
        // 失效引用只提示：另一端没建档，AI 该知道这人只有名字。
        for end in [&edge.from, &edge.to] {
            if end != name && !persons.iter().any(|p| &p.name == end) {
                out.push_str(&format!("  （「{end}」还没有人物文件）\n"));
            }
        }
    }
    Ok(out)
}

// ---------- 本章体检 ----------

fn unit_brief_text(brief: &UnitBrief) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(range) = range_text(brief.start_chapter, brief.end_chapter) {
        parts.push(range);
    }
    if let Some(index) = brief.index {
        parts.push(format!("排布第 {}/{} 项", index, brief.total));
    }
    for (label, value) in [
        ("线", brief.line.as_deref()),
        ("地图", brief.map.as_deref()),
        ("升级战斗", brief.upgrade_battle.as_deref()),
        ("节奏", brief.pace.as_deref()),
    ] {
        if let Some(v) = opt_text(value) {
            parts.push(format!("{label}：{v}"));
        }
    }
    let attrs = if parts.is_empty() {
        String::new()
    } else {
        format!("（{}）", parts.join(" ｜ "))
    };
    let core = opt_text(brief.core.as_deref())
        .map(|c| one_line(c, CORE_PREVIEW_LIMIT))
        .unwrap_or_else(|| "（空）".to_string());
    format!("{}{} ｜ 核心：{}", brief.name, attrs, core)
}

/// 某条线索在本章的事件行（伏笔/三线同构：埋设/兑现都落在本章的才列）。
fn chapter_events(
    head: &str,
    planted: &[AnchorView],
    paid: &[PayoffView],
    ordinal: u32,
) -> Vec<String> {
    let mut lines = Vec::new();
    for anchor in planted.iter().filter(|a| a.chapter == ordinal) {
        lines.push(format!(
            "- {head} ｜ 埋于本章 ｜ {}",
            quote_text(&anchor.quote, anchor.stale)
        ));
    }
    for payoff in paid.iter().filter(|p| p.chapter == ordinal) {
        lines.push(format!(
            "- {head} ｜ 本章兑现（{}）｜ {}",
            payoff.kind,
            quote_text(&payoff.quote, payoff.stale)
        ));
    }
    lines
}

fn foreshadow_events(views: &[ForeshadowView], ordinal: u32) -> Vec<String> {
    views
        .iter()
        .flat_map(|v| {
            let head = format!("{} ｜ 状态：{}", v.name, v.state);
            chapter_events(&head, &v.planted, &v.recovered, ordinal)
        })
        .collect()
}

fn expectation_events(views: &[ExpectationView], ordinal: u32) -> Vec<String> {
    views
        .iter()
        .flat_map(|v| {
            let head = format!("{} ｜ {}·{} ｜ 状态：{}", v.name, v.horizon, v.kind, v.state);
            chapter_events(&head, &v.planted, &v.fulfilled, ordinal)
        })
        .collect()
}

/// 未收的线：只取已埋/部分兑现（未推进章数为这些状态才有值），
/// 紧急的在前（超期 → 未推进章数），同序按表内次序，稳。
fn open_lines(views: &[ExpectationView]) -> Vec<String> {
    let mut open: Vec<&ExpectationView> = views
        .iter()
        .filter(|v| v.unadvanced_chapters.is_some())
        .collect();
    open.sort_by(|a, b| {
        b.overdue
            .cmp(&a.overdue)
            .then(b.unadvanced_chapters.cmp(&a.unadvanced_chapters))
    });
    open.into_iter()
        .map(|v| {
            let behind = v
                .unadvanced_chapters
                .map(|n| format!("距今 {n} 章未推进"))
                .unwrap_or_default();
            let overdue = if v.overdue { " ｜ 超期" } else { "" };
            format!(
                "- {} ｜ {}·{} ｜ 状态：{}{}{}",
                v.name, v.horizon, v.kind, v.state,
                if behind.is_empty() {
                    String::new()
                } else {
                    format!(" ｜ {behind}")
                },
                overdue
            )
        })
        .collect()
}

fn chapter_context(project: &Path, ordinal: u32) -> Result<String, String> {
    let title = project_title(project)?;
    let chapters = chapter::scan_chapters(project)?;
    let Some(entry) = chapters.iter().find(|c| c.ordinal == Some(ordinal)) else {
        return Err(format!(
            "没有第 {ordinal} 章（章序按文件名前缀认，未编号文件不参与）"
        ));
    };
    let unit = chapter::find_unit_for_chapter(project, ordinal)?;
    let foreshadows = foreshadow::foreshadow_board(project)?;
    let expectations = expectation::expectation_board(project)?;
    let content = read_book_md(&entry.path)?.content;
    let body = body_after_frontmatter(&content).trim().to_string();

    let mut out = String::new();
    out.push_str("【体检对象】正文单章\n");
    out.push_str(&format!("【书名】《{title}》\n"));
    let chapter_line = if entry.title.trim().is_empty() {
        format!("第 {ordinal} 章")
    } else {
        format!("第 {ordinal} 章 {}", entry.title.trim())
    };
    out.push_str(&format!("【本章】{chapter_line}\n"));
    out.push_str(&format!(
        "【所属单元】{}\n",
        match &unit {
            Some(brief) => unit_brief_text(brief),
            None => "（这一章还没落进任何单元区间）".to_string(),
        }
    ));

    let foreshadow_lines = foreshadow_events(&foreshadows, ordinal);
    if foreshadow_lines.is_empty() {
        out.push_str("【本章伏笔】（本章没有伏笔的埋设或回收）\n");
    } else {
        out.push_str(&format!("【本章伏笔】共 {} 条\n", foreshadow_lines.len()));
        for line in &foreshadow_lines {
            out.push_str(&format!("{line}\n"));
        }
    }

    let expectation_lines = expectation_events(&expectations.items, ordinal);
    if expectation_lines.is_empty() {
        out.push_str("【本章期待线】（本章没有期待线的埋设或兑现）\n");
    } else {
        out.push_str(&format!("【本章期待线】共 {} 条\n", expectation_lines.len()));
        for line in &expectation_lines {
            out.push_str(&format!("{line}\n"));
        }
    }

    let open = open_lines(&expectations.items);
    if open.is_empty() {
        out.push_str("【全书未收的线】（没有未收的线）\n");
    } else {
        let shown = open.len().min(OPEN_LINES_LIMIT);
        out.push_str(&format!(
            "【全书未收的线】共 {} 条{}\n",
            open.len(),
            if open.len() > OPEN_LINES_LIMIT {
                format!("（只列前 {OPEN_LINES_LIMIT}）")
            } else {
                String::new()
            }
        ));
        for line in open.iter().take(shown) {
            out.push_str(&format!("{line}\n"));
        }
    }

    let (text, truncated) = truncate_chars(&body, CHAPTER_TEXT_LIMIT);
    // 空章也把成对标记给全：材料的小节结构不因缺内容而破相。
    if truncated {
        out.push_str(&format!(
            "【正文】（正文已截断：只带前 {CHAPTER_TEXT_LIMIT} 字）--- 正文开始 ---\n"
        ));
    } else {
        out.push_str("【正文】--- 正文开始 ---\n");
    }
    out.push_str(if body.is_empty() { "（本章还是空的）" } else { &text });
    out.push_str("\n--- 正文结束 ---\n");
    Ok(out)
}

/// AI 陪看只读取作者已经写下的正文与可用的本章意图。
/// 伏笔、期待线和全书欠账不在这个入口里，避免把陪看变成自动审稿。
fn chapter_companion_context(project: &Path, ordinal: u32) -> Result<String, String> {
    let title = project_title(project)?;
    let chapters = chapter::scan_chapters(project)?;
    let Some(entry) = chapters.iter().find(|c| c.ordinal == Some(ordinal)) else {
        return Err(format!(
            "没有第 {ordinal} 章（章序按文件名前缀认，未编号文件不参与）"
        ));
    };
    let intent = planning::find_chapter_intent(project, ordinal)?;
    let content = read_book_md(&entry.path)?.content;
    let body = body_after_frontmatter(&content).trim().to_string();

    let mut out = String::new();
    out.push_str("【陪看对象】正文单章\n");
    out.push_str(&format!("【书名】《{title}》\n"));
    let chapter_line = if entry.title.trim().is_empty() {
        format!("第 {ordinal} 章")
    } else {
        format!("第 {ordinal} 章 {}", entry.title.trim())
    };
    out.push_str(&format!("【本章】{chapter_line}\n"));

    match (&intent.unit, &intent.bridge) {
        (Some(unit), Some(bridge)) => {
            out.push_str(&format!("【本章意图】{} → {}\n", unit.name, bridge.name));
            for (label, value) in [
                ("单元情绪目标", unit.emotion_goal.as_deref()),
                ("情绪曲线", bridge.emotion_curve.as_deref()),
                ("关键转折", bridge.key_turn.as_deref()),
                ("期待钩子", bridge.expectation_hook.as_deref()),
                ("章节拍安排", bridge.beat_plan.as_deref()),
            ] {
                if let Some(value) = opt_text(value) {
                    out.push_str(&format!("- {label}：{value}\n"));
                }
            }
        }
        _ => out.push_str(
            "【本章意图】（本章还没有匹配的单元与桥段规划；只能陪看正文，不评价规划兑现情况）\n",
        ),
    }

    let (text, truncated) = truncate_chars(&body, CHAPTER_TEXT_LIMIT);
    if truncated {
        out.push_str(&format!(
            "【正文】（正文已截断：只带前 {CHAPTER_TEXT_LIMIT} 字）--- 正文开始 ---\n"
        ));
    } else {
        out.push_str("【正文】--- 正文开始 ---\n");
    }
    out.push_str(if body.is_empty() {
        "（本章还是空的）"
    } else {
        &text
    });
    out.push_str("\n--- 正文结束 ---\n");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn project(root: &Path) -> PathBuf {
        let dir = root.join("项目/《大魏读书人》");
        fs::create_dir_all(dir.join("正文")).unwrap();
        dir
    }

    /// 一个有两项排布、两个单元、一条矛盾的常见项目。
    fn sample_project(root: &Path) -> PathBuf {
        let p = project(root);
        write(
            &p.join("项目.yaml"),
            "书名: 大魏读书人\n章前缀: 第{n}章\n地图:\n  - 京城\n",
        );
        write(
            &p.join("构思/类型圈.md"),
            "---\n类型:\n  - 掉马甲\n  - 打脸\n---\n\n类型圈正文\n",
        );
        write(
            &p.join("构思/单元/初入京城.md"),
            "---\n核心矛盾: 主角要进城\n类型:\n  - 掉马甲\n起章: 1\n止章: 4\n---\n\n单元正文\n",
        );
        write(
            &p.join("构思/单元/论道.md"),
            "---\n核心矛盾: 论道输赢\n起章: 5\n止章: 8\n---\n\n单元正文\n",
        );
        write(
            &p.join("构思/排布.yaml"),
            "- 单元: 初入京城\n  线: 主线\n  地图: 京城\n  升级战斗: 升级\n  节奏: 紧绷\n- 单元: 论道\n  节奏: 舒缓\n",
        );
        write(
            &p.join("构思/矛盾/铜钱来历.md"),
            "---\n一句话核心: 铜钱是谁留的\n类型:\n  - 掉马甲\n状态: 待用\n---\n\n展开笔记\n",
        );
        write(&p.join("正文/0003 第三章.md"), "第三章的正文。\n");
        p
    }

    #[test]
    fn 排布体检_材料含次序_核心与机检() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        let text = build_context(KIND_ARRANGEMENT, &p, None, &[]).unwrap();
        assert!(text.contains("【书名】《大魏读书人》"), "{text}");
        assert!(text.contains("【类型圈】掉马甲、打脸"), "{text}");
        assert!(text.contains("【排布】共 2 项（按全书次序）"), "{text}");
        assert!(
            text.contains("1. 初入京城 ｜ 线：主线 ｜ 地图：京城 ｜ 升级 ｜ 紧绷"),
            "{text}"
        );
        assert!(text.contains("核心：主角要进城"), "{text}");
        assert!(text.contains("2. 论道 ｜ 舒缓"), "{text}");
        assert!(text.contains("【机检提示】"), "{text}");
        assert!(text.contains("升级 1 : 战斗 0"), "{text}");
        assert!(text.contains("地图分布：京城 1"), "{text}");
    }

    #[test]
    fn 排布体检_空排布与空类型圈给显式占位() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let text = build_context(KIND_ARRANGEMENT, &p, None, &[]).unwrap();
        // 书名缺省＝文件夹名去《》（与项目列表同口径）。
        assert!(text.contains("【书名】《大魏读书人》"), "{text}");
        assert!(text.contains("【类型圈】（类型圈还没定）"), "{text}");
        assert!(text.contains("【排布】（排布还是空的）"), "{text}");
    }

    #[test]
    fn 排布体检_引用失效与未排布单元进机检() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        write(
            &p.join("构思/排布.yaml"),
            "- 单元: 不存在的单元\n- 单元: 初入京城\n",
        );
        let text = build_context(KIND_ARRANGEMENT, &p, None, &[]).unwrap();
        assert!(text.contains("排布引用了不存在的单元：不存在的单元"), "{text}");
        assert!(text.contains("还没排布的单元：论道"), "{text}");
    }

    #[test]
    fn 排布体检_单元核心缺失给占位不静默() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        write(&p.join("构思/单元/论道.md"), "---\n起章: 5\n---\n单元正文\n");
        let text = build_context(KIND_ARRANGEMENT, &p, None, &[]).unwrap();
        assert!(text.contains("核心：（空）"), "{text}");
    }

    #[test]
    fn 矛盾梳理_核心缺失取正文摘_并列已有单元() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        write(
            &p.join("构思/矛盾/无核.md"),
            "---\n状态: 待用\n---\n这是没有一句话核心的矛盾正文，应当被摘进来。\n",
        );
        let text = build_context(KIND_CONTRADICTIONS, &p, None, &[]).unwrap();
        assert!(text.contains("【已有单元】共 2 个：初入京城、论道"), "{text}");
        assert!(text.contains("【矛盾池】共 2 条"), "{text}");
        assert!(text.contains("核心：铜钱是谁留的"), "{text}");
        assert!(
            text.contains("核心（正文摘）：这是没有一句话核心的矛盾正文，应当被摘进来。"),
            "{text}"
        );
    }

    #[test]
    fn 矛盾梳理_空池与无单元给显式占位() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let text = build_context(KIND_CONTRADICTIONS, &p, None, &[]).unwrap();
        assert!(text.contains("【已有单元】（还没有单元）"), "{text}");
        assert!(text.contains("【矛盾池】（矛盾池是空的）"), "{text}");
    }

    fn sample_relationship_project(root: &Path) -> PathBuf {
        let p = sample_project(root);
        write(
            &p.join("构思/人物/张三.md"),
            "---\n分组: 主角阵营\n别名:\n  - 小陈\n---\n出身寒门，靠情报起家。\n",
        );
        write(
            &p.join("构思/人物/李四.md"),
            "---\n分组: 主角阵营\n---\n张三的徒弟。\n",
        );
        write(
            &p.join("构思/人物/王五.md"),
            "---\n分组: 敌方\n---\n国师门生。\n",
        );
        write(
            &p.join("构思/人物关系.yaml"),
            "图例:\n- 名: 师徒\n  色: \"#c0392b\"\n  方向: 有向\n- 名: 敌对\n  色: \"#7f8c8d\"\n  方向: 无向\n关系:\n- 起: 张三\n  止: 李四\n  类型: 师徒\n  描述: 收徒实为监视\n  秘密: true\n- 起: 张三\n  止: 王五\n  类型: 敌对\n- 起: 李四\n  止: 王五\n  类型: 旧识\n",
        );
        p
    }

    #[test]
    fn 人物关系梳理_材料含小传_相关边_类型圈与矛盾标题() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        let names = vec!["张三".to_string(), "王五".to_string()];
        let text = build_context(KIND_RELATIONSHIPS, &p, None, &names).unwrap();
        assert!(text.contains("【书名】《大魏读书人》"), "{text}");
        assert!(text.contains("【类型圈】掉马甲、打脸"), "{text}");
        assert!(text.contains("- 张三 ｜ 分组：主角阵营 ｜ 别名：小陈"), "{text}");
        assert!(text.contains("小传：出身寒门，靠情报起家。"), "{text}");
        assert!(text.contains("- 王五 ｜ 分组：敌方"), "{text}");
        // 李四不在选中名单里，但他那一端要出现——关系网是一张网。
        assert!(
            text.contains("张三 → 李四 ｜ 类型：师徒 ｜ 描述：收徒实为监视 ｜ 秘密"),
            "{text}"
        );
        // 无向边用「—」（方向取自图例项）。
        assert!(text.contains("张三 — 王五 ｜ 类型：敌对"), "{text}");
        assert!(text.contains("李四 → 王五 ｜ 类型：旧识"), "{text}");
        assert!(text.contains("【关系图例】"), "{text}");
        assert!(text.contains("- 师徒（有向）"), "{text}");
        assert!(text.contains("【已有矛盾】共 1 条：铜钱来历"), "{text}");
    }

    #[test]
    fn 人物关系梳理_选中小传缺失与空关系不静默() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        write(
            &p.join("构思/人物关系.yaml"),
            "关系:\n- 起: 张三\n  止: 李四\n  类型: 师徒\n",
        );
        write(&p.join("构思/矛盾/铜钱来历.md"), "---\n状态: 池中\n---\n");
        let names = vec!["张三".to_string(), "查无此人".to_string()];
        let text = build_context(KIND_RELATIONSHIPS, &p, None, &names).unwrap();
        assert!(text.contains("- 查无此人（没有找到这个小传）"), "{text}");
        // 图例是空的（手写文件没写图例）要显式占位；图例外类型走兜底方向。
        assert!(text.contains("（图例是空的）"), "{text}");
        assert!(text.contains("张三 → 李四 ｜ 类型：师徒"), "{text}");

        // 孤岛人物：没有连过线也要说出来。
        let names = vec!["张三".to_string(), "李四".to_string()];
        write(&p.join("构思/人物关系.yaml"), "图例: []\n关系: []\n");
        let text = build_context(KIND_RELATIONSHIPS, &p, None, &names).unwrap();
        assert!(text.contains("（他们身上还没有连过线）"), "{text}");
    }

    #[test]
    fn 人物关系梳理_少于两人报错_表坏了报错() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        let one = vec!["张三".to_string()];
        assert!(build_context(KIND_RELATIONSHIPS, &p, None, &one)
            .unwrap_err()
            .contains("两个人物"));
        write(&p.join("构思/人物关系.yaml"), "关系: 不是列表\n");
        let names = vec!["张三".to_string(), "李四".to_string()];
        assert!(build_context(KIND_RELATIONSHIPS, &p, None, &names).is_err());
    }

    #[test]
    fn 人物对话_材料含小传全文_他的边与类型圈() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        // 小传全文进人格底座：保留分段，不是梳理那种单行预览。
        write(
            &p.join("构思/人物/张三.md"),
            "---\n分组: 主角阵营\n别名:\n  - 小陈\n---\n第一段生平。\n\n第二段性格。\n",
        );
        let text = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["张三".to_string()]).unwrap();
        assert!(text.contains("【书名】《大魏读书人》"), "{text}");
        assert!(text.contains("【类型圈】掉马甲、打脸"), "{text}");
        assert!(text.contains("【人物】张三 ｜ 分组：主角阵营 ｜ 别名：小陈"), "{text}");
        assert!(text.contains("【小传】\n第一段生平。\n\n第二段性格。\n"), "{text}");
        assert!(
            text.contains("张三 → 李四 ｜ 类型：师徒 ｜ 描述：收徒实为监视 ｜ 秘密"),
            "{text}"
        );
        assert!(text.contains("张三 — 王五 ｜ 类型：敌对"), "{text}");
        // 李四—王五这条边跟张三无关，不进人格材料。
        assert!(!text.contains("李四 → 王五"), "{text}");
    }

    #[test]
    fn 人物对话_孤岛占位_另一端缺档只提示() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        write(
            &p.join("构思/人物关系.yaml"),
            "图例:\n- 名: 师徒\n  方向: 有向\n关系:\n- 起: 张三\n  止: 赵六\n  类型: 师徒\n",
        );
        let text = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["张三".to_string()]).unwrap();
        assert!(text.contains("张三 → 赵六 ｜ 类型：师徒"), "{text}");
        assert!(text.contains("（「赵六」还没有人物文件）"), "{text}");

        write(&p.join("构思/人物关系.yaml"), "关系: []\n");
        let text = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["李四".to_string()]).unwrap();
        assert!(text.contains("- （他身上还没有连过线）"), "{text}");
    }

    #[test]
    fn 人物对话_人物缺失_人数不对_表坏了都报错() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        let err = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["查无此人".to_string()]).unwrap_err();
        assert!(err.contains("没有找到「查无此人」"), "{err}");
        let both = vec!["张三".to_string(), "李四".to_string()];
        let err = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &both).unwrap_err();
        assert!(err.contains("一次只聊一个人物"), "{err}");
        let err = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &[]).unwrap_err();
        assert!(err.contains("没有选中人物"), "{err}");
        write(&p.join("构思/人物关系.yaml"), "关系: 不是列表\n");
        assert!(build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["张三".to_string()]).is_err());
    }

    #[test]
    fn 人物对话_小传超上限截断_空小传给占位() {
        let tmp = TempDir::new().unwrap();
        let p = sample_relationship_project(tmp.path());
        write(
            &p.join("构思/人物/张三.md"),
            &"字".repeat(PERSONA_BODY_LIMIT + 10),
        );
        let text = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["张三".to_string()]).unwrap();
        assert!(
            text.contains(&format!("（小传已截断：只带前 {PERSONA_BODY_LIMIT} 字）")),
            "{text}"
        );
        write(&p.join("构思/人物/张三.md"), "---\n---\n\n");
        let text = build_context(KIND_CHARACTER_DIALOGUE, &p, None, &["张三".to_string()]).unwrap();
        assert!(text.contains("【小传】\n（小传还是空的）"), "{text}");
    }

    fn sample_chapter_project(root: &Path) -> PathBuf {
        let p = sample_project(root);
        // 引文都真的落在正文里（不然看板的「引文失配」会把材料带偏）。
        write(
            &p.join("正文/0003 第三章.md"),
            "---\n状态: 草稿\n---\n第三章的正文。那枚铜钱还在，伤口裂开，血衣未洗，城门口有雨。\n",
        );
        write(
            &p.join("伏笔.yaml"),
            "- 名: 铜钱来历\n  状态: 已埋\n  埋设:\n    - 章: 3\n      引文: 那枚铜钱\n  回收:\n    - 章: 9\n      引文: 铜钱发烫\n      类型: 终结\n- 名: 师父的伤\n  状态: 部分收\n  埋设:\n    - 章: 2\n      引文: 咳血\n  回收:\n    - 章: 3\n      引文: 伤口裂开\n      类型: 阶段\n",
        );
        write(
            &p.join("三线.yaml"),
            "- 名: 谁杀了师父\n  类别: 期待\n  档位: 中\n  状态: 已埋\n  埋设:\n    - 章: 3\n      引文: 血衣\n- 名: 进京赶考\n  类别: 目标\n  档位: 短\n  状态: 部分兑现\n  埋设:\n    - 章: 1\n      引文: 行囊\n  兑现:\n    - 章: 3\n      引文: 城门口\n",
        );
        p
    }

    #[test]
    fn ai陪看本章_只携带正文与可用的本章意图() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        write(
            &p.join("构思/单元/初入京城.md"),
            "---\n核心矛盾: 主角要进城\n情绪目标: 先压后扬的痛快\n起章: 1\n止章: 4\n---\n\n单元正文\n",
        );
        write(
            &p.join("构思/桥段/雨夜入城.md"),
            "---\n所属单元: 初入京城\n顺序: 1\n起章: 3\n止章: 3\n情绪曲线: 压抑到释然\n关键转折: 守门人认出旧印\n期待钩子: 旧印主人仍在城中\n章节拍安排: 代入、拉扯、兑现\n---\n\n桥段备注\n",
        );

        let text = build_context("AI 陪看本章", &p, Some(3), &[]).unwrap();

        assert!(text.contains("【陪看对象】正文单章"), "{text}");
        assert!(text.contains("【本章意图】初入京城 → 雨夜入城"), "{text}");
        assert!(text.contains("单元情绪目标：先压后扬的痛快"), "{text}");
        assert!(text.contains("情绪曲线：压抑到释然"), "{text}");
        assert!(text.contains("关键转折：守门人认出旧印"), "{text}");
        assert!(text.contains("期待钩子：旧印主人仍在城中"), "{text}");
        assert!(text.contains("章节拍安排：代入、拉扯、兑现"), "{text}");
        assert!(text.contains("第三章的正文。那枚铜钱还在"), "{text}");
        assert!(!text.contains("【本章伏笔】"), "陪看不读取额外线索：{text}");
        assert!(!text.contains("【本章期待线】"), "陪看不读取额外线索：{text}");
        assert!(!text.contains("【全书未收的线】"), "陪看不读取额外线索：{text}");
    }

    #[test]
    fn ai陪看本章_没有匹配桥段时仍可用并说明上下文缺失() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());

        let text = build_context(KIND_CHAPTER_COMPANION, &p, Some(3), &[]).unwrap();

        assert!(
            text.contains("本章还没有匹配的单元与桥段规划；只能陪看正文，不评价规划兑现情况"),
            "{text}"
        );
        assert!(text.contains("第三章的正文。"), "{text}");
    }

    #[test]
    fn 本章体检_材料含本章_所属单元_伏笔三线与正文() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        let text = build_context(KIND_CHAPTER, &p, Some(3), &[]).unwrap();
        assert!(text.contains("【本章】第 3 章 第三章"), "{text}");
        assert!(
            text.contains("【所属单元】初入京城（第 1-4 章 ｜ 排布第 1/2 项 ｜ 线：主线 ｜ 地图：京城 ｜ 升级战斗：升级 ｜ 节奏：紧绷） ｜ 核心：主角要进城"),
            "{text}"
        );
        assert!(text.contains("【本章伏笔】共 2 条"), "{text}");
        assert!(
            text.contains("- 铜钱来历 ｜ 状态：已埋 ｜ 埋于本章 ｜ 引文：那枚铜钱"),
            "{text}"
        );
        assert!(
            text.contains("- 师父的伤 ｜ 状态：部分收 ｜ 本章兑现（阶段）｜ 引文：伤口裂开"),
            "{text}"
        );
        assert!(text.contains("【本章期待线】共 2 条"), "{text}");
        assert!(
            text.contains("- 谁杀了师父 ｜ 中·期待 ｜ 状态：已埋 ｜ 埋于本章 ｜ 引文：血衣"),
            "{text}"
        );
        assert!(text.contains("【全书未收的线】共 2 条"), "{text}");
        assert!(
            text.contains(
                "【正文】--- 正文开始 ---\n第三章的正文。那枚铜钱还在，伤口裂开，血衣未洗，城门口有雨。\n--- 正文结束 ---"
            ),
            "{text}"
        );
        assert!(!text.contains("状态: 草稿"), "frontmatter 不该进材料：{text}");
    }

    #[test]
    fn 本章体检_未收的线超期在前_超上限只列前三十() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        let mut yaml = String::from("- 名: 早早埋的\n  档位: 短\n  状态: 已埋\n  埋设:\n    - 章: 1\n      引文: 一句\n");
        for i in 0..35 {
            yaml.push_str(&format!(
                "- 名: 线{i}\n  档位: 长\n  状态: 已埋\n  埋设:\n    - 章: {}\n      引文: 句{i}\n",
                100 + i
            ));
        }
        write(&p.join("三线.yaml"), &yaml);
        write(&p.join("正文/0200 第二百章.md"), "很久以后的正文。\n");
        let text = build_context(KIND_CHAPTER, &p, Some(200), &[]).unwrap();
        assert!(text.contains("【全书未收的线】共 36 条（只列前 30）"), "{text}");
        let list: Vec<&str> = text
            .lines()
            .skip_while(|l| !l.starts_with("【全书未收的线】"))
            .take(31)
            .collect();
        assert_eq!(list.len(), 31, "1 行抬头 + 30 条");
        assert!(list[1].contains("早早埋的"), "距今最久的排最前：{text}");
        assert!(list[1].contains("超期"), "{text}");
    }

    #[test]
    fn 本章体检_正文超上限截断并注明() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        write(
            &p.join("正文/0003 第三章.md"),
            &format!("开头{}", "字".repeat(CHAPTER_TEXT_LIMIT + 50)),
        );
        let text = build_context(KIND_CHAPTER, &p, Some(3), &[]).unwrap();
        assert!(
            text.contains(&format!("（正文已截断：只带前 {CHAPTER_TEXT_LIMIT} 字）")),
            "{text}"
        );
        let body: String = text
            .split("--- 正文开始 ---\n")
            .nth(1)
            .unwrap()
            .split("\n--- 正文结束 ---")
            .next()
            .unwrap()
            .to_string();
        assert_eq!(body.chars().count(), CHAPTER_TEXT_LIMIT);
    }

    #[test]
    fn 本章体检_空章与无区间无伏笔给显式占位() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        write(&p.join("正文/0003 第三章.md"), "");
        let text = build_context(KIND_CHAPTER, &p, Some(3), &[]).unwrap();
        assert!(
            text.contains("【正文】--- 正文开始 ---\n（本章还是空的）\n--- 正文结束 ---"),
            "{text}"
        );
        assert!(text.contains("【本章伏笔】（本章没有伏笔的埋设或回收）"), "{text}");
        assert!(text.contains("【本章期待线】（本章没有期待线的埋设或兑现）"), "{text}");
        assert!(text.contains("【全书未收的线】（没有未收的线）"), "{text}");
    }

    #[test]
    fn 本章体检_没有这一章或没给章序都报错() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        let err = build_context(KIND_CHAPTER, &p, Some(9), &[]).unwrap_err();
        assert!(err.contains("没有第 9 章"), "{err}");
        let err = build_context(KIND_CHAPTER, &p, None, &[]).unwrap_err();
        assert!(err.contains("需要指定章序"), "{err}");
    }

    #[test]
    fn 未知命令报错() {
        let tmp = TempDir::new().unwrap();
        let p = sample_project(tmp.path());
        let err = build_context("随手一问", &p, None, &[]).unwrap_err();
        assert!(err.contains("未知的 AI 命令"), "{err}");
    }

    #[test]
    fn 线索表损坏时显式报错不降级() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        write(&p.join("伏笔.yaml"), "名: 不是列表\n");
        let err = build_context(KIND_CHAPTER, &p, Some(3), &[]).unwrap_err();
        assert!(err.contains("顶层应为列表"), "{err}");
    }

    #[test]
    fn 引文失配在材料里明说() {
        let tmp = TempDir::new().unwrap();
        let p = sample_chapter_project(tmp.path());
        write(
            &p.join("伏笔.yaml"),
            "- 名: 失配的伏笔\n  状态: 已埋\n  埋设:\n    - 章: 3\n      引文: 正文里没有这句话\n",
        );
        let text = build_context(KIND_CHAPTER, &p, Some(3), &[]).unwrap();
        assert!(text.contains("引文失配"), "{text}");
    }

    #[test]
    fn 截断按字符不按字节() {
        let (cut, truncated) = truncate_chars("你好世界", 2);
        assert_eq!(cut, "你好");
        assert!(truncated);
        let (whole, truncated) = truncate_chars("你好", 2);
        assert_eq!(whole, "你好");
        assert!(!truncated);
    }

    #[test]
    fn 单行折叠压掉换行与多余空白() {
        assert_eq!(one_line("  第一行\n\n第二行\t末  ", 80), "第一行 第二行 末");
        assert_eq!(one_line("一二三四五", 3), "一二三…");
    }
}
