//! 地图、地域与转场（工单 #61，docs/spec/地图与地域.md）。
//!
//! 地图和地域各自是一文件实体；`地图结构.yaml` 只保存它们之间的
//! 包含、关系、转场及画布布局。旧世界观「地理」词条只读兼容，升级须先
//! 预览，再由调用方显式确认；确认后旧文件移入项目内可恢复的兼容备份。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{
    has_md_extension, is_hidden, map_list, map_scalar, read_text,
    sanitize_file_name, set_map_list, set_map_scalar, split_frontmatter,
    strip_bom, write_frontmatter, write_text_atomic, write_yaml_mapping,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEntry {
    pub path: PathBuf,
    pub name: String,
    pub scale: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDraft {
    pub name: String,
    pub scale: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionEntry {
    pub path: PathBuf,
    pub name: String,
    pub scale: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionDraft {
    pub name: String,
    pub scale: Option<String>,
    pub body: String,
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
}

impl Default for MapStructure {
    fn default() -> Self {
        Self {
            map_legend: vec![
                SpatialLegendItem { name: "核心附属".into(), directed: true, extra: Mapping::new() },
                SpatialLegendItem { name: "上下层".into(), directed: true, extra: Mapping::new() },
            ],
            region_legend: vec![
                SpatialLegendItem { name: "包含".into(), directed: true, extra: Mapping::new() },
                SpatialLegendItem { name: "相邻".into(), directed: false, extra: Mapping::new() },
                SpatialLegendItem { name: "通道".into(), directed: false, extra: Mapping::new() },
                SpatialLegendItem { name: "往返".into(), directed: false, extra: Mapping::new() },
                SpatialLegendItem { name: "隐秘联系".into(), directed: false, extra: Mapping::new() },
            ],
            map_relations: Vec::new(),
            region_relations: Vec::new(),
            contains: Vec::new(),
            transitions: Vec::new(),
            layout: Mapping::new(),
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
        name: path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        scale: None,
        body: String::new(),
    };
    let Ok(raw) = read_text(path) else {
        return entry;
    };
    let raw = strip_bom(&raw);
    let Some((yaml, body)) = split_frontmatter(raw) else {
        entry.body = raw.to_string();
        return entry;
    };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(&yaml) else {
        entry.body = raw.to_string();
        return entry;
    };
    entry.scale = map_scalar(&map, "尺度");
    entry.body = body;
    entry
}

pub fn save_map(project: &Path, draft: &MapDraft) -> Result<MapEntry, String> {
    let path = save_place(project, MAP_DIR, &draft.name, draft.scale.as_deref(), &draft.body)?;
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
    let map = read_map(path);
    RegionEntry { path: map.path, name: map.name, scale: map.scale, body: map.body }
}

pub fn save_region(project: &Path, draft: &RegionDraft) -> Result<RegionEntry, String> {
    let path = save_place(project, REGION_DIR, &draft.name, draft.scale.as_deref(), &draft.body)?;
    Ok(read_region(&path))
}

fn save_place(
    project: &Path,
    dir_name: &str,
    raw_name: &str,
    scale: Option<&str>,
    body: &str,
) -> Result<PathBuf, String> {
    let name = sanitize_file_name(raw_name)?;
    let dir = project.join(project::CONCEPT_DIR).join(dir_name);
    let path = dir.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!("已存在同名{dir_name}「{name}」"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建{dir_name}目录 {}：{e}", dir.display()))?;
    let mut frontmatter = Mapping::new();
    set_map_scalar(&mut frontmatter, "尺度", scale);
    write_frontmatter(&path, frontmatter, body)?;
    Ok(path)
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
    })
}

/// 整表读-合-写。顶层未知键不丢；任何既有的语法/形状错误先通过读路径
/// 暴露，绝不在保存时覆盖掉。
pub fn save_map_structure(project: &Path, table: &MapStructure) -> Result<(), String> {
    validate_structure(table)?;
    read_map_structure(project)?;
    let path = map_structure_path(project);
    let parent = path.parent().expect("地图结构有构思目录");
    fs::create_dir_all(parent).map_err(|e| format!("无法创建构思目录 {}：{e}", parent.display()))?;
    let mut map = read_structure_mapping(&path)?;
    map.insert(Value::String("地图关系图例".into()), legend_value(&table.map_legend));
    map.insert(Value::String("地域关系图例".into()), legend_value(&table.region_legend));
    map.insert(Value::String("地图关系".into()), map_relations_value(&table.map_relations));
    map.insert(Value::String("地域关系".into()), region_relations_value(&table.region_relations));
    map.insert(Value::String("包含".into()), contains_value(&table.contains));
    map.insert(Value::String("转场".into()), transitions_value(&table.transitions));
    map.insert(Value::String("布局".into()), Value::Mapping(table.layout.clone()));
    write_yaml_mapping(&path, map)
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
                return Err(format!("{} 的「{name}」第 {} 项应为键值表", path.display(), index + 1));
            };
            let item_name = required(row, "名", path, name, index)?;
            let directed = match row.get(key("有向")) {
                None | Some(Value::Null) => false,
                Some(Value::Bool(value)) => *value,
                Some(_) => return Err(format!("{} 的「{name}」第 {} 项「有向」应为 true/false", path.display(), index + 1)),
            };
            let mut extra = row.clone();
            extra.remove(key("名"));
            extra.remove(key("有向"));
            Ok(SpatialLegendItem { name: item_name, directed, extra })
        })
        .collect()
}

