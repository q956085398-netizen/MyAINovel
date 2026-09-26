//! 构思项目（工单 #4，docs/spec/构思数据模型.md）：库根「项目/」下
//! 一书一文件夹，文件为唯一数据源（ADR 0002），写路径原子＋读-合-写
//! （ADR 0004）。拆书与构思互不相认——书库扫描/搜索/词表聚合跳过
//! 「项目/」（library.rs），两者只经「词表.yaml ＋ 灵感库」通行。
//!
//! 布局（目录随写入懒生成；只有 正文/ 的项目、只有构思数据的项目都合法）：
//!
//! ```text
//! 项目/《书名》/
//!   项目.yaml            # 书名、章前缀、情节线、地图（懒生成）
//!   正文/<NNNN 标题>.md  # 书写板块的章节文件（本模块只统计，编辑归工单 #5）
//!   附件/
//!   构思/
//!     类型圈.md
//!     排布.yaml
//!     矛盾/<名>.md  单元/<名>.md  人物/<人名>.md  世界观/<词条>.md  开头/<版本>.md
//! ```
//!
//! 按名引用（排布→单元、排布属性→情节线/地图）一律只提示不自动改，
//! 引用失效标失效，删改留给人（spec「损坏与冲突」节）。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_yaml::{Mapping, Value};

use crate::book_file::{
    content_fingerprint, has_md_extension, is_hidden, lossy_yaml_mapping, map_list, map_scalar, map_u32, read_text,
    read_yaml_mapping, sanitize_file_name, set_map_list, set_map_scalar, set_map_u32,
    split_frontmatter, strip_bom, unique_file_path, write_frontmatter, write_text_atomic,
    write_yaml_mapping, frontmatter_mapping,
};
use crate::library::PROJECTS_DIR;

pub const PROJECT_META_FILE: &str = "项目.yaml";
pub const CONCEPT_DIR: &str = "构思";
pub const TEXT_DIR: &str = "正文";
pub const CIRCLE_FILE: &str = "类型圈.md";
pub const ARRANGEMENT_FILE: &str = "排布.yaml";

/// 矛盾提为单元时的正文骨架：桥段清单是自由文本（spec「单元」节），
/// 只给形状不给内容。
const UNIT_TEMPLATE: &str = "## 桥段安排\n\n1. \n";

// --- 项目扫描与新建 ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    /// 项目文件夹路径，即项目身份。
    pub dir: PathBuf,
    /// 文件夹名（应用新建时带《》，手建可不带）。
    pub name: String,
    /// 书名：项目.yaml 的「书名」，缺省＝文件夹名去掉《》。
    pub title: String,
    /// 正文/ 下的章节文件数（一章一文件，章序在文件名）。
    pub chapter_count: u32,
    pub word_count: u64,
    pub unit_count: u32,
    pub contradiction_count: u32,
    pub character_count: u32,
    /// 世界观/开头等构思笔记数。
    pub worldview_count: u32,
    pub opening_count: u32,
    /// 伏笔条数（伏笔.yaml；损坏降级为 0，不拖垮扫描）。
    pub foreshadow_count: u32,
    /// 期待线条数按类别拆（三线.yaml；损坏降级为 0，不拖垮扫描）。
    /// 「期待感」「目标」两页签各自的徽标；手写的未知类别并入期待（缺省读作期待）。
    pub expectation_expect_count: u32,
    pub expectation_goal_count: u32,
    /// 封面文件（约定文件名 附件/封面.png|jpg|webp，现查现识别，零 yaml 键）；
    /// 无封面为 None，前端以书名首字占位。
    pub cover: Option<PathBuf>,
    /// 封面目录（「设封面」的拷贝落点）＝项目内 附件/（懒生成，放封面即建）。
    pub cover_dir: PathBuf,
}

/// 扫「项目/」下的直接子文件夹；目录不存在视为还没有项目（首次使用）。
pub fn scan_projects(root: &Path) -> Result<Vec<ProjectEntry>, String> {
    if !root.is_dir() {
        return Err(format!("不是有效的文件夹：{}", root.display()));
    }
    let dir = root.join(PROJECTS_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<ProjectEntry> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("无法读取文件夹 {}：{e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !is_hidden(&path) {
            out.push(project_entry(&path));
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(out)
}

/// 新建项目：只建「项目/《书名》/」——目录随写入懒生成，缺目录＝还没做
/// 那一步。重名报错，不自动续号：书是唯一的，同名是误操作。
pub fn create_project(root: &Path, title: &str) -> Result<ProjectEntry, String> {
    if !root.is_dir() {
        return Err(format!("不是有效的文件夹：{}", root.display()));
    }
    let title = title.trim().trim_start_matches('《').trim_end_matches('》').trim();
    let name =
        sanitize_file_name(title).map_err(|_| "书名不能为空（或只剩符号）".to_string())?;
    let dir = root.join(PROJECTS_DIR).join(format!("《{name}》"));
    if dir.exists() {
        return Err(format!("已存在同名项目「{name}」"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    Ok(project_entry(&dir))
}

fn project_entry(dir: &Path) -> ProjectEntry {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // 项目.yaml 损坏时列表降级为缺省，不拖垮扫描；打开项目时会显式告警。
    let meta = read_project_meta(dir).unwrap_or_default();
    let (chapter_count, word_count) = text_stats(&dir.join(TEXT_DIR));
    let cover_dir = dir.join("附件");
    // 伏笔.yaml 读不了＝0 条（与项目.yaml 同款降级，打开看板时再显式报错）。
    let foreshadow_count = crate::foreshadow::read_foreshadows(dir)
        .map(|list| list.len() as u32)
        .unwrap_or(0);
    // 三线.yaml 同款降级；计数按类别拆（工单 #36 期待感/目标两页签的徽标）。
    let expectations = crate::expectation::read_expectations(dir).unwrap_or_default();
    ProjectEntry {
        dir: dir.to_path_buf(),
        title: meta.title.unwrap_or_else(|| strip_book_marks(&name)),
        name,
        chapter_count,
        word_count,
        unit_count: count_md(&notes_dir(dir, NoteKind::Unit)),
        contradiction_count: count_md(&notes_dir(dir, NoteKind::Contradiction)),
        character_count: count_md(&notes_dir(dir, NoteKind::Character)),
        worldview_count: count_md(&notes_dir(dir, NoteKind::Worldview)),
        opening_count: count_md(&notes_dir(dir, NoteKind::Opening)),
        foreshadow_count,
        expectation_expect_count: expectations
            .iter()
            .filter(|e| e.kind != crate::expectation::KIND_GOAL)
            .count() as u32,
        expectation_goal_count: expectations
            .iter()
            .filter(|e| e.kind == crate::expectation::KIND_GOAL)
            .count() as u32,
        cover: crate::cover::find_cover(&cover_dir),
        cover_dir,
    }
}

/// 文件夹名去《》：书名缺省口径（项目列表与 AI 命令材料共用）。
pub(crate) fn strip_book_marks(name: &str) -> String {
    name.trim_start_matches('《').trim_end_matches('》').to_string()
}

fn count_md(dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            let p = e.path();
            !is_hidden(&p) && p.is_file() && has_md_extension(&p)
        })
        .count() as u32
}

/// 正文目录的字数统计：计费口径（与书库、书写章节同一函数）；章数＝文件数
/// （一章一文件，章序在文件名，不数标题）。
fn text_stats(dir: &Path) -> (u32, u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut chapters = 0u32;
    let mut words = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) || !path.is_file() || !has_md_extension(&path) {
            continue;
        }
        chapters += 1;
        if let Ok(bytes) = fs::read(&path) {
            let raw = String::from_utf8_lossy(&bytes);
            words += crate::book_file::billed_word_count(raw.as_ref());
        }
    }
    (chapters, words)
}

// --- 项目.yaml（清单，懒生成） ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotLine {
    /// 线名，排布视图的行定义。
    pub name: String,
    /// 颜色（可选），未定义的线由前端按首见顺序补色。
    pub color: Option<String>,
    /// 用户在 Obsidian 里手补的行内字段，原样保留。
    #[serde(flatten, default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub title: Option<String>,
    /// 章前缀模板；缺省＝Rust 侧单一事实源「第{n}章」。
    pub chapter_prefix: Option<String>,
    pub plot_lines: Vec<PlotLine>,
    pub maps: Vec<String>,
}

pub fn meta_path(project: &Path) -> PathBuf {
    project.join(PROJECT_META_FILE)
}

/// 读项目.yaml；文件不存在返回全缺省（懒生成）。解析失败报错，
/// 由前端亮出来，避免保存时静默整文件覆盖。
pub fn read_project_meta(project: &Path) -> Result<ProjectMeta, String> {
    let path = meta_path(project);
    let map = read_yaml_mapping(&path)?;
    Ok(ProjectMeta {
        title: map_scalar(&map, "书名"),
        chapter_prefix: map_scalar(&map, "章前缀"),
        plot_lines: plot_lines_from(&map, &path)?,
        maps: maps_from(&map, &path)?,
    })
}

pub fn write_project_meta(project: &Path, meta: &ProjectMeta) -> Result<(), String> {
    let path = meta_path(project);
    let mut map = lossy_yaml_mapping(&path);
    set_map_scalar(&mut map, "书名", meta.title.as_deref());
    set_map_scalar(&mut map, "章前缀", meta.chapter_prefix.as_deref());
    set_plot_lines(&mut map, &meta.plot_lines);
    set_map_list(&mut map, "地图", &meta.maps);
    fs::create_dir_all(project).map_err(|e| format!("无法创建文件夹 {}：{e}", project.display()))?;
    write_yaml_mapping(&path, map)
}

fn plot_lines_from(map: &Mapping, path: &Path) -> Result<Vec<PlotLine>, String> {
    let Some(value) = map.get(Value::String("情节线".to_string())) else {
        return Ok(Vec::new());
    };
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 的「情节线」应为列表", path.display()));
    };
    let mut out = Vec::with_capacity(seq.len());
    for (i, item) in seq.iter().enumerate() {
        let Value::Mapping(item_map) = item else {
            return Err(format!(
                "{} 的「情节线」第 {} 项应为映射（名/色）",
                path.display(),
                i + 1
            ));
        };
        let mut extra = item_map.clone();
        let name = take_scalar(&mut extra, "名").ok_or_else(|| {
            format!("{} 的「情节线」第 {} 项缺「名」", path.display(), i + 1)
        })?;
        out.push(PlotLine {
            name,
            color: take_scalar(&mut extra, "色"),
            extra,
        });
    }
    Ok(out)
}

