//! 灵感库（设计共识 §六）：九类卡片＋未分类兜底，一卡一文件，
//! 存于库根「灵感库/<类别>/<标题>.md」。标题即文件名、类别即文件夹
//! （Obsidian 里照样浏览）；frontmatter 中文键只存 标签/来源/关联/
//! 一句话核心，保存以现有文件为底合并、未知键原样保留——与拆书
//! yaml 同一套策略（ADR 0002：文件为唯一数据源，可随时回到 Obsidian）。
//!
//! 导入旧「灵感.md」：按 markdown 标题分节，「标签：」行与 #话题 双
//! 来源取标签，标签命中类别别名即归类、杂项落未分类；原文件只读不改。

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_yaml::Value;

use crate::book_file::{
    map_list, frontmatter_mapping, has_md_extension, is_hidden, map_scalar, push_split,
    read_text, sanitize_file_name, set_map_list, set_map_scalar, split_frontmatter, strip_bom,
    unique_file_path, write_frontmatter,
};

/// 灵感库在库根下的目录名；书库扫描与全文搜索跳过该目录。
pub const LIBRARY_DIR: &str = "灵感库";

/// 九类卡片＋未分类兜底（设计共识 §六）。IPC 值与文件夹名同为中文名
/// （serde 手写实现直接复用 name()，中文名只有一份真相）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardCategory {
    Story,
    GoldenFinger,
    Genre,
    Fragment,
    Character,
    Organization,
    Worldview,
    Technique,
    Title,
    Uncategorized,
}

impl Serialize for CardCategory {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> Deserialize<'de> for CardCategory {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl de::Visitor<'_> for Visitor {
            type Value = CardCategory;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("卡片类别名（如「故事卡」）")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<CardCategory, E> {
                CardCategory::from_name(v).ok_or_else(|| E::custom(format!("未知卡片类别「{v}」")))
            }
        }
        deserializer.deserialize_str(Visitor)
    }
}

impl CardCategory {
    pub const ALL: [CardCategory; 10] = [
        CardCategory::Story,
        CardCategory::GoldenFinger,
        CardCategory::Genre,
        CardCategory::Fragment,
        CardCategory::Character,
        CardCategory::Organization,
        CardCategory::Worldview,
        CardCategory::Technique,
        CardCategory::Title,
        CardCategory::Uncategorized,
    ];

    /// IPC 值与文件夹名（serde 重命名与之一致）。
    pub fn name(self) -> &'static str {
        match self {
            CardCategory::Story => "故事卡",
            CardCategory::GoldenFinger => "金手指卡",
            CardCategory::Genre => "题材卡",
            CardCategory::Fragment => "片段卡",
            CardCategory::Character => "角色卡",
            CardCategory::Organization => "组织卡",
            CardCategory::Worldview => "世界观卡",
            CardCategory::Technique => "技法卡",
            CardCategory::Title => "书名卡",
            CardCategory::Uncategorized => "未分类",
        }
    }

    pub fn from_name(name: &str) -> Option<CardCategory> {
        CardCategory::ALL.into_iter().find(|c| c.name() == name)
    }

    /// 旧灵感标签 → 类别的别名表（导入归类用；CONTEXT.md 的 _Avoid_ 词
    /// ——点子、脑洞——是旧文件里的存量叫法，这里正是收编它们的地方）。
    const ALIASES: &[(CardCategory, &[&str])] = &[
        (CardCategory::Story, &["故事", "故事卡", "点子", "脑洞"]),
        (CardCategory::GoldenFinger, &["金手指", "金手指卡"]),
        (CardCategory::Genre, &["题材", "题材卡"]),
        (CardCategory::Fragment, &["片段", "片段卡"]),
        (CardCategory::Character, &["角色", "角色卡", "人物"]),
        (CardCategory::Organization, &["组织", "组织卡", "势力"]),
        (CardCategory::Worldview, &["世界观", "世界观卡", "设定"]),
        (CardCategory::Technique, &["技法", "技法卡", "技巧"]),
        (CardCategory::Title, &["书名", "书名卡"]),
    ];

    fn from_tag(tag: &str) -> Option<CardCategory> {
        Self::ALIASES
            .iter()
            .find(|(_, aliases)| aliases.iter().any(|a| tag.contains(a)))
            .map(|(c, _)| *c)
    }
}

