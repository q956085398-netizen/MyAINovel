//! 地图、地域与转场（工单 #61 数据底座、#65 完整档案，docs/spec/地图与地域.md）。
//!
//! 地图和地域各自是一文件实体；`地图结构.yaml` 只保存它们之间的
//! 包含、关系、转场及画布布局。旧世界观「地理」词条只读兼容，升级须先
//! 预览，再由调用方显式确认；确认后旧文件移入项目内可恢复的兼容备份。

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{
    content_fingerprint, file_stem_of, frontmatter_mapping, has_md_extension, is_hidden,
    is_pending, map_list, map_scalar, read_text, sanitize_file_name, set_map_list, set_map_scalar,
    split_frontmatter, strip_bom, unique_file_path, write_frontmatter, write_yaml_mapping,
};
use crate::project::{self, NoteKind};

pub const MAP_DIR: &str = "地图";
pub const REGION_DIR: &str = "地域";
pub const COMPAT_BACKUP_DIR: &str = ".gongbi/兼容备份";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GeoUpgradeTarget {
    #[serde(rename = "地图")]
    Map,
    #[serde(rename = "地域")]
    Region,
}

impl GeoUpgradeTarget {
    fn dir_name(self) -> &'static str {
        match self {
            Self::Map => MAP_DIR,
            Self::Region => REGION_DIR,
        }
    }
}

/// 地图档案（工单 #65 / T15）：整体故事空间的完整卡面字段。frontmatter
/// 以中文键落盘；未列入手补键（如 背景图，留给两级画布工单）读-合-写
/// 原样保留。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDraft {
    pub name: String,
    pub scale: Option<String>,
    pub boundary: Option<String>,
    pub eras: Vec<String>,
    pub role: Option<String>,
    pub stage_goal: Option<String>,
    pub central_conflict: Option<String>,
    pub core_secret: Option<String>,
    pub local_mainline: Option<String>,
    pub entry_condition: Option<String>,
    pub exit_condition: Option<String>,
    pub people: Vec<String>,
    pub organizations: Vec<String>,
    pub units: Vec<String>,
    pub milestones: Vec<String>,
    /// 地图附件背景相对路径；图片本体始终留在项目附件目录。
    pub background_image: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEntry {
    pub path: PathBuf,
    pub name: String,
    pub scale: Option<String>,
    pub boundary: Option<String>,
    pub eras: Vec<String>,
    pub role: Option<String>,
    pub stage_goal: Option<String>,
    pub central_conflict: Option<String>,
    pub core_secret: Option<String>,
    pub local_mainline: Option<String>,
    pub entry_condition: Option<String>,
    pub exit_condition: Option<String>,
    pub people: Vec<String>,
    pub organizations: Vec<String>,
    pub units: Vec<String>,
    pub milestones: Vec<String>,
    pub background_image: Option<String>,
    /// 仅存在时返回绝对路径；失效引用仍保留在 background_image。
    pub background_image_path: Option<PathBuf>,
    pub body: String,
    /// 待打磨中：frontmatter 布尔键「待打磨: true」派生，随文件保存。
    pub pending: bool,
}