fn set_plot_lines(map: &mut Mapping, lines: &[PlotLine]) {
    let key = Value::String("情节线".to_string());
    if lines.is_empty() {
        map.remove(&key);
        return;
    }
    let seq: Vec<Value> = lines
        .iter()
        .map(|line| {
            let mut out = Mapping::new();
            out.insert(
                Value::String("名".to_string()),
                Value::String(line.name.trim().to_string()),
            );
            if let Some(color) = trimmed(line.color.as_deref()) {
                out.insert(Value::String("色".to_string()), Value::String(color.to_string()));
            }
            for (k, v) in &line.extra {
                if let Value::String(ks) = k {
                    if ks == "名" || ks == "色" {
                        continue;
                    }
                }
                out.insert(k.clone(), v.clone());
            }
            Value::Mapping(out)
        })
        .collect();
    map.insert(key, Value::Sequence(seq));
}

fn maps_from(map: &Mapping, path: &Path) -> Result<Vec<String>, String> {
    let Some(value) = map.get(Value::String("地图".to_string())) else {
        return Ok(Vec::new());
    };
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 的「地图」应为字符串列表", path.display()));
    };
    seq.iter()
        .map(|v| {
            v.as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("{} 的「地图」里有非字符串", path.display()))
        })
        .collect()
}

/// 取标量键并从映射里摘除；非标量或空值不摘（未知键保留优先）。
fn take_scalar(map: &mut Mapping, key: &str) -> Option<String> {
    let k = Value::String(key.to_string());
    let value = map.get(&k).cloned()?;
    let s = crate::book_file::scalar_to_string(&value)?.trim().to_string();
    if s.is_empty() {
        map.remove(&k);
        return None;
    }
    map.remove(&k);
    Some(s)
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn file_stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// --- 构思笔记：矛盾 / 单元 / 人物 / 世界观 / 开头 ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    Contradiction,
    Unit,
    Character,
    Worldview,
    Opening,
}

impl Serialize for NoteKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> Deserialize<'de> for NoteKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl de::Visitor<'_> for Visitor {
            type Value = NoteKind;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("构思笔记类别（如「矛盾」）")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<NoteKind, E> {
                NoteKind::from_name(v).ok_or_else(|| E::custom(format!("未知构思笔记类别「{v}」")))
            }
        }
        deserializer.deserialize_str(Visitor)
    }
}

impl NoteKind {
    pub const ALL: [NoteKind; 5] = [
        NoteKind::Contradiction,
        NoteKind::Unit,
        NoteKind::Character,
        NoteKind::Worldview,
        NoteKind::Opening,
    ];

    /// IPC 值与目录名同为中文名（serde 与 notes_dir 共用一份真相）。
    pub fn name(self) -> &'static str {
        match self {
            NoteKind::Contradiction => "矛盾",
            NoteKind::Unit => "单元",
            NoteKind::Character => "人物",
            NoteKind::Worldview => "世界观",
            NoteKind::Opening => "开头",
        }
    }

    pub fn from_name(name: &str) -> Option<NoteKind> {
        NoteKind::ALL.into_iter().find(|k| k.name() == name)
    }
}

/// 人物的可选结构摘要；小传、外貌、说话方式与人物弧仍在自由正文。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterProfile {
    pub image: Option<String>,
    pub identity: Option<String>,
    pub age: Option<String>,
    pub gender: Option<String>,
    pub traits: Vec<String>,
    pub goal: Option<String>,
    pub ability: Option<String>,
    pub weakness: Option<String>,
    pub secret: Option<String>,
}

impl CharacterProfile {
    fn read(map: &Mapping) -> Self {
        Self {
            image: map_scalar(map, "形象图"), identity: map_scalar(map, "一句话身份"),
            age: map_scalar(map, "年龄或年龄感"), gender: map_scalar(map, "性别"),
            traits: map_list(map, "性格关键词"), goal: map_scalar(map, "当前目标"),
            ability: map_scalar(map, "能力"), weakness: map_scalar(map, "弱点或代价"),
            secret: map_scalar(map, "个人秘密"),
        }
    }

    fn apply(&self, map: &mut Mapping) {
        for (key, value) in [
            ("形象图", &self.image), ("一句话身份", &self.identity),
            ("年龄或年龄感", &self.age), ("性别", &self.gender),
            ("当前目标", &self.goal), ("能力", &self.ability),
            ("弱点或代价", &self.weakness), ("个人秘密", &self.secret),
        ] { set_map_scalar(map, key, value.as_deref()); }
        set_map_list(map, "性格关键词", &self.traits);
    }
}

/// 笔记保存入参：五类共用一张宽表，落盘时只写本类别的键
/// （矛盾＝一句话核心/类型/来源/关联/状态；单元＝核心矛盾/类型/情绪目标/单元区间；
/// 人物＝结构摘要/别名（分组只读兼容）；世界观＝类别；开头＝状态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDraft {
    /// 编辑框载入时的内容版本；旧命令入参兼容缺省。
    #[serde(default)]
    pub fingerprint: Option<String>,
    pub kind: NoteKind,
    /// 标题＝文件名（矛盾/单元名、人名、词条名、版本名）。
    pub name: String,
    pub core: Option<String>,
    pub types: Vec<String>,
    pub source: Option<String>,
    pub links: Vec<String>,
    pub status: Option<String>,
    pub group: Option<String>,
    pub aliases: Vec<String>,
    #[serde(default)]
    pub character: CharacterProfile,
    pub category: Option<String>,
    /// 单元专用的整体情绪承诺；与桥段的局部情绪曲线并列，不相互推导。
    pub emotion_goal: Option<String>,
    /// 单元专用的单元区间（起章/止章；工单 #5 联动侧栏按它反查「本章属于哪个单元」）。
    pub start_chapter: Option<u32>,
    pub end_chapter: Option<u32>,
    pub body: String,
}

impl NoteDraft {
    pub fn new(kind: NoteKind, name: impl Into<String>) -> NoteDraft {
        NoteDraft {
            fingerprint: None,
            kind,
            name: name.into(),
            core: None,
            types: Vec::new(),
            source: None,
            links: Vec::new(),
            status: None,
            group: None,
            aliases: Vec::new(),
            character: CharacterProfile::default(),
            category: None,
            emotion_goal: None,
            start_chapter: None,
            end_chapter: None,
            body: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub fingerprint: String,
    pub path: PathBuf,
    pub kind: NoteKind,
    pub name: String,
    pub core: Option<String>,
    pub types: Vec<String>,
    pub source: Option<String>,
    pub links: Vec<String>,
    pub status: Option<String>,
    pub group: Option<String>,
    pub aliases: Vec<String>,
    pub character: CharacterProfile,
    pub category: Option<String>,
    pub emotion_goal: Option<String>,
    pub start_chapter: Option<u32>,
    pub end_chapter: Option<u32>,
    pub body: String,
    /// 待打磨中（工单 #64）：frontmatter 的 `待打磨: true`；随笔记文件保存。
    pub pending: bool,
}

pub fn notes_dir(project: &Path, kind: NoteKind) -> PathBuf {
    project.join(CONCEPT_DIR).join(kind.name())
}

pub fn scan_notes(project: &Path, kind: NoteKind) -> Result<Vec<NoteEntry>, String> {
    let dir = notes_dir(project, kind);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| !is_hidden(p) && p.is_file() && has_md_extension(p))
        .collect();
    paths.sort();
    Ok(paths.iter().map(|p| read_note(p, kind)).collect())
}

/// 构思笔记的字段 ↔ frontmatter 键：读、写共用一张表，避免两处漂移
/// （「矛盾」的核心字段是「一句话核心」，「单元」的是「核心矛盾」）。
#[derive(Clone, Copy)]
enum NoteField {
    Core(&'static str),
    Types,
    Source,
    Links,
    Status,
    Character,
    Aliases,
    Category,
    EmotionGoal,
    /// 单元的章序区间（起章/止章，两个可选整数）。
    ChapterRange,
}

fn note_fields(kind: NoteKind) -> &'static [NoteField] {
    use NoteField::*;
    match kind {
        NoteKind::Contradiction => &[Core("一句话核心"), Types, Source, Links, Status],
        NoteKind::Unit => &[Core("核心矛盾"), Types, EmotionGoal, ChapterRange],
        NoteKind::Character => &[Character, Aliases],
        NoteKind::Worldview => &[Category],
        NoteKind::Opening => &[Status],
    }
}

/// 读一篇构思笔记；文件读不到/损坏时降级为空内容（列表不因单文件拖垮）。
fn read_note(path: &Path, kind: NoteKind) -> NoteEntry {
    let mut entry = NoteEntry {
        fingerprint: String::new(),
        path: path.to_path_buf(),
        kind,
        name: file_stem_of(path),
        core: None,
        types: Vec::new(),
        source: None,
        links: Vec::new(),
        status: None,
        group: None,
        aliases: Vec::new(),
        character: CharacterProfile::default(),
        category: None,
        emotion_goal: None,
        start_chapter: None,
        end_chapter: None,
        body: String::new(),
        pending: false,
    };
    let Ok(raw) = read_text(path) else {
        return entry;
    };
    entry.fingerprint = content_fingerprint(raw.as_bytes()).to_string();
    let raw = strip_bom(&raw);
    let Some((yaml_text, body)) = split_frontmatter(raw) else {
        entry.body = raw.to_string();
        return entry;
    };
    if yaml_text.trim().is_empty() {
        entry.body = body;
        return entry;
    }
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(&yaml_text) else {
        // frontmatter 损坏：整文件原样入正文，保存时内容不丢。
        entry.body = raw.to_string();
        return entry;
    };
    for field in note_fields(kind) {
        match field {
            NoteField::Core(key) => entry.core = map_scalar(&map, key),
            NoteField::Types => entry.types = map_list(&map, "类型"),
            NoteField::Source => entry.source = map_scalar(&map, "来源"),
            NoteField::Links => entry.links = map_list(&map, "关联"),
            NoteField::Status => entry.status = map_scalar(&map, "状态"),
            NoteField::Character => {
                entry.group = map_scalar(&map, "分组"); // 只读兼容，不再新增或回写分组。
                entry.character = CharacterProfile::read(&map);
            }
            NoteField::Aliases => entry.aliases = map_list(&map, "别名"),
            NoteField::Category => entry.category = map_scalar(&map, "类别"),
            NoteField::EmotionGoal => entry.emotion_goal = map_scalar(&map, "情绪目标"),
            NoteField::ChapterRange => {
                entry.start_chapter = map_u32(&map, "起章");
                entry.end_chapter = map_u32(&map, "止章");
            }
        }
    }
    entry.pending = crate::book_file::is_pending(&map);
    entry.body = body;
    entry
}

/// 保存笔记：新建或编辑（改名＝文件改名）。frontmatter 以现有文件为底
/// 合并，手补的未知键不丢；同名续号，不覆盖他人。
pub fn save_note(
    project: &Path,
    draft: &NoteDraft,
    prev_path: Option<&Path>,
) -> Result<NoteEntry, String> {
    let name = sanitize_file_name(&draft.name)?;
    let dir = notes_dir(project, draft.kind);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    let path = unique_file_path(&dir, &format!("{name}.md"), prev_path);

    let base = prev_path.filter(|p| *p != path).unwrap_or(&path);
    if let Some(expected) = &draft.fingerprint {
        let current = read_text(base)?;
        if &content_fingerprint(current.as_bytes()).to_string() != expected {
            return Err("笔记在载入后已改变，未覆盖外部修改；请重新打开核对".into());
        }
    }
    let mut map = frontmatter_mapping(base).unwrap_or_default();
    apply_draft(&mut map, draft);

    if let Some(prev) = prev_path {
        if prev != path {
            fs::rename(prev, &path)
                .map_err(|e| format!("无法移动笔记到 {}：{e}", path.display()))?;
        }
    }
    write_frontmatter(&path, map, &draft.body)?;
    Ok(read_note(&path, draft.kind))
}

fn apply_draft(map: &mut Mapping, draft: &NoteDraft) {
    for field in note_fields(draft.kind) {
        match field {
            NoteField::Core(key) => set_map_scalar(map, key, draft.core.as_deref()),
            NoteField::Types => set_map_list(map, "类型", &draft.types),
            NoteField::Source => set_map_scalar(map, "来源", draft.source.as_deref()),
            NoteField::Links => set_map_list(map, "关联", &draft.links),
            NoteField::Status => set_map_scalar(map, "状态", draft.status.as_deref()),
            NoteField::Character => draft.character.apply(map),
            NoteField::Aliases => set_map_list(map, "别名", &draft.aliases),
            NoteField::Category => set_map_scalar(map, "类别", draft.category.as_deref()),
            NoteField::EmotionGoal => {
                set_map_scalar(map, "情绪目标", draft.emotion_goal.as_deref())
            }
            NoteField::ChapterRange => {
                set_map_u32(map, "起章", draft.start_chapter);
                set_map_u32(map, "止章", draft.end_chapter);
            }
        }
    }
}

pub fn delete_note(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("无法删除笔记 {}：{e}", path.display()))
}