/// 卡片保存入参（新建与编辑共用；编辑时另传 prev_path）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDraft {
    pub category: CardCategory,
    pub title: String,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub links: Vec<String>,
    /// 一句话核心（人物＋困境＋爽点预期），故事卡专属字段。
    pub core: Option<String>,
    pub body: String,
}

/// 扫描出的卡片：草稿字段＋盘上位置（path 即卡片身份）与修改时间。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspirationCard {
    pub path: PathBuf,
    pub category: CardCategory,
    pub title: String,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub links: Vec<String>,
    pub core: Option<String>,
    pub body: String,
    /// Unix 秒，前端按「最近在前」排；取不到为 0。
    pub mtime: u64,
    /// 待打磨中（工单 #64）：frontmatter 的 `待打磨: true`；随卡片文件保存。
    pub pending: bool,
}

/// 旧「灵感.md」拆出的一条灵感：预览时可改类别，确认后按卡落盘。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub category: CardCategory,
}

// --- 扫描 ---

/// 扫描库根的「灵感库/」目录。目录不存在视为空库（首次使用）；
/// 单个坏文件降级为「整文件入正文」，不拖垮整个列表。
pub fn scan_inspirations(root: &Path) -> Result<Vec<InspirationCard>, String> {
    if !root.is_dir() {
        return Err(format!("不是有效的文件夹：{}", root.display()));
    }
    let dir = root.join(LIBRARY_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths: Vec<PathBuf> = Vec::new();
    collect_card_paths(&dir, &mut paths);
    paths.sort();
    Ok(paths.iter().map(|p| read_card(p)).collect())
}

/// 收集「灵感库/」下的卡片：类别子目录一层＋库根散文件
/// （散文件与未知子目录都归未分类，手放文件不丢）。
fn collect_card_paths(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        if path.is_dir() {
            let Ok(inner) = fs::read_dir(&path) else {
                continue;
            };
            for e in inner.flatten() {
                let p = e.path();
                if !is_hidden(&p) && p.is_file() && has_md_extension(&p) {
                    out.push(p);
                }
            }
        } else if has_md_extension(&path) {
            out.push(path);
        }
    }
}

/// 按路径读一张卡片（类别取自父目录名）；扫描、保存、跨板块转生共用。
pub fn read_card(path: &Path) -> InspirationCard {
    let category = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .and_then(CardCategory::from_name)
        .unwrap_or(CardCategory::Uncategorized);
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut card = InspirationCard {
        path: path.to_path_buf(),
        category,
        title,
        tags: Vec::new(),
        source: None,
        links: Vec::new(),
        core: None,
        body: String::new(),
        mtime: mtime_of(path),
        pending: false,
    };

    let Ok(raw) = read_text(path) else {
        return card;
    };
    let raw = strip_bom(&raw);
    match split_frontmatter(raw) {
        Some((yaml_text, body)) => {
            if yaml_text.trim().is_empty() {
                card.body = body;
            } else {
                match serde_yaml::from_str::<Value>(&yaml_text) {
                    Ok(Value::Mapping(map)) => {
                        card.tags = map_list(&map, "标签");
                        card.source = map_scalar(&map, "来源");
                        card.links = map_list(&map, "关联");
                        card.core = map_scalar(&map, "一句话核心");
                        card.pending = crate::book_file::is_pending(&map);
                        card.body = body;
                    }
                    _ => {
                        // frontmatter 损坏：整文件原样入正文，保存时内容不丢。
                        card.body = raw.to_string();
                    }
                }
            }
        }
        None => {
            card.body = raw.to_string();
        }
    }
    card
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- 保存 / 删除 ---

/// 保存卡片：新建（prev_path 为 None）或编辑（含改标题/换类别 → 文件
/// 改名挪目录）。目标位置冲突时续号（标题-2、标题-3……），不覆盖他人。
pub fn save_card(
    root: &Path,
    draft: &CardDraft,
    prev_path: Option<&Path>,
) -> Result<InspirationCard, String> {
    let title = sanitize_title(&draft.title)?;
    let dir = root.join(LIBRARY_DIR).join(draft.category.name());
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;

    let path = unique_file_path(&dir, &format!("{title}.md"), prev_path);

    // 底图取旧位置（改名/换类别的编辑）或目标位置自身的 frontmatter，
    // 手补的未知键不丢；frontmatter 损坏按空底处理（保存即重建）。
    let base = prev_path.filter(|p| *p != path).unwrap_or(&path);
    let mut map = frontmatter_mapping(base).unwrap_or_default();

    set_map_list(&mut map, "标签", &draft.tags);
    set_map_scalar(&mut map, "来源", draft.source.as_deref());
    set_map_list(&mut map, "关联", &draft.links);
    set_map_scalar(&mut map, "一句话核心", draft.core.as_deref());

    // 改名/换类别先挪再写：挪失败时盘上无变化；挪成功后写失败，
    // 卡片仍在（内容是旧的）——两种失败都不产生重复卡。
    if let Some(prev) = prev_path {
        if prev != path {
            fs::rename(prev, &path)
                .map_err(|e| format!("无法移动卡片到 {}：{e}", path.display()))?;
        }
    }
    write_frontmatter(&path, map, &draft.body)?;
    Ok(read_card(&path))
}

/// 保存灵感速记：先收下原文，不要求作者在灵感到来时补标题或归类。
/// 临时标题只取首句；正文保持传入的完整多行内容，后续仍可在卡片编辑里整理。
pub fn save_quick_capture(root: &Path, body: &str) -> Result<InspirationCard, String> {
    let title = quick_capture_title(body)?;
    let draft = CardDraft {
        category: CardCategory::Uncategorized,
        title,
        tags: Vec::new(),
        source: None,
        links: Vec::new(),
        core: None,
        body: body.to_string(),
    };
    save_card(root, &draft, None)
}

fn quick_capture_title(body: &str) -> Result<String, String> {
    let content = body.trim();
    if content.is_empty() {
        return Err("灵感速记不能为空".to_string());
    }
    let title = content
        .split_inclusive(|c| matches!(c, '。' | '！' | '？' | '!' | '?'))
        .next()
        .unwrap_or(content)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return Err("灵感速记不能为空".to_string());
    }
    Ok(title)
}