/// 地域档案：地图内部局部区域。地域连接与跨地图转场分开存（结构表），
/// 档案只管这个地方本身。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionDraft {
    pub name: String,
    pub scale: Option<String>,
    pub plot_role: Option<String>,
    pub people: Vec<String>,
    pub organizations: Vec<String>,
    pub contradictions: Vec<String>,
    pub units: Vec<String>,
    pub foreshadows: Vec<String>,
    pub eras: Vec<String>,
    pub local_mainline: Option<String>,
    pub secret: Option<String>,
    /// 展开为另一张地图：只是名字引用，两张档案互不复制。
    pub expands_to: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionEntry {
    pub path: PathBuf,
    pub name: String,
    pub scale: Option<String>,
    pub plot_role: Option<String>,
    pub people: Vec<String>,
    pub organizations: Vec<String>,
    pub contradictions: Vec<String>,
    pub units: Vec<String>,
    pub foreshadows: Vec<String>,
    pub eras: Vec<String>,
    pub local_mainline: Option<String>,
    pub secret: Option<String>,
    pub expands_to: Option<String>,
    pub body: String,
    pub pending: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapWorkspace {
    pub maps: Vec<MapEntry>,
    pub regions: Vec<RegionEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialLegendItem {
    pub name: String,
    pub directed: bool,
    /// 条目里的手补字段；读-合-写时原样归还给文件。
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRelation {
    pub from: String,
    pub to: String,
    pub kind: String,
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionRelation {
    pub from: String,
    pub to: String,
    /// 只提示、不校验：图例外的手写类型仍须可读、可保存。
    pub kind: String,
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapContainment {
    pub map: String,
    pub region: String,
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapTransition {
    pub from: String,
    pub to: String,
    pub reason: Option<String>,
    pub advance_people: Vec<String>,
    pub clues: Vec<String>,
    pub unresolved: Vec<String>,
    pub return_condition: Option<String>,
    pub units: Vec<String>,
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapStructure {
    pub map_legend: Vec<SpatialLegendItem>,
    pub region_legend: Vec<SpatialLegendItem>,
    pub map_relations: Vec<MapRelation>,
    pub region_relations: Vec<RegionRelation>,
    /// `(地图, 地域)`；归属与地域之间的连接关系分开存，避免语义混淆。
    pub contains: Vec<MapContainment>,
    pub transitions: Vec<MapTransition>,
    /// 「全书」「地图」两层画布坐标；值不解释，随项目保存。
    pub layout: Mapping,
    /// 结构文件载入指纹，前端原样带回布局与关系写入以拒绝过期覆盖。
    #[serde(default)]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCanvasPlacement {
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCanvasLayout {
    pub placements: Vec<MapCanvasPlacement>,
    pub fingerprint: Option<String>,
}

impl Default for MapStructure {
    fn default() -> Self {
        Self {
            map_legend: vec![
                SpatialLegendItem {
                    name: "核心附属".into(),
                    directed: true,
                    extra: Mapping::new(),
                },
                SpatialLegendItem {
                    name: "上下层".into(),
                    directed: true,
                    extra: Mapping::new(),
                },
            ],
            region_legend: vec![
                SpatialLegendItem {
                    name: "包含".into(),
                    directed: true,
                    extra: Mapping::new(),
                },
                SpatialLegendItem {
                    name: "相邻".into(),
                    directed: false,
                    extra: Mapping::new(),
                },
                SpatialLegendItem {
                    name: "通道".into(),
                    directed: false,
                    extra: Mapping::new(),
                },
                SpatialLegendItem {
                    name: "往返".into(),
                    directed: false,
                    extra: Mapping::new(),
                },
                SpatialLegendItem {
                    name: "隐秘联系".into(),
                    directed: false,
                    extra: Mapping::new(),
                },
            ],
            map_relations: Vec::new(),
            region_relations: Vec::new(),
            contains: Vec::new(),
            transitions: Vec::new(),
            layout: Mapping::new(),
            fingerprint: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoUpgradePreview {
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    pub backup_path: PathBuf,
    pub target: GeoUpgradeTarget,
    pub source_fingerprint: String,
}

/// 现扫地图档案；目录缺失是合法的空项目，单个损坏的 Markdown 仍以原文
/// 显示，避免一个档案拖垮整个项目。
pub fn map_workspace(project: &Path) -> Result<MapWorkspace, String> {
    Ok(MapWorkspace {
        maps: scan_maps(project)?,
        regions: scan_regions(project)?,
    })
}

fn scan_maps(project: &Path) -> Result<Vec<MapEntry>, String> {
    let dir = project.join(project::CONCEPT_DIR).join(MAP_DIR);
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| !is_hidden(path) && path.is_file() && has_md_extension(path))
        .collect();
    paths.sort();
    Ok(paths.iter().map(|path| read_map(path)).collect())
}

fn read_map(path: &Path) -> MapEntry {
    let mut entry = MapEntry {
        path: path.to_path_buf(),
        name: file_stem_of(path),
        ..MapEntry::default()
    };
    let Some((map, body)) = place_parts(path) else {
        // 无/坏 frontmatter：原文整段当正文，编辑保存即重建头部（内容不丢）。
        entry.body = place_raw_body(path);
        return entry;
    };
    entry.scale = map_scalar(&map, "尺度");
    entry.boundary = map_scalar(&map, "边界");
    entry.eras = map_list(&map, "时代");
    entry.role = map_scalar(&map, "作用");
    entry.stage_goal = map_scalar(&map, "阶段目标");
    entry.central_conflict = map_scalar(&map, "中心矛盾");
    entry.core_secret = map_scalar(&map, "核心秘密");
    entry.local_mainline = map_scalar(&map, "当地主线");
    entry.entry_condition = map_scalar(&map, "进入条件");
    entry.exit_condition = map_scalar(&map, "离开条件");
    entry.people = map_list(&map, "人物");
    entry.organizations = map_list(&map, "组织");
    entry.units = map_list(&map, "单元");
    entry.milestones = map_list(&map, "主线里程碑");
    entry.background_image = map_scalar(&map, "背景图");
    entry.background_image_path = entry.background_image.as_ref().and_then(|reference| {
        let parent = path.parent()?;
        let project = parent.parent()?.parent()?;
        let attachments = project.join("附件").canonicalize().ok()?;
        let is_attachment = |candidate: PathBuf| {
            candidate
                .canonicalize()
                .ok()
                .filter(|resolved| resolved.is_file() && resolved.starts_with(&attachments))
        };
        is_attachment(parent.join(reference)).or_else(|| {
            // 兼容最初规格中的 `../附件/...` 示例；地图文件实际位于
            // 构思/地图/，新建引用统一写为 `../../附件/...`。
            let relative = Path::new(reference)
                .strip_prefix(Path::new("..").join("附件"))
                .ok()?;
            is_attachment(project.join("附件").join(relative))
        })
    });
    entry.pending = is_pending(&map);
    entry.body = body;
    entry
}

fn apply_map_draft(frontmatter: &mut Mapping, draft: &MapDraft) {
    set_map_scalar(frontmatter, "尺度", draft.scale.as_deref());
    set_map_scalar(frontmatter, "边界", draft.boundary.as_deref());
    set_map_list(frontmatter, "时代", &draft.eras);
    set_map_scalar(frontmatter, "作用", draft.role.as_deref());
    set_map_scalar(frontmatter, "阶段目标", draft.stage_goal.as_deref());
    set_map_scalar(frontmatter, "中心矛盾", draft.central_conflict.as_deref());
    set_map_scalar(frontmatter, "核心秘密", draft.core_secret.as_deref());
    set_map_scalar(frontmatter, "当地主线", draft.local_mainline.as_deref());
    set_map_scalar(frontmatter, "进入条件", draft.entry_condition.as_deref());
    set_map_scalar(frontmatter, "离开条件", draft.exit_condition.as_deref());
    set_map_list(frontmatter, "人物", &draft.people);
    set_map_list(frontmatter, "组织", &draft.organizations);
    set_map_list(frontmatter, "单元", &draft.units);
    set_map_list(frontmatter, "主线里程碑", &draft.milestones);
    set_map_scalar(frontmatter, "背景图", draft.background_image.as_deref());
}

/// 保存地图：新建或编辑（改名＝文件改名）。frontmatter 以现有文件为底
/// 合并（背景图等未管理键不丢），同名续号不覆盖他人——与构思笔记同口径。
pub fn save_map(
    project: &Path,
    draft: &MapDraft,
    prev_path: Option<&Path>,
) -> Result<MapEntry, String> {
    let path = place_path(project, MAP_DIR, &draft.name, prev_path)?;
    let base = prev_path.filter(|p| *p != path).unwrap_or(&path);
    let mut frontmatter = frontmatter_mapping(base).unwrap_or_default();
    apply_map_draft(&mut frontmatter, draft);
    rename_prev(prev_path, &path, MAP_DIR)?;
    write_frontmatter(&path, frontmatter, &draft.body)?;
    Ok(read_map(&path))
}

fn scan_regions(project: &Path) -> Result<Vec<RegionEntry>, String> {
    let dir = project.join(project::CONCEPT_DIR).join(REGION_DIR);
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| !is_hidden(path) && path.is_file() && has_md_extension(path))
        .collect();
    paths.sort();
    Ok(paths.iter().map(|path| read_region(path)).collect())
}

fn read_region(path: &Path) -> RegionEntry {
    let mut entry = RegionEntry {
        path: path.to_path_buf(),
        name: file_stem_of(path),
        ..RegionEntry::default()
    };
    let Some((map, body)) = place_parts(path) else {
        entry.body = place_raw_body(path);
        return entry;
    };
    entry.scale = map_scalar(&map, "尺度");
    entry.plot_role = map_scalar(&map, "剧情功能");
    entry.people = map_list(&map, "人物");
    entry.organizations = map_list(&map, "组织");
    entry.contradictions = map_list(&map, "矛盾");
    entry.units = map_list(&map, "单元");
    entry.foreshadows = map_list(&map, "伏笔");
    entry.eras = map_list(&map, "时代");
    entry.local_mainline = map_scalar(&map, "当地主线");
    entry.secret = map_scalar(&map, "秘密");
    entry.expands_to = map_scalar(&map, "展开为");
    entry.pending = is_pending(&map);
    entry.body = body;
    entry
}

fn apply_region_draft(frontmatter: &mut Mapping, draft: &RegionDraft) {
    set_map_scalar(frontmatter, "尺度", draft.scale.as_deref());
    set_map_scalar(frontmatter, "剧情功能", draft.plot_role.as_deref());
    set_map_list(frontmatter, "人物", &draft.people);
    set_map_list(frontmatter, "组织", &draft.organizations);
    set_map_list(frontmatter, "矛盾", &draft.contradictions);
    set_map_list(frontmatter, "单元", &draft.units);
    set_map_list(frontmatter, "伏笔", &draft.foreshadows);
    set_map_list(frontmatter, "时代", &draft.eras);
    set_map_scalar(frontmatter, "当地主线", draft.local_mainline.as_deref());
    set_map_scalar(frontmatter, "秘密", draft.secret.as_deref());
    set_map_scalar(frontmatter, "展开为", draft.expands_to.as_deref());
}

pub fn save_region(
    project: &Path,
    draft: &RegionDraft,
    prev_path: Option<&Path>,
) -> Result<RegionEntry, String> {
    let path = place_path(project, REGION_DIR, &draft.name, prev_path)?;
    let base = prev_path.filter(|p| *p != path).unwrap_or(&path);
    let mut frontmatter = frontmatter_mapping(base).unwrap_or_default();
    apply_region_draft(&mut frontmatter, draft);
    rename_prev(prev_path, &path, REGION_DIR)?;
    write_frontmatter(&path, frontmatter, &draft.body)?;
    Ok(read_region(&path))
}

/// 档案文件的（frontmatter 底图, 正文）；无 frontmatter 或解析失败返回
/// None，由调用方按「原文即正文」降级。
fn place_parts(path: &Path) -> Option<(Mapping, String)> {
    let raw = read_text(path).ok()?;
    let raw = strip_bom(&raw);
    let (yaml, body) = split_frontmatter(raw)?;
    if yaml.trim().is_empty() {
        return Some((Mapping::new(), body));
    }
    match serde_yaml::from_str::<Value>(&yaml) {
        Ok(Value::Mapping(map)) => Some((map, body)),
        _ => None,
    }
}

fn place_raw_body(path: &Path) -> String {
    read_text(path)
        .map(|raw| strip_bom(&raw).to_string())
        .unwrap_or_default()
}

fn place_path(
    project: &Path,
    dir_name: &str,
    raw_name: &str,
    prev_path: Option<&Path>,
) -> Result<PathBuf, String> {
    let name = sanitize_file_name(raw_name)?;
    let dir = project.join(project::CONCEPT_DIR).join(dir_name);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建{dir_name}目录 {}：{e}", dir.display()))?;
    Ok(unique_file_path(&dir, &format!("{name}.md"), prev_path))
}

fn rename_prev(prev_path: Option<&Path>, path: &Path, dir_name: &str) -> Result<(), String> {
    if let Some(prev) = prev_path {
        if prev != path {
            fs::rename(prev, path)
                .map_err(|e| format!("无法移动{dir_name}到 {}：{e}", path.display()))?;
        }
    }
    Ok(())
}

/// 删除一份地图/地域档案。结构表里的引用（包含、关系、转场）不自动
/// 清理——引用失效照常显示缺省节点（spec 地图与地域 §三）。
pub fn delete_place(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("无法删除 {}：{e}", path.display()))
}

/// 地域归属唯一（工单 #65）：设置/改换/跟随改名对账包含行。`prev_region`
/// 是改名前的旧名（与新名相同即普通编辑）；`map_name` 为 None＝移出任何
/// 地图。整表读-合-写，坏结构在读取端先行报错、绝不覆盖。
pub fn set_region_containment(
    project: &Path,
    prev_region: Option<&str>,
    region: &str,
    map_name: Option<&str>,
) -> Result<(), String> {
    let region = region.trim();
    if region.is_empty() {
        return Err("地域名不能为空".into());
    }
    let mut table = read_map_structure(project)?;
    let stale = prev_region
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != region);
    let mut preserved_extra = None;
    table.contains.retain(|row| {
        let name = row.region.trim();
        let replaced = name == region || Some(name) == stale;
        if replaced && preserved_extra.is_none() {
            preserved_extra = Some(row.extra.clone());
        }
        !replaced
    });
    if let Some(map_name) = map_name.map(str::trim).filter(|s| !s.is_empty()) {
        table.contains.push(MapContainment {
            map: map_name.to_string(),
            region: region.to_string(),
            extra: preserved_extra.unwrap_or_default(),
        });
    }
    save_map_structure(project, &table)
}

/// 只改「转场」一节的窄写（工单 #65）：整表从盘上现读、仅替换转场数组、
/// 走同一套校验与读-合-写。页签快照整表回写会吞掉打开期间的外部改动，
/// 这里把覆盖面收窄到这一节。
pub fn save_map_transitions(project: &Path, transitions: &[MapTransition]) -> Result<(), String> {
    let mut table = read_map_structure(project)?;
    table.transitions = transitions.to_vec();
    save_map_structure(project, &table)
}

pub fn map_structure_path(project: &Path) -> PathBuf {
    project.join(project::CONCEPT_DIR).join("地图结构.yaml")
}

fn read_structure_mapping(path: &Path) -> Result<Mapping, String> {
    if !path.is_file() {
        return Ok(Mapping::new());
    }
    let raw = read_text(path)?;
    let value: Value = serde_yaml::from_str(&raw)
        .map_err(|error| format!("无法解析 {}：{error}", path.display()))?;
    value
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("{} 的顶层应为键值表", path.display()))
}

/// 结构文件缺失＝默认图例与空关系（懒生成）；存在但读不懂即报错，保存端
/// 据此拒绝覆盖，避免把作者手写的结构网变成空表。
pub fn read_map_structure(project: &Path) -> Result<MapStructure, String> {
    let path = map_structure_path(project);
    if !path.is_file() {
        return Ok(MapStructure::default());
    }
    let map = read_structure_mapping(&path)?;
    Ok(MapStructure {
        map_legend: legend_from(&map, "地图关系图例", &path)?,
        region_legend: legend_from(&map, "地域关系图例", &path)?,
        map_relations: map_relations_from(&map, &path)?,
        region_relations: region_relations_from(&map, &path)?,
        contains: contains_from(&map, &path)?,
        transitions: transitions_from(&map, &path)?,
        layout: match map.get(Value::String("布局".into())) {
            None | Some(Value::Null) => Mapping::new(),
            Some(Value::Mapping(layout)) => layout.clone(),
            Some(_) => return Err(format!("{} 的「布局」应为键值表", path.display())),
        },
        fingerprint: structure_fingerprint(&path)?,
    })
}

/// 整表读-合-写。顶层未知键不丢；任何既有的语法/形状错误先通过读路径
/// 暴露，绝不在保存时覆盖掉。
pub fn save_map_structure(project: &Path, table: &MapStructure) -> Result<(), String> {
    validate_structure(table)?;
    read_map_structure(project)?;
    let path = map_structure_path(project);
    let parent = path.parent().expect("地图结构有构思目录");
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", parent.display()))?;
    let mut map = read_structure_mapping(&path)?;
    merge_structure_fields(&mut map, table);
    write_yaml_mapping(&path, map)
}

fn merge_structure_fields(map: &mut Mapping, table: &MapStructure) {
    map.insert(key("地图关系图例"), legend_value(&table.map_legend));
    map.insert(key("地域关系图例"), legend_value(&table.region_legend));
    map.insert(key("地图关系"), map_relations_value(&table.map_relations));
    map.insert(
        key("地域关系"),
        region_relations_value(&table.region_relations),
    );
    map.insert(key("包含"), contains_value(&table.contains));
    map.insert(key("转场"), transitions_value(&table.transitions));
    map.insert(key("布局"), Value::Mapping(table.layout.clone()));
}

fn structure_fingerprint(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(content_fingerprint(&bytes).to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 {}：{error}", path.display())),
    }
}

fn assert_structure_version(path: &Path, expected: Option<&str>) -> Result<Mapping, String> {
    if structure_fingerprint(path)?.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    if path.is_file() {
        read_structure_mapping(path)
    } else {
        Ok(Mapping::new())
    }
}

fn seed_structure_if_empty(map: &mut Mapping) {
    let defaults = MapStructure::default();
    merge_structure_fields(map, &defaults);
}

fn read_canvas_scope(
    layout: &Mapping,
    map_name: Option<&str>,
    path: &Path,
) -> Result<Mapping, String> {
    let layer = if map_name.is_some() {
        "地图"
    } else {
        "全书"
    };
    let Some(value) = layout.get(key(layer)) else {
        return Ok(Mapping::new());
    };
    let Value::Mapping(section) = value else {
        return Err(format!("{} 的「布局.{layer}」应为键值表", path.display()));
    };
    let Some(map_name) = map_name else {
        return Ok(section.clone());
    };
    let Some(value) = section.get(key(map_name)) else {
        return Ok(Mapping::new());
    };
    value
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("{} 的「布局.地图.{map_name}」应为键值表", path.display()))
}

fn canvas_scope_mut<'a>(
    layout: &'a mut Mapping,
    map_name: Option<&str>,
) -> Result<&'a mut Mapping, String> {
    let layer = if map_name.is_some() {
        "地图"
    } else {
        "全书"
    };
    let layer_key = key(layer);
    if !layout.contains_key(&layer_key) {
        layout.insert(layer_key.clone(), Value::Mapping(Mapping::new()));
    }
    let section = layout
        .get_mut(&layer_key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| format!("地图结构.yaml 的「布局.{layer}」应为键值表"))?;
    let Some(map_name) = map_name else {
        return Ok(section);
    };
    let map_key = key(map_name);
    if !section.contains_key(&map_key) {
        section.insert(map_key.clone(), Value::Mapping(Mapping::new()));
    }
    section
        .get_mut(&map_key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| format!("地图结构.yaml 的「布局.地图.{map_name}」应为键值表"))
}

fn placement_from_value(
    name: &str,
    value: &Value,
    path: &Path,
) -> Result<MapCanvasPlacement, String> {
    let row = value
        .as_mapping()
        .ok_or_else(|| format!("{} 的画布位置「{name}」应为键值表", path.display()))?;
    let coordinate = |field: &str| -> Result<f64, String> {
        row.get(key(field)).and_then(Value::as_f64).ok_or_else(|| {
            format!(
                "{} 的画布位置「{name}」缺少有效的「{field}」",
                path.display()
            )
        })
    };
    let placement = MapCanvasPlacement {
        name: name.to_string(),
        x: coordinate("x")?,
        y: coordinate("y")?,
        pinned: match row.get(key("固定")) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => {
                return Err(format!(
                    "{} 的画布位置「{name}」的「固定」应为 true/false",
                    path.display()
                ))
            }
        },
    };
    validate_map_placement(&placement)?;
    Ok(placement)
}

fn validate_map_placement(placement: &MapCanvasPlacement) -> Result<(), String> {
    if placement.name.trim().is_empty() {
        return Err("画布节点名不能为空".into());
    }
    if !placement.x.is_finite()
        || !placement.y.is_finite()
        || placement.x < 60.0
        || placement.y < 60.0
        || placement.x > 100_000.0
        || placement.y > 100_000.0
    {
        return Err("画布坐标应在 60 到 100000 之间".into());
    }
    Ok(())
}

fn canvas_node_names(project: &Path, map_name: Option<&str>) -> Result<Vec<String>, String> {
    let workspace = map_workspace(project)?;
    let mut names = if let Some(map_name) = map_name {
        let known: HashSet<String> = workspace
            .regions
            .iter()
            .map(|region| region.name.clone())
            .collect();
        read_map_structure(project)?
            .contains
            .into_iter()
            .filter(|row| row.map == map_name && known.contains(&row.region))
            .map(|row| row.region)
            .collect::<Vec<_>>()
    } else {
        workspace.maps.into_iter().map(|map| map.name).collect()
    };
    names.sort();
    names.dedup();
    Ok(names)
}

fn stored_canvas_positions(scope: &Mapping, path: &Path) -> Vec<MapCanvasPlacement> {
    scope
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str()?;
            let row = value.as_mapping()?;
            if row.get(key("x")).and_then(Value::as_f64).is_none()
                || row.get(key("y")).and_then(Value::as_f64).is_none()
            {
                return None;
            }
            placement_from_value(name, value, path).ok()
        })
        .collect()
}