/// 矛盾提为单元（spec「矛盾池」节）：建 `构思/单元/<名>.md`（核心矛盾/
/// 类型预填、正文给骨架），矛盾状态改「已成单元」、留档不删。
/// 已有同名单元时报错，让用户先裁决。
pub fn promote_contradiction(contradiction_path: &Path) -> Result<NoteEntry, String> {
    let parent_name = contradiction_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str());
    let concept_name = contradiction_path
        .parent()
        .and_then(Path::parent)
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str());
    if parent_name != Some(NoteKind::Contradiction.name()) || concept_name != Some(CONCEPT_DIR) {
        return Err(format!("{} 不在 构思/矛盾/ 下", contradiction_path.display()));
    }
    let project = contradiction_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| format!("{} 不在 构思/矛盾/ 下", contradiction_path.display()))?;
    let source = read_note(contradiction_path, NoteKind::Contradiction);
    let unit_path = notes_dir(project, NoteKind::Unit).join(format!("{}.md", source.name));
    if unit_path.exists() {
        return Err(format!(
            "已存在同名单元「{}」，先改名或删掉旧单元再提",
            source.name
        ));
    }

    let created = save_unit_draft(
        project,
        source.name.clone(),
        source.core.clone(),
        source.types.clone(),
    )?;
    let mut updated = NoteDraft::new(NoteKind::Contradiction, source.name.clone());
    updated.core = source.core.clone();
    updated.types = source.types.clone();
    updated.source = source.source.clone();
    updated.links = source.links.clone();
    updated.status = Some("已成单元".to_string());
    updated.body = source.body.clone();
    save_note(project, &updated, Some(contradiction_path))?;
    Ok(created)
}

/// 故事卡转生单元草稿（工单 #9，docs/spec/故事卡转生.md）：卡片标题→单元名、
/// 一句话核心→核心矛盾、标签→类型，正文给与「矛盾提为单元」同一份骨架；
/// 卡片「关联」追加「《书名》/单元名」单向记去向（不设硬引用、无同步）。
/// 先记去向再建单元：建单元失败只留一条失效软链，重试即自愈（同名检查在
/// 写入之前，重试不会被同名挡住）；反过来会在失败时留下无人记账的单元。
pub fn transmute_story_card(
    root: &Path,
    card_path: &Path,
    project: &Path,
) -> Result<NoteEntry, String> {
    let card = crate::inspiration::read_card(card_path);
    if card.category != crate::inspiration::CardCategory::Story {
        return Err(format!(
            "「{}」是{}，只有故事卡能转生为单元",
            card.title,
            card.category.name()
        ));
    }
    let title = transmute_into(project)?;
    let name = crate::inspiration::sanitize_title(&card.title)?;
    let unit_path = notes_dir(project, NoteKind::Unit).join(format!("{name}.md"));
    if unit_path.exists() {
        return Err(format!(
            "项目里已有同名单元「{name}」，先改名或删掉旧单元再转生"
        ));
    }
    crate::inspiration::append_link(root, &card, &format!("《{title}》/{name}"))?;

    save_unit_draft(project, name, card.core.clone(), card.tags.clone())
}

/// 角色卡转生书内人物（工单 #8，docs/spec/人物关系画布.md §五）：卡片标题→
/// 人名、卡片正文→小传正文，分组/别名留空——**转生不生关系**（连线是画布
/// 上的事，转生只管把人带进屋）；标签/来源/关联留在卡片，卡片「关联」追加
/// 「《书名》/人名」单向记去向（转生即断链、无同步）。写入次序与故事卡转生
/// 同款：先记去向、再建人物。
pub fn transmute_character_card(
    root: &Path,
    card_path: &Path,
    project: &Path,
) -> Result<NoteEntry, String> {
    let card = crate::inspiration::read_card(card_path);
    if card.category != crate::inspiration::CardCategory::Character {
        return Err(format!(
            "「{}」是{}，只有角色卡能转生为人物",
            card.title,
            card.category.name()
        ));
    }
    let title = transmute_into(project)?;
    let name = crate::inspiration::sanitize_title(&card.title)?;
    let person_path = notes_dir(project, NoteKind::Character).join(format!("{name}.md"));
    if person_path.exists() {
        return Err(format!(
            "项目里已有同名人物「{name}」，先改名或删掉旧人物再转生"
        ));
    }
    crate::inspiration::append_link(root, &card, &format!("《{title}》/{name}"))?;

    let mut draft = NoteDraft::new(NoteKind::Character, name);
    draft.body = card.body.clone();
    save_note(project, &draft, None)
}

/// 转生落点校验，并给出卡片「关联」里要记的去向书名（两条转生路径共用）：
/// 项目必须住 `项目/` 下；书名缺省回退到文件夹名去《》——去向只是备注，
/// 不因元数据坏掉挡住转生。
fn transmute_into(project: &Path) -> Result<String, String> {
    if !project.is_dir() {
        return Err(format!("不是有效的项目文件夹：{}", project.display()));
    }
    let parent_name = project
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str());
    if parent_name != Some(PROJECTS_DIR) {
        return Err(format!("{} 不在 项目/ 下", project.display()));
    }
    Ok(book_title_of(project))
}

/// 书名：`项目.yaml` 的「书名」，缺省＝文件夹名去《》。
fn book_title_of(project: &Path) -> String {
    read_project_meta(project)
        .ok()
        .and_then(|m| m.title)
        .unwrap_or_else(|| {
            project
                .file_name()
                .map(|n| strip_book_marks(&n.to_string_lossy()))
                .unwrap_or_default()
        })
}

/// 建单元草稿：核心矛盾/类型预填，正文给同一份骨架——「矛盾提为单元」与
/// 「故事卡转生」两条路径共用，产物同形（spec：单一事实源）。
fn save_unit_draft(
    project: &Path,
    name: String,
    core: Option<String>,
    types: Vec<String>,
) -> Result<NoteEntry, String> {
    let mut unit = NoteDraft::new(NoteKind::Unit, name);
    unit.core = core;
    unit.types = types;
    unit.body = UNIT_TEMPLATE.to_string();
    save_note(project, &unit, None)
}

// --- 类型圈.md ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Circle {
    /// frontmatter 的类型列表（机器可读的那份；挂词表提示）。
    pub types: Vec<String>,
    pub body: String,
}

pub fn circle_path(project: &Path) -> PathBuf {
    project.join(CONCEPT_DIR).join(CIRCLE_FILE)
}

/// 读类型圈；文件不存在返回空圈（懒生成）。frontmatter 损坏时整文件
/// 入正文（内容不丢，界面一眼可见），保存即重建。
pub fn read_circle(project: &Path) -> Result<Circle, String> {
    let path = circle_path(project);
    if !path.is_file() {
        return Ok(Circle::default());
    }
    let raw = read_text(&path)?;
    let raw = strip_bom(&raw);
    let Some((yaml_text, body)) = split_frontmatter(raw) else {
        return Ok(Circle {
            types: Vec::new(),
            body: raw.to_string(),
        });
    };
    if yaml_text.trim().is_empty() {
        return Ok(Circle {
            types: Vec::new(),
            body,
        });
    }
    match serde_yaml::from_str::<Value>(&yaml_text) {
        Ok(Value::Mapping(map)) => Ok(Circle {
            types: map_list(&map, "类型"),
            body,
        }),
        _ => Ok(Circle {
            types: Vec::new(),
            body: raw.to_string(),
        }),
    }
}