pub fn delete_card(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("无法删除卡片 {}：{e}", path.display()))
}

/// 在卡片「关联」里追加一条去向（trim 后同值不重复），返回更新后的卡片。
/// 单向记账：只改卡片侧，不反向写任何硬引用（#4 纪律）。
pub fn append_link(
    root: &Path,
    card: &InspirationCard,
    link: &str,
) -> Result<InspirationCard, String> {
    let link = link.trim();
    if card.links.iter().any(|l| l.trim() == link) {
        return Ok(card.clone());
    }
    let mut links = card.links.clone();
    links.push(link.to_string());
    let draft = CardDraft {
        category: card.category,
        title: card.title.clone(),
        tags: card.tags.clone(),
        source: card.source.clone(),
        links,
        core: card.core.clone(),
        body: card.body.clone(),
    };
    save_card(root, &draft, Some(&card.path))
}

/// 确认导入：预览条目逐张落盘（标题冲突自动续号），返回新卡路径。
/// source_label 记入卡片的「来源」（如「导入自 灵感.md」），留个出处。
pub fn confirm_import(
    root: &Path,
    entries: &[ImportEntry],
    source_label: Option<&str>,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::with_capacity(entries.len());
    for e in entries {
        let draft = CardDraft {
            category: e.category,
            title: e.title.clone(),
            tags: e.tags.clone(),
            source: source_label.map(str::to_string),
            links: Vec::new(),
            core: None,
            body: e.body.clone(),
        };
        paths.push(save_card(root, &draft, None)?.path);
    }
    Ok(paths)
}

/// 卡片标题的文件名净化；错误文案说「标题」而不是泛泛的「名称」。
pub(crate) fn sanitize_title(title: &str) -> Result<String, String> {
    sanitize_file_name(title).map_err(|_| "卡片标题不能为空（或只剩符号）".to_string())
}

// --- 导入旧灵感.md ---