fn free_map_slot(occupied: &[MapCanvasPlacement]) -> (f64, f64) {
    for index in 0.. {
        let x = 180.0 + (index % 4) as f64 * 280.0;
        let y = 150.0 + (index / 4) as f64 * 190.0;
        if occupied
            .iter()
            .all(|placement| (placement.x - x).abs() >= 230.0 || (placement.y - y).abs() >= 150.0)
        {
            return (x, y);
        }
    }
    unreachable!()
}

/// 读取一层画布布局；档案名按稳定顺序补入空位，失效位置留在 YAML 中但不画出来。
pub fn read_map_canvas_layout(
    project: &Path,
    map_name: Option<&str>,
) -> Result<MapCanvasLayout, String> {
    let table = read_map_structure(project)?;
    let path = map_structure_path(project);
    let scope = read_canvas_scope(&table.layout, map_name, &path)?;
    let stored = stored_canvas_positions(&scope, &path);
    let names = canvas_node_names(project, map_name)?;
    let mut occupied = stored;
    let mut placements = Vec::with_capacity(names.len());
    for name in names {
        let placement = if let Some(value) = scope.get(key(&name)) {
            placement_from_value(&name, value, &path)?
        } else {
            let (x, y) = free_map_slot(&occupied);
            let placement = MapCanvasPlacement {
                name,
                x,
                y,
                pinned: false,
            };
            occupied.push(placement.clone());
            placement
        };
        placements.push(placement);
    }
    Ok(MapCanvasLayout {
        placements,
        fingerprint: table.fingerprint,
    })
}