fn map_relations_from(map: &Mapping, path: &Path) -> Result<Vec<MapRelation>, String> {
    let Some(value) = map.get(key("地图关系")) else { return Ok(Vec::new()) };
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
    let Some(value) = map.get(key("地域关系")) else { return Ok(Vec::new()) };
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
    let Some(value) = map.get(key("包含")) else { return Ok(Vec::new()) };
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
    let Some(value) = map.get(key("转场")) else { return Ok(Vec::new()) };
    rows(value, "转场", path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut extra = (*row).clone();
            for field in ["起", "止", "离开原因", "先行人物", "提前线索", "随行未解问题", "返回条件", "单元"] {
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
        .map(|(index, item)| item.as_mapping().ok_or_else(|| {
            format!("{} 的「{name}」第 {} 项应为键值表", path.display(), index + 1)
        }))
        .collect()
}

fn required(row: &Mapping, field: &str, path: &Path, section: &str, index: usize) -> Result<String, String> {
    map_scalar(row, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{} 的「{section}」第 {} 项缺「{field}」", path.display(), index + 1))
}

fn validate_structure(table: &MapStructure) -> Result<(), String> {
    for (section, legend) in [("地图关系图例", &table.map_legend), ("地域关系图例", &table.region_legend)] {
        for (index, item) in legend.iter().enumerate() {
            if item.name.trim().is_empty() {
                return Err(format!("「{section}」第 {} 项的名称不能为空", index + 1));
            }
            if legend[..index].iter().any(|earlier| earlier.name.trim() == item.name.trim()) {
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
            return Err(format!("转场的起止地图不能相同（{}）", transition.from.trim()));
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
    Value::Sequence(items.iter().map(|item| {
        let mut map = item.extra.clone();
        map.insert(key("名"), Value::String(item.name.trim().to_string()));
        map.insert(key("有向"), Value::Bool(item.directed));
        Value::Mapping(map)
    }).collect())
}

fn map_relations_value(items: &[MapRelation]) -> Value {
    Value::Sequence(items.iter().map(|item| relation_value(&item.from, &item.to, &item.kind, &item.extra)).collect())
}

fn region_relations_value(items: &[RegionRelation]) -> Value {
    Value::Sequence(items.iter().map(|item| relation_value(&item.from, &item.to, &item.kind, &item.extra)).collect())
}

fn relation_value(from: &str, to: &str, kind: &str, extra: &Mapping) -> Value {
    let mut map = extra.clone();
    map.insert(key("起"), Value::String(from.trim().to_string()));
    map.insert(key("止"), Value::String(to.trim().to_string()));
    map.insert(key("类型"), Value::String(kind.trim().to_string()));
    Value::Mapping(map)
}

fn contains_value(items: &[MapContainment]) -> Value {
    Value::Sequence(items.iter().map(|item| {
        let mut map = item.extra.clone();
        map.insert(key("地图"), Value::String(item.map.trim().to_string()));
        map.insert(key("地域"), Value::String(item.region.trim().to_string()));
        Value::Mapping(map)
    }).collect())
}

fn transitions_value(items: &[MapTransition]) -> Value {
    Value::Sequence(items.iter().map(|item| {
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
    }).collect())
}

/// 只读检查旧「地理」词条可否升级，并列出会创建与备份的确切文件。
/// 这里绝不建目录、写文件或移动旧词条。
pub fn geo_upgrade_preview(
    project: &Path,
    source: &Path,
    target: GeoUpgradeTarget,
) -> Result<GeoUpgradePreview, String> {
    let source_name = legacy_geography_name(project, source)?;
    let target_path = project
        .join(project::CONCEPT_DIR)
        .join(target.dir_name())
        .join(format!("{source_name}.md"));
    if target_path.exists() {
        return Err(format!("已存在同名{}「{source_name}」，请先改名或确认合并", target.dir_name()));
    }
    let backup_path = project
        .join(COMPAT_BACKUP_DIR)
        .join(NoteKind::Worldview.name())
        .join(source.file_name().ok_or_else(|| "旧词条没有文件名".to_string())?);
    if backup_path.exists() {
        return Err(format!("兼容备份已存在 {}，为避免覆盖请先人工处理", backup_path.display()));
    }
    Ok(GeoUpgradePreview {
        source_path: source.to_path_buf(),
        target_path,
        backup_path,
        target,
    })
}

/// 执行已确认的升级：先写不可覆盖的备份与新实体，再删除旧词条。每个新
/// 文件都经原子写；任何失败都会保留旧来源或兼容备份，不会静默丢内容。
pub fn confirm_geo_upgrade(
    project: &Path,
    source: &Path,
    target: GeoUpgradeTarget,
) -> Result<MapWorkspace, String> {
    let preview = geo_upgrade_preview(project, source, target)?;
    let raw = read_text(source)?;
    let (mut frontmatter, body) = parse_legacy_geography(&raw, source)?;

    // 「类别: 地理」是旧模型的分类键，不复制为新实体的业务字段；其余
    // 手补键和正文原样进新文件，同时整份旧文件进入兼容备份以便恢复。
    frontmatter.remove(Value::String("类别".to_string()));
    if let Some(parent) = preview.backup_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建兼容备份目录 {}：{e}", parent.display()))?;
    }
    write_text_atomic(&preview.backup_path, &raw)?;
    if let Some(parent) = preview.target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建{}目录 {}：{e}", target.dir_name(), parent.display()))?;
    }
    write_frontmatter(&preview.target_path, frontmatter, &body)?;
    fs::remove_file(source)
        .map_err(|e| format!("新{}已创建，旧词条未能移入备份：{e}", target.dir_name()))?;
    map_workspace(project)
}

fn legacy_geography_name(project: &Path, source: &Path) -> Result<String, String> {
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
    sanitize_file_name(name)
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
        confirm_geo_upgrade, geo_upgrade_preview, map_workspace, read_map_structure, save_map,
        save_map_structure, save_region, GeoUpgradeTarget, MapDraft, MapStructure,
        MapContainment, MapTransition, RegionDraft, RegionRelation,
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

        let workspace = confirm_geo_upgrade(&project, &source, GeoUpgradeTarget::Map).unwrap();
        let map = workspace.maps.iter().find(|map| map.name == "京城").unwrap();
        assert_eq!(map.body, "旧城的自由正文。");
        let target_text = fs::read_to_string(&map.path).unwrap();
        assert!(target_text.contains("自定义键: 保留我"), "未知键必须保留：{target_text}");
        assert!(!source.exists(), "确认后旧词条应移入兼容备份");
        assert_eq!(
            fs::read_to_string(preview.backup_path).unwrap(),
            "---\n类别: 地理\n自定义键: 保留我\n---\n旧城的自由正文。\n"
        );
        assert_eq!(map_workspace(&project).unwrap().maps.len(), 1);
    }

    #[test]
    fn 地图地域与转场_各自落在对应实体与结构字段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        save_map(&project, &MapDraft { name: "人间".into(), scale: None, body: String::new() }).unwrap();
        save_map(&project, &MapDraft { name: "仙界".into(), scale: None, body: String::new() }).unwrap();
        save_region(&project, &RegionDraft { name: "京城".into(), scale: None, body: String::new() }).unwrap();

        let table = MapStructure {
            contains: vec![MapContainment { map: "人间".into(), region: "京城".into(), extra: Mapping::new() }],
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
            !reloaded.transitions[0].reason.as_deref().unwrap().is_empty(),
            "转场必须是地图间叙事承接，不能混进地域连接"
        );
    }

    #[test]
    fn 排布地图引用_同时兼容旧项目清单与新地图实体() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《山河》");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("项目.yaml"), "地图:\n  - 旧江南\n").unwrap();
        save_map(&project, &MapDraft { name: "新京城".into(), scale: None, body: String::new() }).unwrap();

        let check = check_project_arrangement(
            &project,
            &[
                ArrangementItem { unit: "旧单元".into(), line: None, map: Some("旧江南".into()), upgrade_battle: None, pace: None, extra: Mapping::new() },
                ArrangementItem { unit: "新单元".into(), line: None, map: Some("新京城".into()), upgrade_battle: None, pace: None, extra: Mapping::new() },
            ],
        )
        .unwrap();
        assert!(check.ref_hints.is_empty(), "新旧地图名都应是可读引用：{:?}", check.ref_hints);
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
        assert_eq!(read_map_structure(&project).unwrap().region_relations, custom.region_relations);

        let structure_path = super::map_structure_path(&project);
        fs::write(&structure_path, "地域关系: [\n").unwrap();
        let before = fs::read_to_string(&structure_path).unwrap();
        assert!(save_map_structure(&project, &custom).is_err(), "损坏结构绝不能被保存覆盖");
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
            fs::read_to_string(&structure_path).unwrap().contains("自定义备注: 留在这里"),
            "读-合-写必须保留结构项内的未知字段"
        );
    }
}