/// 解析旧「灵感.md」为待确认条目：markdown 标题分节，正文里的
/// 「标签：」行与整行 #话题 都是标签来源；标签命中类别别名即归类，
/// 其余落未分类。首节标题前的散行也成一条（标题取首行）。
pub fn import_preview(content: &str) -> Vec<ImportEntry> {
    let content = strip_bom(content);
    let mut sections: Vec<Section> = Vec::new();
    let mut preamble: Vec<&str> = Vec::new();

    for line in content.lines() {
        match heading_text(line) {
            Some(text) => {
                if !preamble.iter().all(|l| l.trim().is_empty()) {
                    sections.push(Section {
                        title: preamble_title(&preamble),
                        tags: Vec::new(),
                        body_lines: preamble.clone(),
                    });
                    preamble = Vec::new();
                }
                let (title, tags) = strip_hashtags(&text);
                let title = if title.is_empty() {
                    "未命名片段".to_string()
                } else {
                    title
                };
                sections.push(Section {
                    title,
                    tags,
                    body_lines: Vec::new(),
                });
            }
            None => match sections.last_mut() {
                Some(section) => section.body_lines.push(line),
                None => preamble.push(line),
            },
        }
    }
    if !preamble.iter().all(|l| l.trim().is_empty()) {
        sections.push(Section {
            title: preamble_title(&preamble),
            tags: Vec::new(),
            body_lines: preamble,
        });
    }

    sections
        .into_iter()
        .map(|mut section| {
            let body = extract_tag_lines(&section.body_lines, &mut section.tags);
            let category = section
                .tags
                .iter()
                .find_map(|t| CardCategory::from_tag(t))
                .unwrap_or(CardCategory::Uncategorized);
            ImportEntry {
                title: section.title,
                body,
                tags: section.tags,
                category,
            }
        })
        .collect()
}

/// 解析中的一节：一个 markdown 标题（或散行块）及其下正文行。
struct Section<'a> {
    title: String,
    tags: Vec<String>,
    body_lines: Vec<&'a str>,
}

/// markdown 标题行（`#` ×1..6 后跟空白，CommonMark 口径）→ 标题文本。
/// `#话题` 无空白不算标题（那是有话题标签的正文行）。
fn heading_text(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    rest.strip_prefix([' ', '\t']).map(|t| t.trim().to_string())
}

/// 文本尾部（或任意位置）的 #话题 收为标签，从原文摘除；
/// 主文再去掉尾部悬挂的分隔符。
fn strip_hashtags(text: &str) -> (String, Vec<String>) {
    let mut tags = Vec::new();
    collect_hashtags(text, &mut tags);
    let mut main = text.to_string();
    for t in &tags {
        main = main.replace(&format!("#{t}"), "");
    }
    let main = main
        .trim()
        .trim_end_matches(['：', ':', '—', '－', '-', '–', ' '])
        .to_string();
    (main, tags)
}

/// 文本里的 #话题：# 后连续的中英文字母/数字/下划线/短横。
fn collect_hashtags(text: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '#' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < chars.len()
            && (chars[end].is_alphanumeric() || chars[end] == '_' || chars[end] == '-')
        {
            end += 1;
        }
        if end > start {
            let tag: String = chars[start..end].iter().collect();
            if !out.contains(&tag) {
                out.push(tag);
            }
            i = end;
        } else {
            i += 1;
        }
    }
}

/// 「标签：」行的值并入标签（、，,；; 与空白分隔）；只剩 #话题 的行
/// 收为标签后剥离；其余正文行原样保留。
fn extract_tag_lines(lines: &[&str], tags: &mut Vec<String>) -> String {
    let mut body: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines {
        let t = line.trim_start();
        if let Some(rest) = t
            .strip_prefix("标签")
            .and_then(|r| r.strip_prefix(['：', ':']))
        {
            push_split(tags, rest);
            continue;
        }
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            let mut line_tags = Vec::new();
            collect_hashtags(trimmed, &mut line_tags);
            if !line_tags.is_empty() {
                let without: String = line_tags.iter().fold(trimmed.to_string(), |acc, t| {
                    acc.replace(&format!("#{t}"), "")
                });
                if without.trim().is_empty() {
                    tags.extend(line_tags);
                    tags.dedup();
                    continue;
                }
            }
        }
        body.push(line.to_string());
    }
    body.join("\n").trim().to_string()
}