/// 只更新当前画布层的位置；结构文件带指纹对账，未知节点、未知键和另一层布局原样保留。
pub fn save_map_canvas_layout(
    project: &Path,
    map_name: Option<&str>,
    placements: &[MapCanvasPlacement],
    expected: Option<&str>,
) -> Result<MapCanvasLayout, String> {
    let path = map_structure_path(project);
    let snapshot = read_map_canvas_layout(project, map_name)?;
    if snapshot.fingerprint.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    let mut root = assert_structure_version(&path, expected)?;
    let mut names = HashSet::new();
    for placement in placements {
        validate_map_placement(placement)?;
        if !names.insert(placement.name.as_str()) {
            return Err("画布位置包含重复节点".into());
        }
    }
    let mut layout = match root.get(key("布局")) {
        None | Some(Value::Null) => Mapping::new(),
        Some(Value::Mapping(layout)) => layout.clone(),
        Some(_) => return Err(format!("{} 的「布局」应为键值表", path.display())),
    };
    let scope = canvas_scope_mut(&mut layout, map_name)?;
    for placement in placements {
        let placement_key = key(&placement.name);
        let mut row = scope
            .get(&placement_key)
            .and_then(Value::as_mapping)
            .cloned()
            .unwrap_or_default();
        row.insert(
            key("x"),
            serde_yaml::to_value(placement.x).map_err(|e| e.to_string())?,
        );
        row.insert(
            key("y"),
            serde_yaml::to_value(placement.y).map_err(|e| e.to_string())?,
        );
        row.insert(key("固定"), Value::Bool(placement.pinned));
        scope.insert(placement_key, Value::Mapping(row));
    }
    if root.is_empty() {
        seed_structure_if_empty(&mut root);
    }
    root.insert(key("布局"), Value::Mapping(layout));
    // 在发布前再核对一次，避免准备写入期间另一个编辑器刚好写入结构文件。
    if structure_fingerprint(&path)?.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    let parent = path.parent().expect("地图结构有构思目录");
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", parent.display()))?;
    write_yaml_mapping(&path, root)?;
    read_map_canvas_layout(project, map_name)
}

/// 稳定整理：未固定模式保留固定节点和失效位置；全重排返回的新表可由调用方撤销。
pub fn arrange_map_canvas(
    project: &Path,
    map_name: Option<&str>,
    all: bool,
    expected: Option<&str>,
) -> Result<MapCanvasLayout, String> {
    let current = read_map_canvas_layout(project, map_name)?;
    if current.fingerprint.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    let path = map_structure_path(project);
    let table = read_map_structure(project)?;
    let scope = read_canvas_scope(&table.layout, map_name, &path)?;
    let live: HashSet<String> = current.placements.iter().map(|p| p.name.clone()).collect();
    let mut occupied: Vec<MapCanvasPlacement> = stored_canvas_positions(&scope, &path)
        .into_iter()
        .filter(|placement| !live.contains(&placement.name) || (!all && placement.pinned))
        .collect();
    let mut arranged = current.placements.clone();
    for placement in &mut arranged {
        if !all && placement.pinned {
            continue;
        }
        (placement.x, placement.y) = free_map_slot(&occupied);
        occupied.push(placement.clone());
    }
    save_map_canvas_layout(project, map_name, &arranged, expected)
}

fn edit_relation_section(
    project: &Path,
    section: &str,
    index: Option<usize>,
    next: Option<(&str, &str, &str, &Mapping)>,
    expected: Option<&str>,
) -> Result<MapStructure, String> {
    let path = map_structure_path(project);
    let mut root = assert_structure_version(&path, expected)?;
    let current = if path.is_file() {
        read_map_structure(project)?
    } else {
        MapStructure::default()
    };
    if current.fingerprint.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    let mut rows = match root.get(key(section)) {
        None => Vec::new(),
        Some(Value::Sequence(rows)) => rows.clone(),
        Some(_) => return Err(format!("地图结构.yaml 的「{section}」应为列表")),
    };
    if index.is_some_and(|index| index >= rows.len()) {
        return Err("关系已变化，请刷新画布后重新操作。".into());
    }
    if let Some((from, to, kind, extra)) = next {
        required_values(from, to, kind, section)?;
        let mut row = if let Some(index) = index {
            rows[index]
                .as_mapping()
                .cloned()
                .ok_or_else(|| format!("「{section}」中的关系格式损坏"))?
        } else {
            extra.clone()
        };
        row.insert(key("起"), Value::String(from.trim().into()));
        row.insert(key("止"), Value::String(to.trim().into()));
        row.insert(key("类型"), Value::String(kind.trim().into()));
        if let Some(index) = index {
            rows[index] = Value::Mapping(row);
        } else {
            rows.push(Value::Mapping(row));
        }
    } else if let Some(index) = index {
        rows.remove(index);
    } else {
        return Err("未选择要删除的关系。".into());
    }
    if !path.is_file() {
        seed_structure_if_empty(&mut root);
    }
    root.insert(key(section), Value::Sequence(rows));
    if structure_fingerprint(&path)?.as_deref() != expected {
        return Err("地图结构.yaml 已在应用外发生变化，请刷新画布后重新操作。".into());
    }
    let parent = path.parent().expect("地图结构有构思目录");
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", parent.display()))?;
    write_yaml_mapping(&path, root)?;
    read_map_structure(project)
}

pub fn edit_map_relation(
    project: &Path,
    index: Option<usize>,
    next: Option<&MapRelation>,
    expected: Option<&str>,
) -> Result<MapStructure, String> {
    edit_relation_section(
        project,
        "地图关系",
        index,
        next.map(|r| (r.from.as_str(), r.to.as_str(), r.kind.as_str(), &r.extra)),
        expected,
    )
}

pub fn edit_region_relation(
    project: &Path,
    index: Option<usize>,
    next: Option<&RegionRelation>,
    expected: Option<&str>,
) -> Result<MapStructure, String> {
    edit_relation_section(
        project,
        "地域关系",
        index,
        next.map(|r| (r.from.as_str(), r.to.as_str(), r.kind.as_str(), &r.extra)),
        expected,
    )
}

/// 只允许从当前项目的「附件」中选取地图背景；外部图片不复制也不登记。
pub fn map_background_reference(project: &Path, image_path: &Path) -> Result<String, String> {
    let root = project
        .canonicalize()
        .map_err(|e| format!("无法读取项目目录：{e}"))?;
    let attachments = root
        .join("附件")
        .canonicalize()
        .map_err(|_| "请先把背景图放进当前项目根目录的「附件」文件夹。".to_string())?;
    let image = image_path
        .canonicalize()
        .map_err(|e| format!("无法读取所选图片：{e}"))?;
    if !image.is_file() || !image.starts_with(&attachments) {
        return Err("地图背景只能引用当前项目「附件」文件夹里的图片，不会复制外部文件。".into());
    }
    let extension = image
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Err("地图背景只支持 PNG、JPG、JPEG 或 WebP 图片。".into());
    }
    let project_relative = image
        .strip_prefix(&root)
        .map_err(|_| "所选图片不在当前项目中。".to_string())?;
    Ok(Path::new("..")
        .join("..")
        .join(project_relative)
        .to_string_lossy()
        .replace('\\', "/"))
}

fn key(name: &str) -> Value {
    Value::String(name.to_string())
}

fn legend_from(map: &Mapping, name: &str, path: &Path) -> Result<Vec<SpatialLegendItem>, String> {
    let Some(value) = map.get(key(name)) else {
        return Ok(Vec::new());
    };
    let Value::Sequence(rows) = value else {
        return Err(format!("{} 的「{name}」应为列表", path.display()));
    };
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let Value::Mapping(row) = row else {
                return Err(format!(
                    "{} 的「{name}」第 {} 项应为键值表",
                    path.display(),
                    index + 1
                ));
            };
            let item_name = required(row, "名", path, name, index)?;
            let directed = match row.get(key("有向")) {
                None | Some(Value::Null) => false,
                Some(Value::Bool(value)) => *value,
                Some(_) => {
                    return Err(format!(
                        "{} 的「{name}」第 {} 项「有向」应为 true/false",
                        path.display(),
                        index + 1
                    ))
                }
            };
            let mut extra = row.clone();
            extra.remove(key("名"));
            extra.remove(key("有向"));
            Ok(SpatialLegendItem {
                name: item_name,
                directed,
                extra,
            })
        })
        .collect()
}

fn map_relations_from(map: &Mapping, path: &Path) -> Result<Vec<MapRelation>, String> {
    let Some(value) = map.get(key("地图关系")) else {
        return Ok(Vec::new());
    };
    rows(value, "地图关系", path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut extra = (*row).clone();
            extra.remove(key("起"));
            extra.remove(key("止"));
            extra.remove(key("类型"));
            Ok(MapRelation {
                from: required(row, "起", path, "地图关系", index)?,
                to: required(row, "止", path, "地图关系", index)?,
                kind: required(row, "类型", path, "地图关系", index)?,
                extra,
            })
        })
        .collect()
}

fn region_relations_from(map: &Mapping, path: &Path) -> Result<Vec<RegionRelation>, String> {
    let Some(value) = map.get(key("地域关系")) else {
        return Ok(Vec::new());
    };
    rows(value, "地域关系", path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut extra = (*row).clone();
            extra.remove(key("起"));
            extra.remove(key("止"));
            extra.remove(key("类型"));
            Ok(RegionRelation {
                from: required(row, "起", path, "地域关系", index)?,
                to: required(row, "止", path, "地域关系", index)?,
                kind: required(row, "类型", path, "地域关系", index)?,
                extra,
            })
        })
        .collect()
}

fn contains_from(map: &Mapping, path: &Path) -> Result<Vec<MapContainment>, String> {
    let Some(value) = map.get(key("包含")) else {
        return Ok(Vec::new());
    };
    rows(value, "包含", path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut extra = (*row).clone();
            extra.remove(key("地图"));
            extra.remove(key("地域"));
            Ok(MapContainment {
                map: required(row, "地图", path, "包含", index)?,
                region: required(row, "地域", path, "包含", index)?,
                extra,
            })
        })
        .collect()
}