pub fn save_circle(project: &Path, circle: &Circle) -> Result<(), String> {
    let path = circle_path(project);
    let mut map = frontmatter_mapping(&path).unwrap_or_default();
    set_map_list(&mut map, "类型", &circle.types);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }
    write_frontmatter(&path, map, &circle.body)
}

// --- 排布.yaml（次序即有序列表） ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementItem {
    /// 单元名，按名引用 `构思/单元/<名>.md`（失效只提示，不自动改）。
    pub unit: String,
    pub line: Option<String>,
    pub map: Option<String>,
    /// 升级｜战斗（2:1 体检用，只提示不校验）。
    pub upgrade_battle: Option<String>,
    /// 紧绷｜舒缓（张弛交替用，只提示不校验）。
    pub pace: Option<String>,
    /// 手补的行内未知键，原样保留。
    #[serde(flatten, default)]
    pub extra: Mapping,
}

pub fn arrangement_path(project: &Path) -> PathBuf {
    project.join(CONCEPT_DIR).join(ARRANGEMENT_FILE)
}

pub fn read_arrangement(project: &Path) -> Result<Vec<ArrangementItem>, String> {
    let path = arrangement_path(project);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = read_text(&path)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 顶层应为列表（单元次序）", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| item_from_value(item, &path, i + 1))
        .collect()
}

fn item_from_value(value: &Value, path: &Path, index: usize) -> Result<ArrangementItem, String> {
    let Value::Mapping(map) = value else {
        return Err(format!(
            "{} 第 {index} 项应为映射（单元/线/地图/升级战斗/节奏）",
            path.display()
        ));
    };
    let mut extra = map.clone();
    let unit = take_scalar(&mut extra, "单元")
        .ok_or_else(|| format!("{} 第 {index} 项缺「单元」", path.display()))?;
    Ok(ArrangementItem {
        unit,
        line: take_scalar(&mut extra, "线"),
        map: take_scalar(&mut extra, "地图"),
        upgrade_battle: take_scalar(&mut extra, "升级战斗"),
        pace: take_scalar(&mut extra, "节奏"),
        extra,
    })
}

pub fn save_arrangement(project: &Path, items: &[ArrangementItem]) -> Result<(), String> {
    for (i, item) in items.iter().enumerate() {
        if item.unit.trim().is_empty() {
            return Err(format!("排布第 {} 项缺「单元」", i + 1));
        }
    }
    let path = arrangement_path(project);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }

    // 读-合-写（ADR 0004）：以保存瞬间盘上的列表为底，按单元名配对，
    // 把手补的行内未知键带回（盘上的值更新，覆盖应用载入时的旧值）；
    // 盘上已被删掉的项不复活——应用列表是次序的唯一事实源。
    let disk = read_arrangement(project).unwrap_or_default();
    let mut used = vec![false; disk.len()];
    let mut merged: Vec<ArrangementItem> = Vec::with_capacity(items.len());
    for item in items {
        let mut item = item.clone();
        let matched = disk
            .iter()
            .enumerate()
            .find(|(i, d)| !used[*i] && d.unit == item.unit)
            .map(|(i, _)| i);
        if let Some(i) = matched {
            used[i] = true;
            for (k, v) in &disk[i].extra {
                item.extra.insert(k.clone(), v.clone());
            }
        }
        merged.push(item);
    }

    let seq: Vec<Value> = merged.iter().map(item_to_value).collect();
    let text = serde_yaml::to_string(&Value::Sequence(seq))
        .map_err(|e| format!("无法生成 yaml：{e}"))?;
    write_text_atomic(&path, &text)
}

fn item_to_value(item: &ArrangementItem) -> Value {
    // 未知键先铺底（含 take_scalar 摘不掉的非标量已知键，原样保留）；
    // 应用设了值的已知键再覆盖上去。
    let mut map = item.extra.clone();
    map.insert(
        Value::String("单元".to_string()),
        Value::String(item.unit.trim().to_string()),
    );
    let fields = [
        ("线", &item.line),
        ("地图", &item.map),
        ("升级战斗", &item.upgrade_battle),
        ("节奏", &item.pace),
    ];
    for (key, value) in fields {
        if let Some(s) = trimmed(value.as_deref()) {
            map.insert(Value::String(key.to_string()), Value::String(s.to_string()));
        }
    }
    Value::Mapping(map)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCount {
    pub map: String,
    pub count: u32,
}

/// 排布体检（派生视图，只提示不拦截）：升级:战斗比例、连续同节奏、
/// 按名引用失效、未进排布的单元、地图分布。地图定义兼容旧项目清单、
/// 世界观「地理」词条与新版一等地图实体。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementCheck {
    pub ratio_hint: String,
    pub pace_hints: Vec<String>,
    pub ref_hints: Vec<String>,
    pub missing_units: Vec<String>,
    pub unarranged_units: Vec<String>,
    pub map_counts: Vec<MapCount>,
}

pub fn check_arrangement(
    items: &[ArrangementItem],
    unit_names: &[String],
    line_names: &[String],
    map_names: &[String],
) -> ArrangementCheck {
    let mut upgrade = 0u32;
    let mut battle = 0u32;
    for item in items {
        match trimmed(item.upgrade_battle.as_deref()) {
            Some("升级") => upgrade += 1,
            Some("战斗") => battle += 1,
            _ => {}
        }
    }
    let ratio_hint = if upgrade == 0 && battle == 0 {
        "还没标「升级战斗」——体检按 2:1 的口径看它".to_string()
    } else if battle == 0 {
        format!("升级 {upgrade} : 战斗 0，一场战斗都没有（2:1 体检）")
    } else {
        // 体检口径 2:1：战斗数落在升级数一半的 ±30% 内算接近。
        let ideal = f64::from(upgrade) / 2.0;
        let verdict = if f64::from(battle) < ideal * 0.7 {
            "战斗偏少（2:1 体检）"
        } else if f64::from(battle) > ideal * 1.3 {
            "战斗偏多（2:1 体检）"
        } else {
            "接近 2:1（体检通过）"
        };
        format!("升级 {upgrade} : 战斗 {battle}，{verdict}")
    };

    // 连续同节奏：≥3 项连排才提醒（两项连着是正常起伏）。
    let mut pace_hints = Vec::new();
    let mut i = 0;
    while i < items.len() {
        let Some(pace) = trimmed(items[i].pace.as_deref()) else {
            i += 1;
            continue;
        };
        let mut j = i + 1;
        while j < items.len() && trimmed(items[j].pace.as_deref()) == Some(pace) {
            j += 1;
        }
        if j - i >= 3 {
            pace_hints.push(format!(
                "第 {}~{} 项连续「{pace}」（共 {} 项）",
                i + 1,
                j,
                j - i
            ));
        }
        i = j;
    }

    let mut ref_hints: Vec<String> = Vec::new();
    for item in items {
        if let Some(line) = trimmed(item.line.as_deref()) {
            if !line_names.iter().any(|n| n == line) {
                let hint = format!("线「{line}」未在项目.yaml 的「情节线」里定义");
                if !ref_hints.contains(&hint) {
                    ref_hints.push(hint);
                }
            }
        }
        if let Some(map) = trimmed(item.map.as_deref()) {
            if !map_names.iter().any(|n| n == map) {
                let hint = format!("地图「{map}」未在项目.yaml 的「地图」或「地理」词条里");
                if !ref_hints.contains(&hint) {
                    ref_hints.push(hint);
                }
            }
        }
    }

    let mut missing_units: Vec<String> = Vec::new();
    for item in items {
        let unit = item.unit.trim();
        if !unit.is_empty()
            && !unit_names.iter().any(|n| n == unit)
            && !missing_units.iter().any(|n| n == unit)
        {
            missing_units.push(unit.to_string());
        }
    }
    let unarranged_units: Vec<String> = unit_names
        .iter()
        .filter(|n| !items.iter().any(|i| i.unit.trim() == n.as_str()))
        .cloned()
        .collect();

    let mut map_counts: Vec<MapCount> = Vec::new();
    for item in items {
        if let Some(map) = trimmed(item.map.as_deref()) {
            match map_counts.iter_mut().find(|c| c.map == map) {
                Some(c) => c.count += 1,
                None => map_counts.push(MapCount {
                    map: map.to_string(),
                    count: 1,
                }),
            }
        }
    }
    map_counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.map.cmp(&b.map)));

    ArrangementCheck {
        ratio_hint,
        pace_hints,
        ref_hints,
        missing_units,
        unarranged_units,
        map_counts,
    }
}