/// 无标题散块：首行当标题，压到 30 字、超长补省略号。
fn preamble_title(lines: &[&str]) -> String {
    let first = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim())
        .unwrap_or("");
    if first.is_empty() {
        return "未命名片段".to_string();
    }
    if first.chars().count() <= 30 {
        return first.to_string();
    }
    let mut s: String = first.chars().take(30).collect();
    s.push('…');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn draft() -> CardDraft {
        CardDraft {
            category: CardCategory::Story,
            title: "外卖小哥的末世签到".to_string(),
            tags: vec!["末世".into(), "掉马甲".into()],
            source: Some("拆《大奉打更人》有感".into()),
            links: vec!["《大奉打更人》".into(), "囤物资流金手指".into()],
            core: Some("外卖员得签到系统，末世囤物资被当扫地僧".into()),
            body: "一句话展开的正文，可以是多行。".to_string(),
        }
    }

    #[test]
    fn 类别_ipc_序列化为中文() {
        assert_eq!(
            serde_json::to_string(&CardCategory::Story).unwrap(),
            "\"故事卡\""
        );
        let back: CardCategory = serde_json::from_str("\"金手指卡\"").unwrap();
        assert_eq!(back, CardCategory::GoldenFinger);
        assert!(
            serde_json::from_str::<CardCategory>("\"不存在的类别\"").is_err(),
            "未知类别应报错而非静默回退"
        );
        assert_eq!(CardCategory::ALL.len(), 10);
        assert!(CardCategory::ALL
            .iter()
            .all(|c| CardCategory::from_name(c.name()) == Some(*c)));
    }

    #[test]
    fn 卡片_ipc_走_camelCase() {
        let d = draft();
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"category\":\"故事卡\""));
        assert!(json.contains("\"core\""));
        let back: CardDraft = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
    }

    #[test]
    fn 保存_新建_中文键落盘并往返() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        assert!(card.path.ends_with("灵感库/故事卡/外卖小哥的末世签到.md"));

        let text = fs::read_to_string(&card.path).unwrap();
        assert!(text.starts_with("---\n"));
        assert!(text.contains("标签:"));
        assert!(text.contains("- 末世"));
        assert!(text.contains("- 掉马甲"));
        assert!(text.contains("来源: 拆《大奉打更人》有感"));
        assert!(text.contains("关联:"));
        assert!(text.contains("- 《大奉打更人》"));
        assert!(text.contains("一句话核心: 外卖员得签到系统"));
        assert!(text.ends_with("一句话展开的正文，可以是多行。"));

        let cards = scan_inspirations(&root).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "外卖小哥的末世签到");
        assert_eq!(cards[0].category, CardCategory::Story);
        assert_eq!(cards[0].tags, vec!["末世", "掉马甲"]);
        assert_eq!(cards[0].links.len(), 2);
        assert_eq!(
            cards[0].core.as_deref(),
            Some("外卖员得签到系统，末世囤物资被当扫地僧")
        );
        assert_eq!(cards[0].body, "一句话展开的正文，可以是多行。");
    }

    #[test]
    fn 灵感速记_未分类_首句为临时标题并完整保留多行() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let body = "主角在雨夜捡到一封密信。\n第二天，满城都在找它。\n\n他决定先不交出去。";

        let card = save_quick_capture(&root, body).unwrap();

        assert_eq!(card.category, CardCategory::Uncategorized);
        assert_eq!(card.title, "主角在雨夜捡到一封密信。");
        assert_eq!(card.body, body);
        assert!(card.tags.is_empty());
        assert_eq!(card.source, None);
        assert!(card.links.is_empty());
        assert!(card.path.ends_with("灵感库/未分类/主角在雨夜捡到一封密信。.md"));
    }

    #[test]
    fn 灵感速记_首句跨换行仍取完整一句() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let body = "主角在雨夜捡到一封\n密信。第二天，满城都在找它。";

        let card = save_quick_capture(&root, body).unwrap();

        assert_eq!(card.title, "主角在雨夜捡到一封 密信。");
        assert_eq!(card.body, body);
    }

    #[test]
    fn 灵感速记_空白内容不落盘() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().to_path_buf();

        assert!(save_quick_capture(&root, " \n\t ").is_err());
        assert!(scan_inspirations(&root).unwrap().is_empty());
    }

    #[test]
    fn 保存_编辑改标题换类别_旧文件删除_未知键保留() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        // 在 frontmatter 里手补未知键（模拟用户在 Obsidian 里加的字段）
        let text = fs::read_to_string(&card.path).unwrap();
        write(
            &card.path,
            &text.replacen("\n---\n", "\n自定义键: 保留我\n---\n", 1),
        );

        let mut d = draft();
        d.title = "换个名字".to_string();
        d.category = CardCategory::GoldenFinger;
        d.tags = Vec::new();
        let moved = save_card(&root, &d, Some(&card.path)).unwrap();

        assert!(!card.path.exists(), "旧位置文件应删除");
        assert!(moved.path.ends_with("灵感库/金手指卡/换个名字.md"));
        let text = fs::read_to_string(&moved.path).unwrap();
        assert!(text.contains("自定义键: 保留我"));
        assert!(!text.contains("标签"), "空标签应移除键");
    }

    #[test]
    fn 保存_不改标题_原地更新_旧文件不动() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        let mut d = draft();
        d.body = "改过的正文".to_string();
        let saved = save_card(&root, &d, Some(&card.path)).unwrap();

        assert_eq!(saved.path, card.path);
        assert_eq!(saved.body, "改过的正文");
        assert_eq!(scan_inspirations(&root).unwrap().len(), 1);
    }

    #[test]
    fn 保存_同名卡片_续号不覆盖() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let a = save_card(&root, &draft(), None).unwrap();
        let mut d = draft();
        d.body = "另一张卡的内容".to_string();
        let b = save_card(&root, &d, None).unwrap();

        assert_ne!(a.path, b.path);
        assert!(b.path.to_string_lossy().contains("外卖小哥的末世签到-2.md"));
        assert!(fs::read_to_string(a.path).unwrap().contains("一句话展开"));
    }

    #[test]
    fn 保存_非法标题_净化与报错() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let mut d = draft();
        d.title = "标题: 带非法/字符?".to_string();

        let card = save_card(&root, &d, None).unwrap();
        assert!(card.path.to_string_lossy().contains("标题_ 带非法_字符_"));

        d.title = "   ".to_string();
        assert!(save_card(&root, &d, None).is_err());
        d.title = "***".to_string();
        assert!(save_card(&root, &d, None).is_err(), "纯符号标题应报错");
    }

    #[test]
    fn 扫描_散文件与未知目录_归未分类() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(
            &root.join("灵感库/未分类的手账.md"),
            "---\n标签: [脑洞]\n---\n\n正文",
        );
        write(&root.join("灵感库/临时/草稿.md"), "没有 frontmatter 的卡");

        let cards = scan_inspirations(&root).unwrap();
        assert_eq!(cards.len(), 2);
        assert!(cards
            .iter()
            .all(|c| c.category == CardCategory::Uncategorized));
        let 手账 = cards.iter().find(|c| c.title == "未分类的手账").unwrap();
        assert_eq!(手账.tags, vec!["脑洞"]);
        let 草稿 = cards.iter().find(|c| c.title == "草稿").unwrap();
        assert_eq!(草稿.body, "没有 frontmatter 的卡");
    }

    #[test]
    fn 扫描_损坏frontmatter_整文入正文() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(
            &root.join("灵感库/故事卡/坏卡.md"),
            "---\n{{{{不是 yaml\n---\n\n正文在下面",
        );

        let cards = scan_inspirations(&root).unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].body.contains("{{{{不是 yaml"));
        assert!(cards[0].body.contains("正文在下面"));
        assert!(cards[0].tags.is_empty());
    }

    #[test]
    fn 扫描_隐藏文件跳过() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("灵感库/故事卡/.草稿.md"), "x");
        write(&root.join("灵感库/故事卡/正卡.md"), "y");

        let cards = scan_inspirations(&root).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "正卡");
    }

    #[test]
    fn 扫描_无灵感库目录_返回空_库根无效报错() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        assert!(scan_inspirations(&root).unwrap().is_empty());
        write(&root.join("某书.md"), "第1章");
        assert!(scan_inspirations(&root).unwrap().is_empty());

        let missing = root.join("不存在的");
        assert!(scan_inspirations(&missing).is_err());
    }

    #[test]
    fn 删除_移除文件() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        delete_card(&card.path).unwrap();
        assert!(!card.path.exists());
        assert!(delete_card(&card.path).is_err());
    }

    #[test]
    fn 导入_标题分节_标签行与话题归类() {
        let content = "\
开场白：这行属于第一条
## 外卖成神 #末世
标签：故事、爽文
正文第一行
#金手指
另一段

# 随手记的点子
标签：脑洞
只有一个想法没展开
";
        let entries = import_preview(content);
        assert_eq!(entries.len(), 3);

        let 第一 = &entries[0];
        assert_eq!(第一.title, "开场白：这行属于第一条");
        assert_eq!(第一.category, CardCategory::Uncategorized);
        assert_eq!(第一.body, "开场白：这行属于第一条");

        let 第二 = &entries[1];
        assert_eq!(第二.title, "外卖成神");
        assert_eq!(第二.category, CardCategory::Story); // 标签「故事」命中
        assert_eq!(第二.tags, vec!["末世", "故事", "爽文", "金手指"]);
        assert_eq!(第二.body, "正文第一行\n另一段");

        let 第三 = &entries[2];
        assert_eq!(第三.category, CardCategory::Story); // 别名「脑洞」命中
        assert_eq!(第三.body, "只有一个想法没展开");
    }

    #[test]
    fn 导入_各类别名命中_其余落未分类() {
        let cases = [
            ("金手指", CardCategory::GoldenFinger),
            ("题材", CardCategory::Genre),
            ("片段", CardCategory::Fragment),
            ("人物", CardCategory::Character),
            ("势力", CardCategory::Organization),
            ("设定", CardCategory::Worldview),
            ("技巧", CardCategory::Technique),
            ("书名", CardCategory::Title),
            ("美食文", CardCategory::Uncategorized),
        ];
        for (tag, expect) in cases {
            let entries = import_preview(&format!("## 某条\n标签：{tag}\n正文"));
            assert_eq!(entries[0].category, expect, "标签「{tag}」应归 {expect:?}");
        }
    }

    #[test]
    fn 导入_确认落盘_续号去重() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap(); // 已有同名卡

        let entries = vec![
            ImportEntry {
                title: "外卖小哥的末世签到".to_string(),
                body: "导入的旧灵感".to_string(),
                tags: vec!["故事".to_string()],
                category: CardCategory::Story,
            },
            ImportEntry {
                title: "全新点子".to_string(),
                body: "正文".to_string(),
                tags: vec![],
                category: CardCategory::Uncategorized,
            },
        ];
        // 标签成品由命令层拼好（「导入自 <文件名>」），这里直传成品
        let paths = confirm_import(&root, &entries, Some("导入自 灵感.md")).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0]
            .to_string_lossy()
            .contains("外卖小哥的末世签到-2.md"));
        assert!(paths[1].ends_with("灵感库/未分类/全新点子.md"));

        // 原卡未被动过；导入卡记了出处
        assert!(fs::read_to_string(card.path)
            .unwrap()
            .contains("一句话展开"));
        let cards = scan_inspirations(&root).unwrap();
        assert_eq!(cards.len(), 3);
        let 导入卡 = cards.iter().find(|c| c.path == paths[1]).unwrap();
        assert_eq!(导入卡.source.as_deref(), Some("导入自 灵感.md"));
    }

    // --- 待打磨（工单 #64 / T03）：状态随卡片文件保存，不挪文件不建副本 ---

    #[test]
    fn 待打磨_进入退出_键落盘_未知键与正文不动_类别路径不动() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        // 模拟用户在 Obsidian 里手补的键。
        let text = fs::read_to_string(&card.path).unwrap();
        write(
            &card.path,
            &text.replacen("\n---\n", "\n自定义键: 保留我\n---\n", 1),
        );
        let before = crate::book_file::count_files_recursive(&root);
        let mtime = fs::metadata(&card.path).unwrap().modified().unwrap();

        // 进入：文件里多一个「待打磨: true」，其余原样。
        crate::book_file::set_pending(&card.path, true).unwrap();
        let text = fs::read_to_string(&card.path).unwrap();
        assert!(text.contains("待打磨: true"), "{text}");
        assert!(text.contains("自定义键: 保留我"), "{text}");
        assert!(text.ends_with("一句话展开的正文，可以是多行。"), "{text}");
        let scanned = scan_inspirations(&root).unwrap();
        assert_eq!(scanned.len(), 1);
        assert!(scanned[0].pending);
        assert_eq!(scanned[0].category, CardCategory::Story, "类别（目录）不动");
        assert_eq!(scanned[0].path, card.path, "路径不动，排序位置自然不动");

        // 退出：键移除，未知键与正文仍在；没有产生第二份文件；便笺区清空。
        crate::book_file::set_pending(&card.path, false).unwrap();
        let text = fs::read_to_string(&card.path).unwrap();
        assert!(!text.contains("待打磨"), "{text}");
        assert!(text.contains("自定义键: 保留我"), "{text}");
        assert!(text.contains("一句话展开的正文"), "{text}");
        let scanned = scan_inspirations(&root).unwrap();
        assert!(!scanned[0].pending);
        assert!(
            scanned.iter().filter(|c| c.pending).count() == 0,
            "读模型里待打磨区为空（前端整个区域不渲染）"
        );
        assert_eq!(crate::book_file::count_files_recursive(&root), before, "进出待打磨不建副本或便笺库");
        // 状态操作不顶「最近在前」的排序：mtime 复原，卡片回原位置。
        let after = fs::metadata(&card.path).unwrap().modified().unwrap();
        assert_eq!(after, mtime, "切换待打磨不改修改时间（排序键不动）");
    }

    #[test]
    fn 待打磨_便笺中编辑_保存合并保留状态_权威文件同一内容() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let card = save_card(&root, &draft(), None).unwrap();
        crate::book_file::set_pending(&card.path, true).unwrap();

        // 便笺里的编辑走正常保存路径：frontmatter 以现有文件为底合并，
        // 「待打磨」不在草稿字段里，也不该被抹掉。
        let mut d = draft();
        d.body = "在便笺里改过的正文".to_string();
        let saved = save_card(&root, &d, Some(&card.path)).unwrap();

        assert_eq!(saved.path, card.path, "编辑不挪文件");
        assert!(saved.pending, "保存合并后仍是待打磨");
        assert_eq!(saved.body, "在便笺里改过的正文");
        assert_eq!(scan_inspirations(&root).unwrap()[0].body, "在便笺里改过的正文");
        assert!(fs::read_to_string(&card.path).unwrap().contains("待打磨: true"));

        // 改名/换类别的编辑同样带状态走（底图取旧位置）。
        d.title = "换个名字".to_string();
        d.category = CardCategory::GoldenFinger;
        let moved = save_card(&root, &d, Some(&card.path)).unwrap();
        assert!(moved.pending, "改名换类别也保留待打磨");
        assert!(moved.path.ends_with("灵感库/金手指卡/换个名字.md"));
    }

    #[test]
    fn 待打磨_旧内容与手写false_按普通内容() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        // 旧内容：没有该键。
        write(&root.join("灵感库/故事卡/老卡.md"), "---\n标签: [掉马甲]\n---\n\n旧正文");
        // 手写 false：不算待打磨，键值原样保留。
        write(&root.join("灵感库/故事卡/手写卡.md"), "---\n待打磨: false\n---\n\n手写正文");

        let cards = scan_inspirations(&root).unwrap();
        assert!(cards.iter().all(|c| !c.pending), "旧内容按普通内容处理");
        let 手写卡 = cards.iter().find(|c| c.title == "手写卡").unwrap();
        assert!(fs::read_to_string(&手写卡.path)
            .unwrap()
            .contains("待打磨: false"), "不认识的值不改动");

        // 手写 false 的卡再进入：true 覆盖；退出：整键移除。
        crate::book_file::set_pending(&手写卡.path, true).unwrap();
        assert!(scan_inspirations(&root).unwrap().iter().find(|c| c.title == "手写卡").unwrap().pending);
        crate::book_file::set_pending(&手写卡.path, false).unwrap();
        let text = fs::read_to_string(&手写卡.path).unwrap();
        assert!(!text.contains("待打磨"), "{text}");
        assert!(text.contains("手写正文"), "{text}");
    }

    #[test]
    fn 待打磨_无frontmatter与损坏头_正文保全() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("灵感库/未分类/裸文件.md"), "只有正文的速记");
        crate::book_file::set_pending(&root.join("灵感库/未分类/裸文件.md"), true).unwrap();
        let text = fs::read_to_string(&root.join("灵感库/未分类/裸文件.md")).unwrap();
        assert!(text.contains("待打磨: true"), "{text}");
        assert!(text.contains("只有正文的速记"), "{text}");
        assert!(scan_inspirations(&root).unwrap()[0].pending);

        // 损坏头与保存同一口径：整文件入正文、重建头，内容不丢。
        write(&root.join("灵感库/未分类/坏头.md"), "---\n{{{{不是 yaml\n---\n\n正文在下面");
        crate::book_file::set_pending(&root.join("灵感库/未分类/坏头.md"), true).unwrap();
        let scanned = scan_inspirations(&root).unwrap();
        let 坏头 = scanned.iter().find(|c| c.title == "坏头").unwrap();
        assert!(坏头.pending);
        assert!(坏头.body.contains("正文在下面"), "坏头卡正文不丢");
    }
}