fn transitions_from(map: &Mapping, path: &Path) -> Result<Vec<MapTransition>, String> {
    let Some(value) = map.get(key("转场")) else {
        return Ok(Vec::new());
    };
    rows(value, "转场", path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut extra = (*row).clone();
            for field in [
                "起",
                "止",
                "离开原因",
                "先行人物",
                "提前线索",
                "随行未解问题",
                "返回条件",
                "单元",
            ] {
                extra.remove(key(field));
            }
            Ok(MapTransition {
                from: required(row, "起", path, "转场", index)?,
                to: required(row, "止", path, "转场", index)?,
                reason: map_scalar(row, "离开原因"),
                advance_people: map_list(row, "先行人物"),
                clues: map_list(row, "提前线索"),
                unresolved: map_list(row, "随行未解问题"),
                return_condition: map_scalar(row, "返回条件"),
                units: map_list(row, "单元"),
                extra,
            })
        })
        .collect()
}

fn rows<'a>(value: &'a Value, name: &str, path: &Path) -> Result<Vec<&'a Mapping>, String> {
    let Value::Sequence(items) = value else {
        return Err(format!("{} 的「{name}」应为列表", path.display()));
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_mapping().ok_or_else(|| {
                format!(
                    "{} 的「{name}」第 {} 项应为键值表",
                    path.display(),
                    index + 1
                )
            })
        })
        .collect()
}

fn required(
    row: &Mapping,
    field: &str,
    path: &Path,
    section: &str,
    index: usize,
) -> Result<String, String> {
    map_scalar(row, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "{} 的「{section}」第 {} 项缺「{field}」",
                path.display(),
                index + 1
            )
        })
}

fn validate_structure(table: &MapStructure) -> Result<(), String> {
    for (section, legend) in [
        ("地图关系图例", &table.map_legend),
        ("地域关系图例", &table.region_legend),
    ] {
        for (index, item) in legend.iter().enumerate() {
            if item.name.trim().is_empty() {
                return Err(format!("「{section}」第 {} 项的名称不能为空", index + 1));
            }
            if legend[..index]
                .iter()
                .any(|earlier| earlier.name.trim() == item.name.trim())
            {
                return Err(format!("「{section}」有重名项「{}」", item.name.trim()));
            }
        }
    }
    for relation in &table.map_relations {
        required_values(&relation.from, &relation.to, &relation.kind, "地图关系")?;
    }
    for relation in &table.region_relations {
        required_values(&relation.from, &relation.to, &relation.kind, "地域关系")?;
    }
    for item in &table.contains {
        required_values(&item.map, &item.region, "包含", "包含")?;
    }
    for transition in &table.transitions {
        required_values(&transition.from, &transition.to, "转场", "转场")?;
        if transition.from.trim() == transition.to.trim() {
            return Err(format!(
                "转场的起止地图不能相同（{}）",
                transition.from.trim()
            ));
        }
    }
    Ok(())
}

fn required_values(from: &str, to: &str, kind: &str, label: &str) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() || kind.trim().is_empty() {
        return Err(format!("{label} 的起、止和类型都不能为空"));
    }
    Ok(())
}

fn legend_value(items: &[SpatialLegendItem]) -> Value {
    Value::Sequence(
        items
            .iter()
            .map(|item| {
                let mut map = item.extra.clone();
                map.insert(key("名"), Value::String(item.name.trim().to_string()));
                map.insert(key("有向"), Value::Bool(item.directed));
                Value::Mapping(map)
            })
            .collect(),
    )
}

fn map_relations_value(items: &[MapRelation]) -> Value {
    Value::Sequence(
        items
            .iter()
            .map(|item| relation_value(&item.from, &item.to, &item.kind, &item.extra))
            .collect(),
    )
}

fn region_relations_value(items: &[RegionRelation]) -> Value {
    Value::Sequence(
        items
            .iter()
            .map(|item| relation_value(&item.from, &item.to, &item.kind, &item.extra))
            .collect(),
    )
}

fn relation_value(from: &str, to: &str, kind: &str, extra: &Mapping) -> Value {
    let mut map = extra.clone();
    map.insert(key("起"), Value::String(from.trim().to_string()));
    map.insert(key("止"), Value::String(to.trim().to_string()));
    map.insert(key("类型"), Value::String(kind.trim().to_string()));
    Value::Mapping(map)
}

fn contains_value(items: &[MapContainment]) -> Value {
    Value::Sequence(
        items
            .iter()
            .map(|item| {
                let mut map = item.extra.clone();
                map.insert(key("地图"), Value::String(item.map.trim().to_string()));
                map.insert(key("地域"), Value::String(item.region.trim().to_string()));
                Value::Mapping(map)
            })
            .collect(),
    )
}

fn transitions_value(items: &[MapTransition]) -> Value {
    Value::Sequence(
        items
            .iter()
            .map(|item| {
                let mut map = item.extra.clone();
                map.insert(key("起"), Value::String(item.from.trim().to_string()));
                map.insert(key("止"), Value::String(item.to.trim().to_string()));
                set_map_scalar(&mut map, "离开原因", item.reason.as_deref());
                set_map_list(&mut map, "先行人物", &item.advance_people);
                set_map_list(&mut map, "提前线索", &item.clues);
                set_map_list(&mut map, "随行未解问题", &item.unresolved);
                set_map_scalar(&mut map, "返回条件", item.return_condition.as_deref());
                set_map_list(&mut map, "单元", &item.units);
                Value::Mapping(map)
            })
            .collect(),
    )
}

/// 只读检查旧「地理」词条可否升级，并列出会创建与备份的确切文件。
/// 这里绝不建目录、写文件或移动旧词条。
pub fn geo_upgrade_preview(
    project: &Path,
    source: &Path,
    target: GeoUpgradeTarget,
) -> Result<GeoUpgradePreview, String> {
    let (source_name, source_raw) = read_legacy_map_source_snapshot(project, source)?;
    let target_path = project
        .join(project::CONCEPT_DIR)
        .join(target.dir_name())
        .join(format!("{source_name}.md"));
    if target_path.exists() {
        return Err(format!(
            "已存在同名{}「{source_name}」，请先改名或确认合并",
            target.dir_name()
        ));
    }
    let backup_path = project
        .join(COMPAT_BACKUP_DIR)
        .join(NoteKind::Worldview.name())
        .join(
            source
                .file_name()
                .ok_or_else(|| "旧词条没有文件名".to_string())?,
        );
    if backup_path.exists() {
        return Err(format!(
            "兼容备份已存在 {}，为避免覆盖请先人工处理",
            backup_path.display()
        ));
    }
    Ok(GeoUpgradePreview {
        source_path: source.to_path_buf(),
        target_path,
        backup_path,
        target,
        source_fingerprint: content_fingerprint(source_raw.as_bytes()).to_string(),
    })
}

/// 执行已确认的升级：核对预览快照后，先把源文件移入备份，再校验被移动
/// 的内容与预览一致，最后原子写入新实体。变更的源文件会恢复原位并拒绝升级。
pub fn confirm_geo_upgrade(
    project: &Path,
    preview: &GeoUpgradePreview,
) -> Result<MapWorkspace, String> {
    let current = geo_upgrade_preview(project, &preview.source_path, preview.target)?;
    if current != *preview {
        return Err("旧词条在预览后已变化，请关闭升级窗口并重新打开，再次预览。".into());
    }
    let raw = read_text(&preview.source_path)?;
    if content_fingerprint(raw.as_bytes()).to_string() != preview.source_fingerprint {
        return Err("旧词条在预览后已变化，请关闭升级窗口并重新打开，再次预览。".into());
    }
    let (mut frontmatter, body) = parse_legacy_geography(&raw, &preview.source_path)?;

    // 「类别: 地理」是旧模型的分类键，不复制为新实体的业务字段；其余
    // 手补键和正文原样进新文件，原文件本身移入兼容备份。
    frontmatter.remove(Value::String("类别".to_string()));
    if let Some(parent) = preview.backup_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建兼容备份目录 {}：{e}", parent.display()))?;
    }
    if preview.target_path.exists() || preview.backup_path.exists() {
        return Err("目标文件或兼容备份已出现，请关闭升级窗口并重新打开，再次预览。".into());
    }
    move_file_new(&preview.source_path, &preview.backup_path).map_err(|e| {
        format!(
            "无法将旧词条移入兼容备份 {}：{e}",
            preview.backup_path.display()
        )
    })?;
    let backup_raw = match read_text(&preview.backup_path) {
        Ok(raw) => raw,
        Err(error) => {
            return Err(restore_geo_source_after_failure(
                &preview.source_path,
                &preview.backup_path,
                format!("无法校验兼容备份：{error}"),
            ))
        }
    };
    if backup_raw != raw {
        return Err(restore_geo_source_after_failure(
            &preview.source_path,
            &preview.backup_path,
            "旧词条在预览后已变化，请关闭升级窗口并重新打开，再次预览。".into(),
        ));
    }
    if let Some(parent) = preview.target_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return Err(restore_geo_source_after_failure(
                &preview.source_path,
                &preview.backup_path,
                format!(
                    "无法创建{}目录 {}：{error}",
                    preview.target.dir_name(),
                    parent.display()
                ),
            ));
        }
    }
    if preview.target_path.exists() {
        return Err(restore_geo_source_after_failure(
            &preview.source_path,
            &preview.backup_path,
            "目标文件在升级期间出现，请重新预览。".into(),
        ));
    }
    if let Err(error) = write_frontmatter_new(&preview.target_path, frontmatter, &body) {
        return Err(restore_geo_source_after_failure(
            &preview.source_path,
            &preview.backup_path,
            format!("写入新{}失败：{error}", preview.target.dir_name()),
        ));
    }
    if preview.source_path.exists() {
        return Err(format!(
            "升级期间原路径出现新文件，已保留该文件及新{}与兼容备份，请关闭并重新打开项目后处理。",
            preview.target.dir_name()
        ));
    }
    map_workspace(project)
}