/// 体检命令的落地：从盘上读定义（情节线/地图/地理词条/单元名），
/// 对传入的当前列表现算——排布还没保存也能体检。
pub fn check_project_arrangement(
    project: &Path,
    items: &[ArrangementItem],
) -> Result<ArrangementCheck, String> {
    let meta = read_project_meta(project)?;
    let unit_names: Vec<String> = scan_notes(project, NoteKind::Unit)?
        .into_iter()
        .map(|n| n.name)
        .collect();
    let line_names: Vec<String> = meta.plot_lines.iter().map(|l| l.name.clone()).collect();
    let mut map_names = meta.maps;
    for note in scan_notes(project, NoteKind::Worldview).unwrap_or_default() {
        if note.category.as_deref() == Some("地理") && !map_names.contains(&note.name) {
            map_names.push(note.name);
        }
    }
    for map in crate::map::map_workspace(project)
        .map(|workspace| workspace.maps)
        .unwrap_or_default()
    {
        if !map_names.contains(&map.name) {
            map_names.push(map.name);
        }
    }
    Ok(check_arrangement(items, &unit_names, &line_names, &map_names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn 力量体系提示删改留空后可重开且旧世界观未知字段保留() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        let legacy = project.join("构思/世界观/旧修炼体系.md");
        write(&legacy, "---\n类别: 力量体系\n自定义境界: [听潮, 观海]\n---\n原有设定，不要求等级。\n");
        let original = fs::read(&legacy).unwrap();
        let old = scan_notes(project, NoteKind::Worldview).unwrap();
        assert_eq!(old[0].body.trim(), "原有设定，不要求等级。");
        assert_eq!(fs::read(&legacy).unwrap(), original);

        let mut draft = NoteDraft::new(NoteKind::Worldview, "旧修炼体系");
        draft.body = "## 我改写的提示\n\n力量来自承诺，无固定等级。".into();
        let saved = save_note(project, &draft, Some(&legacy)).unwrap();
        let reopened = scan_notes(project, NoteKind::Worldview).unwrap();
        assert_eq!(reopened[0], saved);
        assert_eq!(reopened[0].category, None);
        assert_eq!(reopened[0].body, draft.body);
        let raw = fs::read_to_string(&legacy).unwrap();
        assert!(raw.contains("自定义境界"));
        assert!(raw.contains("听潮"));

        draft.body.clear();
        save_note(project, &draft, Some(&legacy)).unwrap();
        assert_eq!(scan_notes(project, NoteKind::Worldview).unwrap()[0].body, "");
        assert_eq!(fs::read_dir(project.join("构思/世界观")).unwrap().count(), 1);
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn root() -> PathBuf {
        let root = TempDir::new().unwrap().path().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn project(root: &Path) -> PathBuf {
        root.join("项目/《大魏读书人》")
    }

    fn draft(kind: NoteKind, name: &str) -> NoteDraft {
        NoteDraft::new(kind, name)
    }

    #[test]
    fn 人物完整档案与旧人物新组织混合重开() {
        let temp = TempDir::new().unwrap();
        let p = temp.path();
        let old = p.join("构思/人物/旧人物.md");
        write(&old, "---\n分组: 山门\n别名: [小陈]\n手补: 不可丢\n---\n\n小传、外貌、说话方式和人物弧自由写。\n");
        let mut d = NoteDraft::new(NoteKind::Character, "新人");
        d.character = CharacterProfile {
            image: Some("../../附件/不存在.png".into()),
            identity: Some("守门人".into()), age: Some("看起来二十岁".into()),
            gender: Some("女".into()), traits: vec!["谨慎".into(), "执拗".into()],
            goal: Some("寻回兄长".into()), ability: Some("听风".into()),
            weakness: Some("每次使用失聪一天".into()), secret: Some("来自敌营".into()),
        };
        d.aliases = vec!["阿风".into()];
        d.body = "## 小传\n不受固定表单限制。\n## 人物弧\n学会信任。".into();
        let created = save_note(p, &d, None).unwrap();
        crate::social::save_organization(p, &crate::social::OrganizationDraft {
            name: "山门".into(), purpose: Some("守护山道".into()), body: "完整组织正文".into(),
            ..Default::default()
        }, None).unwrap();
        let reopened = scan_notes(p, NoteKind::Character).unwrap();
        assert_eq!(reopened.iter().find(|n| n.name == "新人").unwrap(), &created);
        let legacy = reopened.iter().find(|n| n.name == "旧人物").unwrap();
        assert_eq!(legacy.character, CharacterProfile::default());
        assert_eq!(legacy.group.as_deref(), Some("山门"));
        assert_eq!(crate::social::workspace(p).unwrap().organizations[0].draft.body, "完整组织正文");
        d.character = CharacterProfile::default();
        let cleared = save_note(p, &d, Some(&created.path)).unwrap();
        assert_eq!(cleared.character, CharacterProfile::default());
        assert_eq!(cleared.body, d.body);
        let mut legacy_draft = NoteDraft::new(NoteKind::Character, "旧人物");
        legacy_draft.body = legacy.body.clone();
        legacy_draft.aliases = legacy.aliases.clone();
        legacy_draft.character.identity = Some("旧档补身份".into());
        save_note(p, &legacy_draft, Some(&old)).unwrap();
        let raw = fs::read_to_string(&old).unwrap();
        assert!(raw.contains("手补: 不可丢"));
        assert!(raw.contains("分组: 山门"));
    }

    #[test]
    fn 人物编辑版本过期不覆盖外部改动() {
        let temp = TempDir::new().unwrap();
        let mut d = NoteDraft::new(NoteKind::Character, "甲");
        d.body = "原小传".into();
        let saved = save_note(temp.path(), &d, None).unwrap();
        d.fingerprint = Some(saved.fingerprint);
        d.character.identity = Some("新身份".into());
        fs::write(&saved.path, "外部改写的小传").unwrap();
        assert!(save_note(temp.path(), &d, Some(&saved.path)).is_err());
        assert_eq!(fs::read_to_string(saved.path).unwrap(), "外部改写的小传");
    }

    #[test]
    fn 项目_ipc_走_camelCase_与中文类别() {
        let entry = ProjectEntry {
            dir: PathBuf::from("项目/《书》"),
            name: "《书》".into(),
            title: "书".into(),
            chapter_count: 1,
            word_count: 2,
            unit_count: 3,
            contradiction_count: 4,
            character_count: 5,
            worldview_count: 6,
            opening_count: 7,
            foreshadow_count: 8,
            expectation_expect_count: 9,
            expectation_goal_count: 10,
            cover: None,
            cover_dir: PathBuf::from("项目/《书》/附件"),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"chapterCount\""));
        assert!(json.contains("\"contradictionCount\""));
        assert!(json.contains("\"expectationExpectCount\""));
        assert!(json.contains("\"expectationGoalCount\""));
        assert!(json.contains("\"coverDir\""));

        assert_eq!(serde_json::to_string(&NoteKind::Unit).unwrap(), "\"单元\"");
        let back: NoteKind = serde_json::from_str("\"世界观\"").unwrap();
        assert_eq!(back, NoteKind::Worldview);
        assert!(serde_json::from_str::<NoteKind>("\"不存在的类别\"").is_err());
        assert!(NoteKind::ALL
            .iter()
            .all(|k| NoteKind::from_name(k.name()) == Some(*k)));
    }

    #[test]
    fn 扫描_直接子文件夹即项目_懒生成缺省书名() {
        let root = root();
        write(&project(&root).join("项目.yaml"), "书名: 大魏读书人\n");
        write(&project(&root).join("正文/0001 初入江湖.md"), "第一章\n正文");
        write(&project(&root).join("构思/单元/初入京城.md"), "---\n---\n");
        // 手建的项目（不带《》）也认；无 项目.yaml 时书名取文件夹名。
        write(&root.join("项目/手建的书/正文/0001.md"), "第一章");
        // 项目/ 根下的散 .md 与隐藏目录不算项目。
        write(&root.join("项目/随手记.md"), "杂记");
        write(&root.join("项目/.隐藏/正文/0001.md"), "第一章");

        let projects = scan_projects(&root).unwrap();
        assert_eq!(projects.len(), 2);

        let 大魏 = projects.iter().find(|p| p.title == "大魏读书人").unwrap();
        assert_eq!(大魏.name, "《大魏读书人》");
        assert_eq!(大魏.chapter_count, 1);
        assert_eq!(大魏.word_count, 5);
        assert_eq!(大魏.unit_count, 1);

        let 手建 = projects.iter().find(|p| p.name == "手建的书").unwrap();
        assert_eq!(手建.title, "手建的书");
    }

    #[test]
    fn 扫描_无项目目录_返回空_库根无效报错() {
        let root = root();
        assert!(scan_projects(&root).unwrap().is_empty());

        let missing = root.join("不存在的");
        assert!(scan_projects(&missing).is_err());
    }

    #[test]
    fn 新建_加书名号_只建项目文件夹_重名报错() {
        let root = root();
        let entry = create_project(&root, "《大魏读书人》").unwrap();
        assert_eq!(entry.name, "《大魏读书人》");
        assert_eq!(entry.title, "大魏读书人");
        assert!(project(&root).is_dir());
        // 懒生成：不预建 正文/附件/构思，缺目录＝还没做那一步。
        assert!(!project(&root).join("正文").exists());
        assert!(!meta_path(&project(&root)).exists(), "项目.yaml 懒生成");

        assert!(create_project(&root, "大魏读书人").is_err(), "重名应报错");
        assert!(create_project(&root, "   ").is_err());
        assert_eq!(scan_projects(&root).unwrap().len(), 1);
    }

    #[test]
    fn 封面_项目内附件_扫描识别_删文件即撤() {
        let root = root();
        write(&project(&root).join("附件/封面.webp"), "webp");

        let projects = scan_projects(&root).unwrap();
        assert_eq!(
            projects[0].cover,
            Some(project(&root).join("附件/封面.webp"))
        );
        assert_eq!(projects[0].cover_dir, project(&root).join("附件"));

        fs::remove_file(project(&root).join("附件/封面.webp")).unwrap();
        assert!(scan_projects(&root).unwrap()[0].cover.is_none());
    }

    #[test]
    fn 项目yaml_往返_未知键保留_清空移除键() {
        let root = root();
        let dir = project(&root);
        write(&dir.join("项目.yaml"), "书名: 旧名\n自定义键: 保留我\n");

        let meta = read_project_meta(&dir).unwrap();
        assert_eq!(meta.title.as_deref(), Some("旧名"));
        assert_eq!(meta.chapter_prefix, None);

        let updated = ProjectMeta {
            title: Some("新名".into()),
            chapter_prefix: Some("第{n}章".into()),
            plot_lines: vec![PlotLine {
                name: "主线".into(),
                color: Some("#c0392b".into()),
                extra: Mapping::new(),
            }],
            maps: vec!["京城".into(), "江南".into()],
        };
        write_project_meta(&dir, &updated).unwrap();

        let text = fs::read_to_string(meta_path(&dir)).unwrap();
        assert!(text.contains("自定义键: 保留我"));
        assert!(text.contains("书名: 新名"));
        assert!(text.contains("章前缀: 第{n}章"));
        assert!(text.contains("- 名: 主线"));
        assert_eq!(read_project_meta(&dir).unwrap(), updated);

        // 清空：键移除，未知键仍在。
        write_project_meta(&dir, &ProjectMeta::default()).unwrap();
        let text = fs::read_to_string(meta_path(&dir)).unwrap();
        assert!(!text.contains("书名"));
        assert!(!text.contains("情节线"));
        assert!(text.contains("自定义键: 保留我"));
    }

    #[test]
    fn 项目yaml_情节线_保序与行内未知键() {
        let root = root();
        let dir = project(&root);
        write(
            &dir.join("项目.yaml"),
            "情节线:\n- 名: 主线\n  色: \"#c0392b\"\n  备注: 手补的\n- 名: 感情线\n",
        );

        let meta = read_project_meta(&dir).unwrap();
        assert_eq!(meta.plot_lines.len(), 2);
        assert_eq!(meta.plot_lines[0].name, "主线");
        assert_eq!(meta.plot_lines[0].color.as_deref(), Some("#c0392b"));
        assert!(meta.plot_lines[0].extra.contains_key(Value::String("备注".into())));

        write_project_meta(&dir, &meta).unwrap();
        let text = fs::read_to_string(meta_path(&dir)).unwrap();
        assert!(text.contains("备注: 手补的"));
        assert!(text.contains("- 名: 感情线"));
    }

    #[test]
    fn 项目yaml_损坏_读取报错_情节线形态错误报错() {
        let root = root();
        let dir = project(&root);
        write(&dir.join("项目.yaml"), "{{{{不是 yaml");
        assert!(read_project_meta(&dir).is_err());

        write(&dir.join("项目.yaml"), "情节线: 主线\n");
        assert!(read_project_meta(&dir).is_err());

        write(&dir.join("项目.yaml"), "情节线:\n- 只有色: 红\n");
        assert!(read_project_meta(&dir).is_err());
    }

    #[test]
    fn 笔记_五类字段各写各的键() {
        let root = root();
        let dir = project(&root);

        let mut contradiction = draft(NoteKind::Contradiction, "通缉身份");
        contradiction.core = Some("主角背着通缉身份在京城立足".into());
        contradiction.types = vec!["情报装逼".into()];
        contradiction.source = Some("灵感库/故事卡/某卡".into());
        contradiction.links = vec!["《大魏读书人》".into()];
        contradiction.status = Some("池中".into());
        contradiction.body = "展开：能撑起什么".into();
        save_note(&dir, &contradiction, None).unwrap();

        let mut unit = draft(NoteKind::Unit, "初入京城");
        unit.core = Some("要在京城立足".into());
        unit.types = vec!["掉马甲".into(), "打脸".into()];
        save_note(&dir, &unit, None).unwrap();

        let mut character = draft(NoteKind::Character, "陈平安");
        character.character.identity = Some("主角的同门".into());
        character.group = Some("主角阵营".into()); // 旧入参不再写单一分组。
        character.aliases = vec!["小陈".into()];
        save_note(&dir, &character, None).unwrap();

        let mut worldview = draft(NoteKind::Worldview, "京城");
        worldview.category = Some("地理".into());
        save_note(&dir, &worldview, None).unwrap();

        let mut opening = draft(NoteKind::Opening, "第一版");
        opening.status = Some("选定".into());
        save_note(&dir, &opening, None).unwrap();

        let text = fs::read_to_string(notes_dir(&dir, NoteKind::Contradiction).join("通缉身份.md"))
            .unwrap();
        assert!(text.contains("一句话核心: 主角背着通缉身份在京城立足"));
        assert!(text.contains("状态: 池中"));

        let unit_text =
            fs::read_to_string(notes_dir(&dir, NoteKind::Unit).join("初入京城.md")).unwrap();
        assert!(unit_text.contains("核心矛盾: 要在京城立足"));
        assert!(!unit_text.contains("一句话核心"));

        let read = scan_notes(&dir, NoteKind::Character).unwrap();
        assert_eq!(read[0].group, None);
        assert_eq!(read[0].character.identity.as_deref(), Some("主角的同门"));
        assert_eq!(read[0].aliases, vec!["小陈"]);

        let read = scan_notes(&dir, NoteKind::Worldview).unwrap();
        assert_eq!(read[0].category.as_deref(), Some("地理"));
        assert_eq!(read[0].name, "京城");

        let read = scan_notes(&dir, NoteKind::Opening).unwrap();
        assert_eq!(read[0].status.as_deref(), Some("选定"));

        // 各目录互不串。
        assert_eq!(scan_notes(&dir, NoteKind::Contradiction).unwrap().len(), 1);
        assert_eq!(scan_notes(&dir, NoteKind::Unit).unwrap().len(), 1);
    }

    #[test]
    fn 单元_起章止章_落整数键_其他类别不写() {
        let root = root();
        let dir = project(&root);
        let mut unit = draft(NoteKind::Unit, "初入京城");
        unit.core = Some("要在京城立足".into());
        unit.start_chapter = Some(1);
        unit.end_chapter = Some(20);
        save_note(&dir, &unit, None).unwrap();

        let text = fs::read_to_string(notes_dir(&dir, NoteKind::Unit).join("初入京城.md")).unwrap();
        assert!(text.contains("起章: 1"), "{text}");
        assert!(text.contains("止章: 20"), "{text}");
        let read = scan_notes(&dir, NoteKind::Unit).unwrap();
        assert_eq!(read[0].start_chapter, Some(1));
        assert_eq!(read[0].end_chapter, Some(20));

        // 清空区间＝移除键；人物等其他类别不落起止章。
        unit.start_chapter = None;
        unit.end_chapter = None;
        save_note(&dir, &unit, Some(&read[0].path)).unwrap();
        let text = fs::read_to_string(notes_dir(&dir, NoteKind::Unit).join("初入京城.md")).unwrap();
        assert!(!text.contains("起章"), "{text}");

        let mut character = draft(NoteKind::Character, "陈平安");
        character.start_chapter = Some(3);
        save_note(&dir, &character, None).unwrap();
        let text = fs::read_to_string(notes_dir(&dir, NoteKind::Character).join("陈平安.md")).unwrap();
        assert!(!text.contains("起章"), "人物不写章区间：{text}");
    }

    #[test]
    fn 笔记_编辑改名_移动文件_未知键保留_同名续号() {
        let root = root();
        let dir = project(&root);
        let mut d = draft(NoteKind::Unit, "初入京城");
        d.types = vec!["掉马甲".into()];
        d.body = "初稿".into();
        let saved = save_note(&dir, &d, None).unwrap();

        // 在 Obsidian 里手补一个未知键。
        let text = fs::read_to_string(&saved.path).unwrap();
        write(&saved.path, &text.replacen("---\n", "---\n自定义键: 保留我\n", 1));

        let mut renamed = d.clone();
        renamed.name = "初入京城-改".into();
        renamed.body = "改过的".into();
        let moved = save_note(&dir, &renamed, Some(&saved.path)).unwrap();
        assert!(!saved.path.exists());
        assert!(moved.path.ends_with("构思/单元/初入京城-改.md"));
        let text = fs::read_to_string(&moved.path).unwrap();
        assert!(text.contains("自定义键: 保留我"));

        // 同名新建续号，不覆盖。
        let again = save_note(&dir, &renamed, None).unwrap();
        assert_ne!(again.path, moved.path);
        assert!(again.path.to_string_lossy().contains("初入京城-改-2.md"));
    }

    #[test]
    fn 笔记_清空字段_移除键_正文空时不留空frontmatter() {
        let root = root();
        let dir = project(&root);
        let mut d = draft(NoteKind::Character, "陈平安");
        d.character.identity = Some("同门".into());
        save_note(&dir, &d, None).unwrap();

        d.character.identity = None;
        d.body = "只有正文".into();
        let saved = save_note(&dir, &d, Some(&saved_path(&dir, NoteKind::Character, "陈平安"))).unwrap();
        let text = fs::read_to_string(&saved.path).unwrap();
        assert_eq!(text, "只有正文", "映射为空时不落空 frontmatter 块");
    }

    fn saved_path(project: &Path, kind: NoteKind, name: &str) -> PathBuf {
        notes_dir(project, kind).join(format!("{name}.md"))
    }

    #[test]
    fn 笔记_非法名报错_删除文件() {
        let root = root();
        let dir = project(&root);
        let mut d = draft(NoteKind::Unit, "***");
        assert!(save_note(&dir, &d, None).is_err());
        d.name = "  ".into();
        assert!(save_note(&dir, &d, None).is_err());

        d.name = "可删的".into();
        let saved = save_note(&dir, &d, None).unwrap();
        delete_note(&saved.path).unwrap();
        assert!(!saved.path.exists());
        assert!(delete_note(&saved.path).is_err());
    }

    // --- 待打磨（工单 #64 / T03）：五类笔记同一机制，随笔记文件保存 ---

    #[test]
    fn 待打磨_笔记_进入浏览退出_排序恢复_无副本() {
        let root = root();
        let dir = project(&root);
        for name in ["初入京城", "宫变前夜", "收尾"] {
            let mut unit = draft(NoteKind::Unit, name);
            unit.core = Some(format!("{name}的核心矛盾"));
            save_note(&dir, &unit, None).unwrap();
        }
        let order = |notes: &[NoteEntry]| notes.iter().map(|n| n.name.clone()).collect::<Vec<_>>();
        let before = scan_notes(&dir, NoteKind::Unit).unwrap();
        assert_eq!(order(&before), vec!["初入京城", "宫变前夜", "收尾"]);
        let files_before = crate::book_file::count_files_recursive(&dir);

        // 进入：宫变前夜 → 待打磨，仍在原目录原位置（路径序即列表序）。
        let target = &before[1];
        crate::book_file::set_pending(&target.path, true).unwrap();
        let during = scan_notes(&dir, NoteKind::Unit).unwrap();
        assert_eq!(order(&during), vec!["初入京城", "宫变前夜", "收尾"], "路径序不变");
        assert!(during[1].pending);
        assert!(!during[0].pending && !during[2].pending);

        // 便笺中的编辑走正常保存：内容更新且状态保留（合并不抹键）。
        let mut edited = draft(NoteKind::Unit, "宫变前夜");
        edited.core = Some("在便笺里改过的核心矛盾".into());
        edited.body = "在便笺里改过的正文".into();
        save_note(&dir, &edited, Some(&target.path)).unwrap();
        let during = scan_notes(&dir, NoteKind::Unit).unwrap();
        assert!(during[1].pending, "编辑后仍是待打磨");
        assert_eq!(during[1].core.as_deref(), Some("在便笺里改过的核心矛盾"));
        let raw = fs::read_to_string(&during[1].path).unwrap();
        assert!(raw.contains("待打磨: true"), "权威文件即同一份内容：{raw}");
        assert!(raw.contains("在便笺里改过的正文"));

        // 退出：键移除，回到原类别原排序位置；文件数不变（没有第二份便笺）。
        crate::book_file::set_pending(&during[1].path, false).unwrap();
        let after = scan_notes(&dir, NoteKind::Unit).unwrap();
        assert_eq!(order(&after), vec!["初入京城", "宫变前夜", "收尾"], "退出按原位置恢复");
        assert!(
            after.iter().filter(|n| n.pending).count() == 0,
            "读模型里待打磨区为空（前端整个区域不渲染）"
        );
        assert!(after[1].body.contains("在便笺里改过的正文"), "退出不动内容");
        assert_eq!(crate::book_file::count_files_recursive(&dir), files_before, "进出待打磨不建便笺库");
    }

    #[test]
    fn 待打磨_五类笔记与手写值_各归各的键() {
        let root = root();
        let dir = project(&root);
        let mut contradiction = draft(NoteKind::Contradiction, "通缉身份");
        contradiction.core = Some("背着通缉身份在京城立足".into());
        let saved = save_note(&dir, &contradiction, None).unwrap();
        crate::book_file::set_pending(&saved.path, true).unwrap();
        let read = scan_notes(&dir, NoteKind::Contradiction).unwrap();
        assert!(read[0].pending);
        assert_eq!(read[0].core.as_deref(), Some("背着通缉身份在京城立足"));

        // 旧内容（无键）与手写 false 都按普通内容处理，值原样保留。
        write(&dir.join("构思/矛盾/手写false.md"), "---\n待打磨: false\n状态: 池中\n---\n\n正文");
        let read = scan_notes(&dir, NoteKind::Contradiction).unwrap();
        let 手写 = read.iter().find(|n| n.name == "手写false").unwrap();
        assert!(!手写.pending);
        assert!(fs::read_to_string(&手写.path)
            .unwrap()
            .contains("待打磨: false"), "不认识的值不改动");
        assert_eq!(手写.status.as_deref(), Some("池中"));

        // 矛盾提为单元：读-合-写同样不抹待打磨键。
        let promoted = promote_contradiction(&saved.path).unwrap();
        assert!(!promoted.pending, "新单元默认不是待打磨");
        let back = scan_notes(&dir, NoteKind::Contradiction).unwrap();
        assert!(back.iter().find(|n| n.name == "通缉身份").unwrap().pending, "提为单元不动原矛盾的状态");
    }

    #[test]
    fn 类型圈_读写_未知键保留() {
        let root = root();
        let dir = project(&root);
        let circle = Circle {
            types: vec!["掉马甲".into(), "打脸".into()],
            body: "- 掉马甲：想看到主角在旧臣面前揭身份".into(),
        };
        save_circle(&dir, &circle).unwrap();
        let text = fs::read_to_string(circle_path(&dir)).unwrap();
        assert!(text.contains("类型:"));
        assert!(text.contains("- 掉马甲"));

        let mut map = frontmatter_mapping(&circle_path(&dir)).unwrap();
        map.insert(
            Value::String("自定义键".into()),
            Value::String("保留我".into()),
        );
        write_frontmatter(&circle_path(&dir), map, &circle.body).unwrap();

        let read = read_circle(&dir).unwrap();
        assert_eq!(read, circle);
        save_circle(&dir, &read).unwrap();
        assert!(fs::read_to_string(circle_path(&dir))
            .unwrap()
            .contains("自定义键: 保留我"));

        assert_eq!(read_circle(&project(&root).join("不存在的项目")).unwrap(), Circle::default());
    }

    #[test]
    fn 排布_读写_保序_未知键保留() {
        let root = root();
        let dir = project(&root);
        let items = vec![
            ArrangementItem {
                unit: "初入京城".into(),
                line: Some("主线".into()),
                map: Some("京城".into()),
                upgrade_battle: Some("升级".into()),
                pace: Some("紧绷".into()),
                extra: Mapping::new(),
            },
            ArrangementItem {
                unit: "宫变前夜".into(),
                line: None,
                map: None,
                upgrade_battle: Some("战斗".into()),
                pace: None,
                extra: Mapping::new(),
            },
        ];
        save_arrangement(&dir, &items).unwrap();
        assert_eq!(read_arrangement(&dir).unwrap(), items);

        let text = fs::read_to_string(arrangement_path(&dir)).unwrap();
        assert!(text.contains("- 单元: 初入京城"));
        assert!(text.contains("  线: 主线"));
        assert!(!text.contains("单元: 宫变前夜\n  线"), "空属性不落键");

        // 手补行内未知键：读写往返不丢。
        write(
            &arrangement_path(&dir),
            "- 单元: 初入京城\n  线: 主线\n  备注: 手补的\n",
        );
        let read = read_arrangement(&dir).unwrap();
        assert_eq!(read[0].line.as_deref(), Some("主线"));
        assert!(read[0].extra.contains_key(Value::String("备注".into())));
        save_arrangement(&dir, &read).unwrap();
        assert!(fs::read_to_string(arrangement_path(&dir))
            .unwrap()
            .contains("备注: 手补的"));
    }

    #[test]
    fn 排布_保存读合写_盘上未知键与手写值不丢() {
        let root = root();
        let dir = project(&root);
        // 盘上：手补未知键、手写的非标量已知键、以及「线」被 Obsidian 改过。
        write(
            &arrangement_path(&dir),
            "- 单元: 初入京城\n  线: 主线\n  备注: 手补的\n- 单元: 宫变前夜\n  线: [非标量保留]\n",
        );
        let disk = read_arrangement(&dir).unwrap();
        assert_eq!(disk[0].line.as_deref(), Some("主线"));

        // 应用侧载入后，用户在 Obsidian 里把第一项的「备注」改了。
        write(
            &arrangement_path(&dir),
            "- 单元: 初入京城\n  线: 主线\n  备注: 盘上更新的\n- 单元: 宫变前夜\n  线: [非标量保留]\n",
        );

        // 应用保存：次序调整（宫变前夜在前），未知键按单元名配对带回。
        let mut items = vec![disk[1].clone(), disk[0].clone()];
        items[1].pace = Some("紧绷".into());
        save_arrangement(&dir, &items).unwrap();

        let text = fs::read_to_string(arrangement_path(&dir)).unwrap();
        assert!(text.contains("备注: 盘上更新的"), "盘上更新的手补值应胜出：{text}");
        assert!(text.contains("非标量保留"), "非标量已知键原样保留：{text}");
        assert!(text.contains("节奏: 紧绷"));

        let back = read_arrangement(&dir).unwrap();
        assert_eq!(back[0].unit, "宫变前夜");
        assert_eq!(back[1].unit, "初入京城");
        assert!(back[1].extra.contains_key(Value::String("备注".into())));

        // 应用里删掉的项不复活。
        save_arrangement(&dir, &back[..1]).unwrap();
        assert_eq!(read_arrangement(&dir).unwrap().len(), 1);
    }

    #[test]
    fn 排布_空单元报错不落盘() {
        let root = root();
        let dir = project(&root);
        let err = save_arrangement(&dir, &[item("   ", None, None, None, None)]).unwrap_err();
        assert!(err.contains("缺「单元」"), "{err}");
        assert!(!arrangement_path(&dir).exists());
    }

    #[test]
    fn 排布_缺文件空列表_损坏报错_缺单元报错() {
        let root = root();
        let dir = project(&root);
        assert!(read_arrangement(&dir).unwrap().is_empty());

        write(&arrangement_path(&dir), "单元: 初入京城\n");
        assert!(read_arrangement(&dir).is_err(), "顶层非列表应报错");

        write(&arrangement_path(&dir), "- 线: 主线\n");
        let err = read_arrangement(&dir).unwrap_err();
        assert!(err.contains("缺「单元」"), "{err}");

        write(&arrangement_path(&dir), "- 单元: [a, b]\n");
        assert!(read_arrangement(&dir).is_err());
    }

    #[test]
    fn 排布_ipc_extra_往返() {
        let mut extra = Mapping::new();
        extra.insert(Value::String("备注".into()), Value::String("手补".into()));
        let item = ArrangementItem {
            unit: "初入京城".into(),
            line: Some("主线".into()),
            map: None,
            upgrade_battle: None,
            pace: None,
            extra,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"upgradeBattle\""));
        assert!(json.contains("\"备注\":\"手补\""));
        let back: ArrangementItem = serde_json::from_str(&json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn 体检_比例_连续节奏_失效引用_未排布单元() {
        let unit_names: Vec<String> = ["初入京城", "宫变前夜", "收尾"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let line_names = vec!["主线".to_string()];
        let map_names = vec!["京城".to_string()];

        let items = vec![
            item("初入京城", Some("主线"), Some("京城"), Some("升级"), Some("紧绷")),
            item("宫变前夜", Some("主线"), Some("江南"), Some("升级"), Some("紧绷")),
            item("幽灵单元", Some("感情线"), None, Some("升级"), Some("紧绷")),
            item("初入京城", None, None, Some("战斗"), None),
        ];
        let check = check_arrangement(&items, &unit_names, &line_names, &map_names);

        assert!(check.ratio_hint.contains("升级 3 : 战斗 1"), "{}", check.ratio_hint);
        assert_eq!(check.pace_hints.len(), 1);
        assert!(check.pace_hints[0].contains("第 1~3 项连续「紧绷」"));
        assert!(check.ref_hints.iter().any(|h| h.contains("感情线")));
        assert!(check.ref_hints.iter().any(|h| h.contains("江南")));
        assert_eq!(check.missing_units, vec!["幽灵单元"]);
        assert_eq!(check.unarranged_units, vec!["收尾"]);
        assert_eq!(check.map_counts.len(), 2);
        assert_eq!(check.map_counts[0].map, "京城");
        assert_eq!(check.map_counts[0].count, 1);

        let empty = check_arrangement(&[], &unit_names, &[], &[]);
        assert!(empty.ratio_hint.contains("还没标"));
        assert_eq!(empty.unarranged_units.len(), 3);
    }

    fn item(
        unit: &str,
        line: Option<&str>,
        map: Option<&str>,
        upgrade_battle: Option<&str>,
        pace: Option<&str>,
    ) -> ArrangementItem {
        ArrangementItem {
            unit: unit.into(),
            line: line.map(str::to_string),
            map: map.map(str::to_string),
            upgrade_battle: upgrade_battle.map(str::to_string),
            pace: pace.map(str::to_string),
            extra: Mapping::new(),
        }
    }

    #[test]
    fn 体检_2比1口径() {
        let units = vec!["甲".to_string()];
        let mut items: Vec<ArrangementItem> = (0..10)
            .map(|_| item("甲", None, None, Some("升级"), None))
            .collect();
        items.extend((0..3).map(|_| item("甲", None, None, Some("战斗"), None)));
        let check = check_arrangement(&items, &units, &[], &[]);
        assert!(check.ratio_hint.contains("战斗偏少"), "{}", check.ratio_hint);

        let mut items: Vec<ArrangementItem> = (0..4)
            .map(|_| item("甲", None, None, Some("升级"), None))
            .collect();
        items.extend((0..2).map(|_| item("甲", None, None, Some("战斗"), None)));
        let check = check_arrangement(&items, &units, &[], &[]);
        assert!(check.ratio_hint.contains("接近 2:1"), "{}", check.ratio_hint);

        let mut items: Vec<ArrangementItem> = (0..2)
            .map(|_| item("甲", None, None, Some("升级"), None))
            .collect();
        items.extend((0..3).map(|_| item("甲", None, None, Some("战斗"), None)));
        let check = check_arrangement(&items, &units, &[], &[]);
        assert!(check.ratio_hint.contains("战斗偏多"), "{}", check.ratio_hint);
    }

    #[test]
    fn 体检命令_从盘上读定义() {
        let root = root();
        let dir = project(&root);
        write_project_meta(
            &dir,
            &ProjectMeta {
                title: None,
                chapter_prefix: None,
                plot_lines: vec![PlotLine {
                    name: "主线".into(),
                    color: None,
                    extra: Mapping::new(),
                }],
                maps: vec![],
            },
        )
        .unwrap();
        save_note(&dir, &draft(NoteKind::Unit, "初入京城"), None).unwrap();
        let mut 京城 = draft(NoteKind::Worldview, "京城");
        京城.category = Some("地理".into());
        save_note(&dir, &京城, None).unwrap();

        let check = check_project_arrangement(
            &dir,
            &[item("初入京城", Some("主线"), Some("京城"), None, None)],
        )
        .unwrap();
        assert!(check.ref_hints.is_empty(), "地理词条应认作地图定义：{:?}", check.ref_hints);
        assert!(check.missing_units.is_empty());
        assert!(check.unarranged_units.is_empty());
    }

    #[test]
    fn 矛盾提为单元_预填字段_状态改已成单元_矛盾留档() {        let root = root();
        let dir = project(&root);
        let mut c = draft(NoteKind::Contradiction, "通缉身份");
        c.core = Some("背着通缉身份在京城立足".into());
        c.types = vec!["情报装逼".into()];
        c.source = Some("灵感库/故事卡/某卡".into());
        c.links = vec!["某卡".into()];
        c.status = Some("池中".into());
        c.body = "种子展开笔记".into();
        let saved = save_note(&dir, &c, None).unwrap();

        let unit = promote_contradiction(&saved.path).unwrap();
        assert_eq!(unit.kind, NoteKind::Unit);
        assert_eq!(unit.name, "通缉身份");
        assert_eq!(unit.core.as_deref(), Some("背着通缉身份在京城立足"));
        assert_eq!(unit.types, vec!["情报装逼"]);
        assert!(unit.body.contains("## 桥段安排"));

        let back = scan_notes(&dir, NoteKind::Contradiction).unwrap();
        assert_eq!(back.len(), 1, "矛盾留档不删");
        assert_eq!(back[0].status.as_deref(), Some("已成单元"));
        assert_eq!(back[0].body, "种子展开笔记");
        assert_eq!(back[0].source.as_deref(), Some("灵感库/故事卡/某卡"));

        // 再提一次：同名单元已存在，报错让人裁决。
        assert!(promote_contradiction(&saved.path).is_err());
        // 不是 构思/矛盾/ 下的文件一律拒绝。
        let unit_path = notes_dir(&dir, NoteKind::Unit).join("通缉身份.md");
        let err = promote_contradiction(&unit_path).unwrap_err();
        assert!(err.contains("构思/矛盾"), "{err}");
    }

    #[test]
    fn 故事卡转生_预填字段_卡片关联记去向_未知键保留() {
        let root = root();
        let dir = project(&root);
        write(&dir.join("项目.yaml"), "书名: 大魏读书人\n");
        let card_path = root.join("灵感库/故事卡/外卖小哥的末世签到.md");
        write(
            &card_path,
            "---\n标签:\n- 末世\n- 掉马甲\n一句话核心: 外卖员得签到系统，末世囤物资被当扫地僧\n来源: 拆《大奉打更人》有感\n关联:\n- 《大奉打更人》\n我的私货: 手补的键\n---\n正文展开。\n",
        );

        let unit = transmute_story_card(&root, &card_path, &dir).unwrap();
        assert_eq!(unit.kind, NoteKind::Unit);
        assert_eq!(unit.name, "外卖小哥的末世签到");
        assert_eq!(
            unit.core.as_deref(),
            Some("外卖员得签到系统，末世囤物资被当扫地僧")
        );
        assert_eq!(unit.types, vec!["末世", "掉马甲"]);
        assert!(unit.body.contains("## 桥段安排"));
        assert!(unit.path.is_file());

        let card = crate::inspiration::read_card(&card_path);
        assert_eq!(
            card.links,
            vec!["《大奉打更人》", "《大魏读书人》/外卖小哥的末世签到"]
        );
        assert!(card.body.contains("正文展开"), "卡片正文不因转生被动");
        let raw = fs::read_to_string(&card_path).unwrap();
        assert!(raw.contains("我的私货"), "手补未知键不丢：{raw}");

        // 再转一次：同名单元已存在，报错让人裁决。
        let err = transmute_story_card(&root, &card_path, &dir).unwrap_err();
        assert!(err.contains("同名单元"), "{err}");
    }

    #[test]
    fn 故事卡转生_无项目yaml书名兜底_重转不重复记关联() {
        let root = root();
        let dir = project(&root); // 无 项目.yaml：书名取文件夹名去《》
        fs::create_dir_all(&dir).unwrap();
        let card_path = root.join("灵感库/故事卡/某卡.md");
        write(&card_path, "---\n一句话核心: 核心\n---\n");

        let unit = transmute_story_card(&root, &card_path, &dir).unwrap();
        assert_eq!(unit.name, "某卡");
        let card = crate::inspiration::read_card(&card_path);
        assert_eq!(card.links, vec!["《大魏读书人》/某卡"]);

        // 删掉单元再转一次：去向已在，不重复记。
        fs::remove_file(&unit.path).unwrap();
        transmute_story_card(&root, &card_path, &dir).unwrap();
        let card = crate::inspiration::read_card(&card_path);
        assert_eq!(card.links.len(), 1, "{:?}", card.links);
    }

    #[test]
    fn 故事卡转生_非故事卡与项目外一律拒绝() {
        let root = root();
        let dir = project(&root);
        fs::create_dir_all(&dir).unwrap();
        let role_card = root.join("灵感库/角色卡/某人.md");
        write(&role_card, "---\n---\n");
        let err = transmute_story_card(&root, &role_card, &dir).unwrap_err();
        assert!(err.contains("只有故事卡"), "{err}");

        let card = root.join("灵感库/故事卡/某卡.md");
        write(&card, "---\n---\n");
        let outside = root.join("别处/《书》");
        fs::create_dir_all(&outside).unwrap();
        let err = transmute_story_card(&root, &card, &outside).unwrap_err();
        assert!(err.contains("项目/"), "{err}");
    }

    #[test]
    fn 全流程_建项目到排布体检() {
        let root = root();
        let project = create_project(&root, "大魏读书人").unwrap();
        let dir = project.dir.clone();

        write_project_meta(
            &dir,
            &ProjectMeta {
                title: Some("大魏读书人".into()),
                chapter_prefix: None,
                plot_lines: vec![PlotLine {
                    name: "主线".into(),
                    color: None,
                    extra: Mapping::new(),
                }],
                maps: vec!["京城".into()],
            },
        )
        .unwrap();
        save_circle(
            &dir,
            &Circle {
                types: vec!["情报装逼".into()],
                body: "- 情报装逼：想看他靠情报拿捏大人物".into(),
            },
        )
        .unwrap();

        let mut seed = NoteDraft::new(NoteKind::Contradiction, "通缉身份");
        seed.core = Some("背着通缉身份在京城立足".into());
        seed.types = vec!["情报装逼".into()];
        let seed = save_note(&dir, &seed, None).unwrap();
        let unit = promote_contradiction(&seed.path).unwrap();

        save_arrangement(
            &dir,
            &[ArrangementItem {
                unit: unit.name.clone(),
                line: Some("主线".into()),
                map: Some("京城".into()),
                upgrade_battle: Some("升级".into()),
                pace: Some("紧绷".into()),
                extra: Mapping::new(),
            }],
        )
        .unwrap();

        let check = check_project_arrangement(&dir, &read_arrangement(&dir).unwrap()).unwrap();
        assert!(check.missing_units.is_empty(), "{:?}", check.missing_units);
        assert!(check.unarranged_units.is_empty());
        assert!(check.ref_hints.is_empty(), "{:?}", check.ref_hints);
        assert_eq!(check.map_counts.len(), 1);

        let list = scan_projects(&root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "大魏读书人");
        assert_eq!(list[0].unit_count, 1);
        assert_eq!(list[0].contradiction_count, 1);
        assert_eq!(read_circle(&dir).unwrap().types, vec!["情报装逼"]);
    }
}