fn restore_geo_source(source: &Path, backup: &Path) -> Result<(), String> {
    match fs::symlink_metadata(source) {
        Ok(_) => return Err("原路径已有新文件，未覆盖它".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查原路径是否出现新文件：{error}")),
    }
    move_file_new(backup, source).map_err(|e| format!("无法从兼容备份恢复旧词条：{e}"))
}

fn restore_geo_source_after_failure(source: &Path, backup: &Path, failure: String) -> String {
    match restore_geo_source(source, backup) {
        Ok(()) => format!("{failure}；旧词条已恢复"),
        Err(restore) => format!("{failure}；旧内容保留在 {}：{restore}", backup.display()),
    }
}

fn read_legacy_map_source_snapshot(
    project: &Path,
    source: &Path,
) -> Result<(String, String), String> {
    let expected_dir = project
        .join(project::CONCEPT_DIR)
        .join(NoteKind::Worldview.name());
    if source.parent() != Some(expected_dir.as_path()) || !has_md_extension(source) {
        return Err(format!("{} 不是 构思/世界观/ 下的词条", source.display()));
    }
    let raw = read_text(source)?;
    parse_legacy_geography(&raw, source)?;
    let name = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("无法读取词条名：{}", source.display()))?;
    Ok((sanitize_file_name(name)?, raw))
}

/// Rename only when the destination is absent. Supported desktop platforms
/// have native exclusive-rename operations; other platforms fail closed.
fn move_file_new(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "Kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }

        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::raw::{c_char, c_int, c_uint};
        use std::os::unix::ffi::OsStrExt;

        #[link(name = "c")]
        extern "C" {
            fn renameat2(
                old_dirfd: c_int,
                old_path: *const c_char,
                new_dirfd: c_int,
                new_path: *const c_char,
                flags: c_uint,
            ) -> c_int;
        }

        const AT_FDCWD: c_int = -100;
        const RENAME_NOREPLACE: c_uint = 1;
        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "源路径包含 NUL"))?;
        let target = CString::new(target.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "目标路径包含 NUL"))?;
        let result = unsafe {
            renameat2(
                AT_FDCWD,
                source.as_ptr(),
                AT_FDCWD,
                target.as_ptr(),
                RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::ffi::CString;
        use std::os::raw::{c_char, c_int, c_uint};
        use std::os::unix::ffi::OsStrExt;

        #[link(name = "System")]
        extern "C" {
            fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
        }

        const RENAME_EXCL: c_uint = 0x0000_0004;
        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "源路径包含 NUL"))?;
        let target = CString::new(target.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "目标路径包含 NUL"))?;
        let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), RENAME_EXCL) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos", target_os = "ios")))]
    {
        let _ = (source, target);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "当前平台不支持无覆盖原子改名",
        ))
    }
}

static GEO_UPGRADE_TEMP_ID: AtomicU64 = AtomicU64::new(1);

/// Publish a fully written target atomically, but fail if another file already
/// occupies the confirmed destination.
fn write_frontmatter_new(path: &Path, frontmatter: Mapping, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定目标目录：{}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("无法确定目标文件名：{}", path.display()))?;
    let (temporary, file) = loop {
        let id = GEO_UPGRADE_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = file_name.to_os_string();
        temporary_name.push(format!(".gongbi-upgrade-{}-{id}.tmp", std::process::id()));
        let temporary = parent.join(temporary_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建目标临时文件：{error}")),
        }
    };
    drop(file);
    if let Err(error) = write_frontmatter(&temporary, frontmatter, body) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = move_file_new(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法创建目标文件 {}：{error}", path.display()));
    }
    Ok(())
}

fn parse_legacy_geography(raw: &str, path: &Path) -> Result<(Mapping, String), String> {
    let raw = strip_bom(raw);
    let Some((yaml, body)) = split_frontmatter(raw) else {
        return Err(format!("{} 没有可升级的 frontmatter", path.display()));
    };
    let Value::Mapping(map) = serde_yaml::from_str::<Value>(&yaml)
        .map_err(|e| format!("无法解析旧地理词条 {}：{e}", path.display()))?
    else {
        return Err(format!("{} 的 frontmatter 应为键值表", path.display()));
    };
    if map_scalar(&map, "类别").as_deref() != Some("地理") {
        return Err(format!("{} 不是「地理」词条", path.display()));
    }
    Ok((map, body))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_yaml::Mapping;
    use tempfile::tempdir;

    use super::{
        arrange_map_canvas, confirm_geo_upgrade, delete_place, edit_map_relation,
        geo_upgrade_preview, map_background_reference, map_workspace, read_map_canvas_layout,
        read_map_structure, restore_geo_source, save_map, save_map_canvas_layout,
        save_map_structure, save_map_transitions, save_region, set_region_containment,
        write_frontmatter_new, GeoUpgradeTarget, MapCanvasPlacement, MapContainment, MapDraft,
        MapRelation, MapStructure, MapTransition, RegionDraft, RegionRelation,
    };
    use crate::project::{check_project_arrangement, ArrangementItem};

    #[test]
    fn 地理词条升级为地图_预览不落盘_确认后保留未知键与可恢复备份() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let source = project.join("构思/世界观/京城.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(
            &source,
            "---\n类别: 地理\n自定义键: 保留我\n---\n旧城的自由正文。\n",
        )
        .unwrap();

        let preview = geo_upgrade_preview(&project, &source, GeoUpgradeTarget::Map).unwrap();
        assert_eq!(preview.target_path, project.join("构思/地图/京城.md"));
        assert!(source.exists(), "预览绝不能改写旧词条");
        assert!(!preview.target_path.exists(), "预览绝不能创建目标文件");

        let workspace = confirm_geo_upgrade(&project, &preview).unwrap();
        let map = workspace
            .maps
            .iter()
            .find(|map| map.name == "京城")
            .unwrap();
        assert_eq!(map.body, "旧城的自由正文。");
        let target_text = fs::read_to_string(&map.path).unwrap();
        assert!(
            target_text.contains("自定义键: 保留我"),
            "未知键必须保留：{target_text}"
        );
        assert!(!source.exists(), "确认后旧词条应移入兼容备份");
        assert_eq!(
            fs::read_to_string(preview.backup_path).unwrap(),
            "---\n类别: 地理\n自定义键: 保留我\n---\n旧城的自由正文。\n"
        );
        assert_eq!(map_workspace(&project).unwrap().maps.len(), 1);
    }

    #[test]
    fn 地图升级预览后源内容变化_旧预览不能确认() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let source = project.join("构思/世界观/京城.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "---\n类别: 地理\n---\n预览时的正文。\n").unwrap();

        let preview = geo_upgrade_preview(&project, &source, GeoUpgradeTarget::Map).unwrap();
        let changed = "---\n类别: 地理\n---\n预览后新增的正文。\n";
        fs::write(&source, changed).unwrap();

        let error = confirm_geo_upgrade(&project, &preview).unwrap_err();
        assert!(
            error.contains("在预览后已变化"),
            "应明确要求重新预览：{error}"
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), changed);
        assert!(!preview.target_path.exists(), "过期预览不能创建目标文件");
        assert!(!preview.backup_path.exists(), "过期预览不能创建备份");
    }

    #[test]
    fn 地图目录创建失败_恢复旧词条() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let source = project.join("构思/世界观/京城.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let original = "---\n类别: 地理\n---\n旧城的自由正文。\n";
        fs::write(&source, original).unwrap();

        let preview = geo_upgrade_preview(&project, &source, GeoUpgradeTarget::Map).unwrap();
        fs::write(preview.target_path.parent().unwrap(), "阻止创建地图目录").unwrap();

        assert!(confirm_geo_upgrade(&project, &preview).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), original);
        assert!(!preview.backup_path.exists(), "失败后旧词条已恢复");
        assert!(!preview.target_path.exists());
    }

    #[test]
    fn 回滚遇到同名新文件_不覆盖新文件() {
        let root = tempdir().unwrap();
        let source = root.path().join("京城.md");
        let backup = root.path().join("京城.backup.md");
        fs::write(&source, "新文件内容").unwrap();
        fs::write(&backup, "旧文件内容").unwrap();

        assert!(restore_geo_source(&source, &backup).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "新文件内容");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "旧文件内容");
    }

    #[test]
    fn 目标文件在发布时出现_不覆盖现有内容() {
        let root = tempdir().unwrap();
        let target = root.path().join("京城.md");
        fs::write(&target, "并发创建的文件").unwrap();

        assert!(write_frontmatter_new(&target, Mapping::new(), "升级内容").is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "并发创建的文件");
    }

    #[test]
    fn 地图档案_完整字段往返_未知键保留_改名移动_待打磨派生() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let created = save_map(
            &project,
            &MapDraft {
                name: "大墟".into(),
                scale: Some("世界".into()),
                boundary: Some("四周环海，唯一陆桥通外界".into()),
                eras: vec!["上古".into(), "今朝".into()],
                role: Some("核心".into()),
                stage_goal: Some("主角在大墟之外建立自己的力量".into()),
                central_conflict: Some("大墟的真相与外部秩序冲突".into()),
                core_secret: Some("大墟本身就是封印".into()),
                local_mainline: Some("每次远行后回到大墟揭开一层秘密".into()),
                entry_condition: Some("被逐出师门".into()),
                exit_condition: Some("集齐三把钥匙".into()),
                people: vec!["主角".into()],
                organizations: vec!["巡山司".into()],
                units: vec!["初入大墟".into()],
                milestones: vec!["封印松动".into()],
                background_image: None,
                body: "自由正文。".into(),
            },
            None,
        )
        .unwrap();
        assert_eq!(created.pending, false);

        // 模拟 Obsidian 手补：背景图（未管理键）与待打磨布尔键。
        fs::write(
            &created.path,
            "---\n尺度: 世界\n背景图: ../附件/大墟.webp\n待打磨: true\n---\n手补过的\n",
        )
        .unwrap();
        let workspace = map_workspace(&project).unwrap();
        let reloaded = workspace.maps.iter().find(|m| m.name == "大墟").unwrap();
        assert_eq!(reloaded.pending, true, "待打磨布尔键应派生进读模型");

        // 编辑（改名）：frontmatter 以现有文件为底，背景图与待打磨键存活。
        let saved = save_map(
            &project,
            &MapDraft {
                name: "大墟世界".into(),
                scale: Some("世界".into()),
                background_image: Some("../附件/大墟.webp".into()),
                ..MapDraft::default()
            },
            Some(&created.path),
        )
        .unwrap();
        assert_eq!(saved.name, "大墟世界");
        assert!(!created.path.exists(), "改名＝文件移动，不留旧文件");
        let text = fs::read_to_string(&saved.path).unwrap();
        assert!(
            text.contains("背景图: ../附件/大墟.webp"),
            "未管理键必须保留：{text}"
        );
        assert_eq!(
            saved.pending, true,
            "待打磨是 frontmatter 键，编辑后照常存活"
        );

        // 删除档案：文件移除；结构引用不自动清理（spec §三）。
        delete_place(&saved.path).unwrap();
        assert!(!saved.path.exists());
    }

    #[test]
    fn 地域档案_完整字段往返_含展开为与归属唯一() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(
            &project,
            &MapDraft {
                name: "人间".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_map(
            &project,
            &MapDraft {
                name: "仙界".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        let region = save_region(
            &project,
            &RegionDraft {
                name: "京城".into(),
                scale: Some("城市".into()),
                plot_role: Some("权力中心与身份危机的主舞台".into()),
                people: vec!["主角".into(), "皇后".into()],
                organizations: vec!["新朝".into(), "前朝暗线".into()],
                contradictions: vec!["潜伏京城".into()],
                units: vec!["初入京城".into()],
                foreshadows: vec!["皇城地宫".into()],
                eras: vec!["开国时代".into()],
                local_mainline: Some("在新朝眼皮底下站稳脚跟".into()),
                secret: Some("地宫里躺着前朝真龙".into()),
                expands_to: Some("京城地图".into()),
                body: "氛围与视觉印象。".into(),
            },
            None,
        )
        .unwrap();
        let workspace = map_workspace(&project).unwrap();
        let got = workspace.regions.iter().find(|r| r.name == "京城").unwrap();
        assert_eq!(got, &region, "读模型与保存结果一致（没有第二份内容）");

        // 归属唯一：先归人间再改仙界，包含表里只有一行；改名时旧名行跟着对账。
        set_region_containment(&project, None, "京城", Some("人间")).unwrap();
        let mut seeded = read_map_structure(&project).unwrap();
        seeded.contains[0].extra.insert(
            serde_yaml::Value::String("备注".into()),
            serde_yaml::Value::String("手写包含说明".into()),
        );
        save_map_structure(&project, &seeded).unwrap();
        let table = read_map_structure(&project).unwrap();
        assert_eq!(table.contains.len(), 1);
        set_region_containment(&project, Some("京城"), "京城", Some("仙界")).unwrap();
        let table = read_map_structure(&project).unwrap();
        assert_eq!(table.contains.len(), 1, "换地图＝替换包含行，不是叠加");
        assert_eq!(table.contains[0].map, "仙界");
        assert_eq!(
            table.contains[0]
                .extra
                .get(serde_yaml::Value::String("备注".into())),
            Some(&serde_yaml::Value::String("手写包含说明".into())),
            "换归属只改受管字段，包含行的未知键必须保留",
        );
        set_region_containment(&project, Some("京城"), "皇城", Some("仙界")).unwrap();
        let table = read_map_structure(&project).unwrap();
        assert_eq!(
            table.contains.len(),
            1,
            "改名对账：旧名行替换成新名，不留两行"
        );
        assert_eq!(table.contains[0].region, "皇城");
        set_region_containment(&project, Some("皇城"), "皇城", None).unwrap();
        let table = read_map_structure(&project).unwrap();
        assert!(table.contains.is_empty(), "None＝移出任何地图");
    }

    #[test]
    fn 转场窄写_只动转场节_外部改动的包含行不丢() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let seeded = MapStructure {
            contains: vec![MapContainment {
                map: "人间".into(),
                region: "京城".into(),
                extra: Mapping::new(),
            }],
            ..MapStructure::default()
        };
        save_map_structure(&project, &seeded).unwrap();

        // 保存端拿的是旧快照时也只覆盖转场节：现读盘上的包含行原样保留。
        save_map_transitions(
            &project,
            &[MapTransition {
                from: "人间".into(),
                to: "仙界".into(),
                reason: Some("寻找师父".into()),
                ..MapTransition::default()
            }],
        )
        .unwrap();
        let table = read_map_structure(&project).unwrap();
        assert_eq!(table.contains, seeded.contains, "窄写不得吞掉外部改动");
        assert_eq!(table.transitions.len(), 1);
        assert_eq!(table.transitions[0].reason.as_deref(), Some("寻找师父"));

        // 校验照常：起止同图仍拒绝落盘。
        assert!(save_map_transitions(
            &project,
            &[MapTransition {
                from: "人间".into(),
                to: "人间".into(),
                ..MapTransition::default()
            }]
        )
        .is_err());
    }

    #[test]
    fn 地图地域与转场_各自落在对应实体与结构字段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(
            &project,
            &MapDraft {
                name: "人间".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_map(
            &project,
            &MapDraft {
                name: "仙界".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_region(
            &project,
            &RegionDraft {
                name: "京城".into(),
                ..RegionDraft::default()
            },
            None,
        )
        .unwrap();

        let table = MapStructure {
            contains: vec![MapContainment {
                map: "人间".into(),
                region: "京城".into(),
                extra: Mapping::new(),
            }],
            region_relations: vec![RegionRelation {
                from: "京城".into(),
                to: "皇城".into(),
                kind: "相邻".into(),
                extra: Mapping::new(),
            }],
            transitions: vec![MapTransition {
                from: "人间".into(),
                to: "仙界".into(),
                reason: Some("寻找师父".into()),
                ..MapTransition::default()
            }],
            ..MapStructure::default()
        };
        save_map_structure(&project, &table).unwrap();

        let workspace = map_workspace(&project).unwrap();
        assert_eq!(workspace.maps.len(), 2);
        assert_eq!(workspace.regions.len(), 1);
        let reloaded = read_map_structure(&project).unwrap();
        assert_eq!(reloaded.contains, table.contains);
        assert_eq!(reloaded.region_relations, table.region_relations);
        assert_eq!(reloaded.transitions, table.transitions);
        assert!(
            !reloaded.transitions[0]
                .reason
                .as_deref()
                .unwrap()
                .is_empty(),
            "转场必须是地图间叙事承接，不能混进地域连接"
        );
    }

    #[test]
    fn 排布地图引用_同时兼容旧项目清单与新地图实体() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("项目.yaml"), "地图:\n  - 旧江南\n").unwrap();
        save_map(
            &project,
            &MapDraft {
                name: "新京城".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();

        let check = check_project_arrangement(
            &project,
            &[
                ArrangementItem {
                    unit: "旧单元".into(),
                    line: None,
                    map: Some("旧江南".into()),
                    upgrade_battle: None,
                    pace: None,
                    extra: Mapping::new(),
                },
                ArrangementItem {
                    unit: "新单元".into(),
                    line: None,
                    map: Some("新京城".into()),
                    upgrade_battle: None,
                    pace: None,
                    extra: Mapping::new(),
                },
            ],
        )
        .unwrap();
        assert!(
            check.ref_hints.is_empty(),
            "新旧地图名都应是可读引用：{:?}",
            check.ref_hints
        );
    }

    #[test]
    fn 地图结构_自定义地域关系仍可读写_损坏文件拒绝覆盖() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let custom = MapStructure {
            region_relations: vec![RegionRelation {
                from: "京城".into(),
                to: "地宫".into(),
                kind: "暗河".into(),
                extra: Mapping::new(),
            }],
            ..MapStructure::default()
        };
        save_map_structure(&project, &custom).unwrap();
        assert_eq!(
            read_map_structure(&project).unwrap().region_relations,
            custom.region_relations
        );

        let structure_path = super::map_structure_path(&project);
        fs::write(&structure_path, "地域关系: [\n").unwrap();
        let before = fs::read_to_string(&structure_path).unwrap();
        assert!(
            save_map_structure(&project, &custom).is_err(),
            "损坏结构绝不能被保存覆盖"
        );
        assert_eq!(fs::read_to_string(&structure_path).unwrap(), before);
    }

    #[test]
    fn 地图结构_合法非键值表与行内未知键均不应被静默覆盖() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let structure_path = super::map_structure_path(&project);
        fs::create_dir_all(structure_path.parent().unwrap()).unwrap();
        fs::write(&structure_path, "- 不是结构键值表\n").unwrap();
        let before = fs::read_to_string(&structure_path).unwrap();
        assert!(save_map_structure(&project, &MapStructure::default()).is_err());
        assert_eq!(fs::read_to_string(&structure_path).unwrap(), before);

        fs::write(
            &structure_path,
            "转场:\n  - 起: 人间\n    止: 仙界\n    自定义备注: 留在这里\n",
        )
        .unwrap();
        let table = read_map_structure(&project).unwrap();
        save_map_structure(&project, &table).unwrap();
        assert!(
            fs::read_to_string(&structure_path)
                .unwrap()
                .contains("自定义备注: 留在这里"),
            "读-合-写必须保留结构项内的未知字段"
        );
    }

    #[test]
    fn 地图画布布局_保存重读且保留另一层布局与未知键() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(
            &project,
            &MapDraft {
                name: "人间".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_map(
            &project,
            &MapDraft {
                name: "仙界".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_region(
            &project,
            &RegionDraft {
                name: "京城".into(),
                ..RegionDraft::default()
            },
            None,
        )
        .unwrap();
        set_region_containment(&project, None, "京城", Some("人间")).unwrap();

        let path = super::map_structure_path(&project);
        let mut root_map = super::read_structure_mapping(&path).unwrap();
        root_map.insert(
            serde_yaml::Value::String("作者手补".into()),
            serde_yaml::Value::String("保留".into()),
        );
        let mut layout = root_map
            .get(serde_yaml::Value::String("布局".into()))
            .unwrap()
            .as_mapping()
            .unwrap()
            .clone();
        let mut map_layer = Mapping::new();
        map_layer.insert(
            serde_yaml::Value::String("手工注释".into()),
            serde_yaml::Value::String("保留地域布局".into()),
        );
        layout.insert(
            serde_yaml::Value::String("地图".into()),
            serde_yaml::Value::Mapping(map_layer),
        );
        root_map.insert(
            serde_yaml::Value::String("布局".into()),
            serde_yaml::Value::Mapping(layout),
        );
        super::write_yaml_mapping(&path, root_map).unwrap();

        let mut book = read_map_canvas_layout(&project, None).unwrap();
        assert_eq!(book.placements.len(), 2);
        book.placements[0].x = 640.0;
        book.placements[0].y = 420.0;
        book.placements[0].pinned = true;
        let saved = save_map_canvas_layout(
            &project,
            None,
            &book.placements,
            book.fingerprint.as_deref(),
        )
        .unwrap();
        assert_eq!(saved.placements[0].x, 640.0);

        let value: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let top = value.as_mapping().unwrap();
        assert_eq!(
            top.get(serde_yaml::Value::String("作者手补".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("保留")
        );
        let saved_layout = top
            .get(serde_yaml::Value::String("布局".into()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(
            saved_layout
                .get(serde_yaml::Value::String("地图".into()))
                .unwrap()
                .as_mapping()
                .unwrap()
                .get(serde_yaml::Value::String("手工注释".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("保留地域布局"),
        );

        let mut regions = read_map_canvas_layout(&project, Some("人间")).unwrap();
        assert_eq!(regions.placements.len(), 1);
        regions.placements[0].x = 900.0;
        save_map_canvas_layout(
            &project,
            Some("人间"),
            &regions.placements,
            regions.fingerprint.as_deref(),
        )
        .unwrap();
        let reread = read_map_canvas_layout(&project, None).unwrap();
        assert_eq!(
            reread.placements[0].x, 640.0,
            "地域画布保存不能移动全书层节点"
        );
    }

    #[test]
    fn 地图画布整理_只移动未固定节点且全部重排稳定保留固定标记() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(
            &project,
            &MapDraft {
                name: "人间".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        save_map(
            &project,
            &MapDraft {
                name: "仙界".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        let mut layout = read_map_canvas_layout(&project, None).unwrap();
        layout.placements[0] = MapCanvasPlacement {
            name: "人间".into(),
            x: 840.0,
            y: 620.0,
            pinned: true,
        };
        layout.placements[1] = MapCanvasPlacement {
            name: "仙界".into(),
            x: 840.0,
            y: 620.0,
            pinned: false,
        };
        let saved = save_map_canvas_layout(
            &project,
            None,
            &layout.placements,
            layout.fingerprint.as_deref(),
        )
        .unwrap();

        let arranged =
            arrange_map_canvas(&project, None, false, saved.fingerprint.as_deref()).unwrap();
        let pinned = arranged
            .placements
            .iter()
            .find(|p| p.name == "人间")
            .unwrap();
        let moved = arranged
            .placements
            .iter()
            .find(|p| p.name == "仙界")
            .unwrap();
        assert_eq!((pinned.x, pinned.y), (840.0, 620.0));
        assert_ne!((moved.x, moved.y), (840.0, 620.0));

        let all =
            arrange_map_canvas(&project, None, true, arranged.fingerprint.as_deref()).unwrap();
        assert!(
            all.placements
                .iter()
                .find(|p| p.name == "人间")
                .unwrap()
                .pinned
        );
        let repeated =
            arrange_map_canvas(&project, None, true, all.fingerprint.as_deref()).unwrap();
        assert_eq!(
            all.placements, repeated.placements,
            "同一输入的完整重排应稳定"
        );
    }

    #[test]
    fn 地图画布布局_结构文件外部变化时拒绝覆盖() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(
            &project,
            &MapDraft {
                name: "人间".into(),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        let mut layout = read_map_canvas_layout(&project, None).unwrap();
        let path = super::map_structure_path(&project);
        fs::write(&path, "作者手补: 外部更新\n").unwrap();
        let before = fs::read(&path).unwrap();
        layout.placements[0].x = 950.0;
        assert!(save_map_canvas_layout(
            &project,
            None,
            &layout.placements,
            layout.fingerprint.as_deref()
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "冲突时不得覆盖外部文件");
    }

    #[test]
    fn 地图关系画布_创建编辑删除保留未知键() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let mut extra = Mapping::new();
        extra.insert(
            serde_yaml::Value::String("手补说明".into()),
            serde_yaml::Value::String("核心出入口".into()),
        );
        let saved = edit_map_relation(
            &project,
            None,
            Some(&MapRelation {
                from: "人间".into(),
                to: "仙界".into(),
                kind: "核心附属".into(),
                extra: extra.clone(),
            }),
            None,
        )
        .unwrap();
        assert_eq!(
            saved.map_relations[0]
                .extra
                .get(serde_yaml::Value::String("手补说明".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("核心出入口")
        );
        let changed = edit_map_relation(
            &project,
            Some(0),
            Some(&MapRelation {
                from: "仙界".into(),
                to: "人间".into(),
                kind: "上下层".into(),
                extra: Mapping::new(),
            }),
            saved.fingerprint.as_deref(),
        )
        .unwrap();
        assert_eq!(changed.map_relations[0].kind, "上下层");
        assert_eq!(
            changed.map_relations[0]
                .extra
                .get(serde_yaml::Value::String("手补说明".into()))
                .and_then(serde_yaml::Value::as_str),
            Some("核心出入口")
        );
        let deleted =
            edit_map_relation(&project, Some(0), None, changed.fingerprint.as_deref()).unwrap();
        assert!(deleted.map_relations.is_empty());
    }

    #[test]
    fn 地图背景_只引用项目附件并在缺图时保留引用() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        let image = project.join("附件/地图/大墟.webp");
        fs::create_dir_all(image.parent().unwrap()).unwrap();
        fs::write(&image, b"image bytes").unwrap();
        let reference = map_background_reference(&project, &image).unwrap();
        assert_eq!(reference, "../../附件/地图/大墟.webp");
        let outside = root.path().join("外部.png");
        fs::write(&outside, b"external").unwrap();
        assert!(map_background_reference(&project, &outside).is_err());

        let map = save_map(
            &project,
            &MapDraft {
                name: "大墟".into(),
                background_image: Some(reference.clone()),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        let expected_image = image.canonicalize().unwrap();
        assert_eq!(
            map.background_image_path.as_deref(),
            Some(expected_image.as_path())
        );
        let legacy = save_map(
            &project,
            &MapDraft {
                name: "旧规格路径".into(),
                background_image: Some("../附件/地图/大墟.webp".into()),
                ..MapDraft::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(
            legacy.background_image_path.as_deref(),
            Some(expected_image.as_path()),
            "最初规格中的附件路径示例仍可显示"
        );
        fs::remove_file(&image).unwrap();
        let missing = map_workspace(&project).unwrap().maps.remove(0);
        assert_eq!(
            missing.background_image.as_deref(),
            Some(reference.as_str())
        );
        assert!(
            missing.background_image_path.is_none(),
            "缺图只影响背景，不清除地图档案引用"
        );
    }
}
