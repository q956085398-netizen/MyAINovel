//! 构思规划边界：大纲纸面、主线里程碑，以及后续桥段库都从这里读写。
//!
//! 缺失的规划文件代表尚未开始，不是错误；所有写入遵循 ADR 0004 的原子写。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

pub const OUTLINE_FILE: &str = "大纲.md";
pub const MAINLINES_FILE: &str = "主线.yaml";
pub const BRIDGES_DIR: &str = "桥段";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outline {
    pub body: String,
    /// 长活大纲纸面的版本指纹（ADR 0004）；缺文件为 None。
    pub fingerprint: Option<String>,
}

pub fn read_outline(_project: &Path) -> Result<Outline, String> {
    let path = _project
        .join(crate::project::CONCEPT_DIR)
        .join(OUTLINE_FILE);
    if !path.exists() {
        return Ok(Outline::default());
    }
    fs::read(&path)
        .map(|bytes| Outline {
            fingerprint: Some(crate::book_file::content_fingerprint(&bytes).to_string()),
            body: String::from_utf8_lossy(&bytes).into_owned(),
        })
        .map_err(|e| format!("无法读取文件 {}：{e}", path.display()))
}

/// 大纲纸面是长活缓冲：落盘前以载入时内容指纹对账，拒绝静默覆盖外部修改。
pub fn save_outline(
    project: &Path,
    outline: &Outline,
    force: bool,
) -> Result<crate::book_file::SaveResult, String> {
    let dir = project.join(crate::project::CONCEPT_DIR);
    let path = dir.join(OUTLINE_FILE);
    if !force {
        let disk_fingerprint = match fs::read(&path) {
            Ok(bytes) => Some(crate::book_file::content_fingerprint(&bytes).to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法读取文件 {}：{error}", path.display())),
        };
        if disk_fingerprint != outline.fingerprint {
            return Ok(crate::book_file::SaveResult::Conflict);
        }
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", dir.display()))?;
    crate::book_file::write_text_atomic(&path, &outline.body)?;
    Ok(crate::book_file::SaveResult::Saved {
        fingerprint: crate::book_file::content_fingerprint(outline.body.as_bytes()).to_string(),
    })
}

/// 主线图唯一的数据来源。数组顺序即作者确定的叙事次序。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainlinePlan {
    pub lines: Vec<StoryLine>,
    /// 主线图也是长活规划状态；外部变更先交人裁决，避免丢掉新增整条情节线。
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryLine {
    pub name: String,
    pub is_main: bool,
    pub milestones: Vec<Milestone>,
    /// 未知字段穿过界面保存往返，再由主线 YAML 序列化器写回。
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub title: String,
    pub change: Option<String>,
    pub reader_feeling: Option<String>,
    pub units: Vec<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub pending: bool,
    /// 当前主线表里的原始位置，只用于本次操作定位，不是持久身份。
    #[serde(default)]
    pub source: Option<MilestoneSource>,
    #[serde(default)]
    pub extra: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneSource {
    pub line_index: usize,
    pub milestone_index: usize,
}

fn mainlines_path(project: &Path) -> std::path::PathBuf {
    project
        .join(crate::project::CONCEPT_DIR)
        .join(MAINLINES_FILE)
}

/// 读主线表。缺文件＝空规划；存在但不是列表/行不是映射时明确报错，避免
/// 保存时覆盖读不懂的作者文件。
pub fn read_mainlines(project: &Path) -> Result<MainlinePlan, String> {
    let path = mainlines_path(project);
    if !path.exists() {
        return Ok(MainlinePlan::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("无法读取文件 {}：{e}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    let Value::Sequence(lines) = value else {
        return Err(format!("{} 应为主线列表", path.display()));
    };
    let mut lines = lines
        .into_iter()
        .enumerate()
        .map(|(index, value)| line_from_value(value, &path, index + 1))
        .collect::<Result<Vec<_>, _>>()?;
    // 外部手写文件也遵循同一展示纪律：有内容时总高亮第一条主线，
    // 不在读取时回写，仍由作者下一次保存时落盘确认。
    ensure_one_mainline(&mut lines);
    for (line_index, line) in lines.iter_mut().enumerate() {
        for (milestone_index, milestone) in line.milestones.iter_mut().enumerate() {
            milestone.source = Some(MilestoneSource {
                line_index,
                milestone_index,
            });
        }
    }
    Ok(MainlinePlan {
        lines,
        fingerprint: Some(crate::book_file::content_fingerprint(&bytes).to_string()),
    })
}

fn line_from_value(value: Value, path: &Path, index: usize) -> Result<StoryLine, String> {
    let Value::Mapping(mut map) = value else {
        return Err(format!("{} 的第 {index} 条情节线应为对象", path.display()));
    };
    let name = take_scalar(&mut map, "名称")
        .ok_or_else(|| format!("{} 的第 {index} 条情节线缺少「名称」", path.display()))?;
    let is_main = take_bool(&mut map, "主线").unwrap_or(false);
    let milestones = match map.remove(Value::String("里程碑".into())) {
        None => Vec::new(),
        Some(Value::Sequence(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, item)| milestone_from_value(item, path, index, i + 1))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(format!("{} 的「里程碑」应为列表", path.display())),
    };
    Ok(StoryLine {
        name,
        is_main,
        milestones,
        extra: map,
    })
}

fn milestone_from_value(
    value: Value,
    path: &Path,
    line_index: usize,
    index: usize,
) -> Result<Milestone, String> {
    let Value::Mapping(mut map) = value else {
        return Err(format!(
            "{} 的第 {line_index} 条情节线第 {index} 个里程碑应为对象",
            path.display()
        ));
    };
    let title = take_scalar(&mut map, "标题").ok_or_else(|| {
        format!(
            "{} 的第 {line_index} 条情节线第 {index} 个里程碑缺少「标题」",
            path.display()
        )
    })?;
    Ok(Milestone {
        title,
        change: take_scalar(&mut map, "变化"),
        reader_feeling: take_scalar(&mut map, "读者感受"),
        units: take_list(&mut map, "单元"),
        note: take_scalar(&mut map, "备注"),
        pending: take_pending(&mut map),
        source: None,
        extra: map,
    })
}

fn take_pending(map: &mut Mapping) -> bool {
    let key = Value::String("待打磨".into());
    match map.get(&key) {
        Some(Value::Bool(pending)) => {
            let pending = *pending;
            map.remove(&key);
            pending
        }
        _ => false,
    }
}

fn take_scalar(map: &mut Mapping, key: &str) -> Option<String> {
    map.remove(Value::String(key.into()))
        .as_ref()
        .and_then(crate::book_file::scalar_to_string)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn take_bool(map: &mut Mapping, key: &str) -> Option<bool> {
    let value = map.remove(Value::String(key.into()))?;
    match value {
        Value::Bool(value) => Some(value),
        Value::String(value) if value.trim() == "true" => Some(true),
        Value::String(value) if value.trim() == "false" => Some(false),
        _ => None,
    }
}

fn take_list(map: &mut Mapping, key: &str) -> Vec<String> {
    let Some(value) = map.remove(Value::String(key.into())) else {
        return Vec::new();
    };
    let mut values = Vec::new();
    match value {
        Value::Sequence(items) => {
            for item in items {
                if let Some(value) = crate::book_file::scalar_to_string(&item) {
                    push_unique(&mut values, &value);
                }
            }
        }
        value => {
            if let Some(value) = crate::book_file::scalar_to_string(&value) {
                push_unique(&mut values, &value);
            }
        }
    }
    values
}

fn push_unique(values: &mut Vec<String>, raw: &str) {
    let value = raw.trim();
    if !value.is_empty() && !values.iter().any(|current| current == value) {
        values.push(value.to_string());
    }
}

pub fn save_mainlines(
    project: &Path,
    plan: &MainlinePlan,
    force: bool,
) -> Result<crate::book_file::SaveResult, String> {
    let dir = project.join(crate::project::CONCEPT_DIR);
    let path = dir.join(MAINLINES_FILE);
    if !force {
        let disk_fingerprint = match fs::read(&path) {
            Ok(bytes) => Some(crate::book_file::content_fingerprint(&bytes).to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法读取文件 {}：{error}", path.display())),
        };
        if disk_fingerprint != plan.fingerprint {
            return Ok(crate::book_file::SaveResult::Conflict);
        }
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建构思目录 {}：{e}", dir.display()))?;
    let mut merged = plan.clone();
    ensure_one_mainline(&mut merged.lines);
    let values = merged
        .lines
        .iter()
        .map(line_to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let text = serde_yaml::to_string(&Value::Sequence(values))
        .map_err(|e| format!("无法生成主线.yaml：{e}"))?;
    crate::book_file::write_text_atomic(&path, &text)?;
    Ok(crate::book_file::SaveResult::Saved {
        fingerprint: crate::book_file::content_fingerprint(text.as_bytes()).to_string(),
    })
}

/// 只切换既有里程碑上的待打磨键。整表内容指纹保证传来的原始位置仍
/// 指向同一条目；外部编辑或重排后返回冲突，绝不按陈旧索引写入。
pub fn set_milestone_pending(
    project: &Path,
    source: &MilestoneSource,
    expected_fingerprint: &str,
    pending: bool,
) -> Result<crate::book_file::SaveResult, String> {
    let path = mainlines_path(project);
    let bytes = fs::read(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("{} 已不存在，请重新载入主线图", path.display())
        } else {
            format!("无法读取文件 {}：{error}", path.display())
        }
    })?;
    let disk_fingerprint = crate::book_file::content_fingerprint(&bytes).to_string();
    if disk_fingerprint != expected_fingerprint {
        return Ok(crate::book_file::SaveResult::Conflict);
    }

    let mut value: Value = serde_yaml::from_slice(&bytes)
        .map_err(|error| format!("无法解析 {}，请修复后重新载入：{error}", path.display()))?;
    let Value::Sequence(lines) = &mut value else {
        return Err(format!("{} 应为主线列表，请重新载入", path.display()));
    };
    let line = lines
        .get_mut(source.line_index)
        .ok_or_else(|| format!("里程碑定位已失效，请重新载入 {}", path.display()))?;
    let Value::Mapping(line) = line else {
        return Err(format!("目标情节线格式异常，请重新载入 {}", path.display()));
    };
    let milestones_key = Value::String("里程碑".into());
    let milestones = line
        .get_mut(&milestones_key)
        .ok_or_else(|| format!("目标里程碑已不存在，请重新载入 {}", path.display()))?;
    let Value::Sequence(milestones) = milestones else {
        return Err(format!(
            "目标情节线的里程碑列表损坏，请重新载入 {}",
            path.display()
        ));
    };
    let milestone = milestones
        .get_mut(source.milestone_index)
        .ok_or_else(|| format!("里程碑定位已失效，请重新载入 {}", path.display()))?;
    let Value::Mapping(milestone) = milestone else {
        return Err(format!("目标里程碑格式异常，请重新载入 {}", path.display()));
    };

    let pending_key = Value::String("待打磨".into());
    if pending {
        milestone.insert(pending_key, Value::Bool(true));
    } else {
        milestone.remove(&pending_key);
    }
    let text =
        serde_yaml::to_string(&value).map_err(|error| format!("无法生成主线.yaml：{error}"))?;
    crate::book_file::write_text_atomic(&path, &text)?;
    Ok(crate::book_file::SaveResult::Saved {
        fingerprint: crate::book_file::content_fingerprint(text.as_bytes()).to_string(),
    })
}

fn ensure_one_mainline(lines: &mut [StoryLine]) {
    let Some(first_main) = lines
        .iter()
        .position(|line| line.is_main)
        .or((!lines.is_empty()).then_some(0))
    else {
        return;
    };
    for (index, line) in lines.iter_mut().enumerate() {
        line.is_main = index == first_main;
    }
}

fn line_to_value(line: &StoryLine) -> Result<Value, String> {
    let name = required(&line.name, "情节线名称")?;
    let mut map = line.extra.clone();
    map.insert(Value::String("名称".into()), Value::String(name));
    if line.is_main {
        map.insert(Value::String("主线".into()), Value::Bool(true));
    } else {
        map.remove(Value::String("主线".into()));
    }
    let milestones = line
        .milestones
        .iter()
        .map(milestone_to_value)
        .collect::<Result<Vec<_>, _>>()?;
    if milestones.is_empty() {
        map.remove(Value::String("里程碑".into()));
    } else {
        map.insert(Value::String("里程碑".into()), Value::Sequence(milestones));
    }
    Ok(Value::Mapping(map))
}

fn milestone_to_value(milestone: &Milestone) -> Result<Value, String> {
    let mut map = milestone.extra.clone();
    map.insert(
        Value::String("标题".into()),
        Value::String(required(&milestone.title, "里程碑标题")?),
    );
    put_optional(&mut map, "变化", milestone.change.as_deref());
    put_optional(&mut map, "读者感受", milestone.reader_feeling.as_deref());
    put_optional(&mut map, "备注", milestone.note.as_deref());
    let units = milestone
        .units
        .iter()
        .filter_map(|value| (!value.trim().is_empty()).then(|| Value::String(value.trim().into())))
        .collect::<Vec<_>>();
    if units.is_empty() {
        map.remove(Value::String("单元".into()));
    } else {
        map.insert(Value::String("单元".into()), Value::Sequence(units));
    }
    let pending_key = Value::String("待打磨".into());
    if milestone.pending {
        map.insert(pending_key, Value::Bool(true));
    } else if matches!(map.get(&pending_key), Some(Value::Bool(_))) {
        map.remove(&pending_key);
    }
    Ok(Value::Mapping(map))
}

fn required(raw: &str, label: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        Err(format!("{label}不能为空"))
    } else {
        Ok(value.to_string())
    }
}

fn put_optional(map: &mut Mapping, key: &str, value: Option<&str>) {
    let key = Value::String(key.into());
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            map.insert(key, Value::String(value.into()));
        }
        None => {
            map.remove(&key);
        }
    }
}

// --- 桥段库：一张桥段卡就是一份 `构思/桥段/<名>.md` 文件。 ---

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeDraft {
    pub name: String,
    pub unit: Option<String>,
    pub order: Option<u32>,
    pub start_chapter: Option<u32>,
    pub end_chapter: Option<u32>,
    pub emotion_curve: Option<String>,
    pub key_turn: Option<String>,
    pub expectation_hook: Option<String>,
    pub beat_plan: Option<String>,
    #[serde(default)]
    pub type_solutions: Vec<BridgeTypeSolution>,
    #[serde(default)]
    pub type_solutions_fingerprint: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeTypeSolution {
    pub kind: String,
    pub solution: String,
    /// 只经 IPC 往返，不写入创作文件。编辑/删除后仍能找到原条目及未知键。
    #[serde(default)]
    pub source: Option<BridgePairSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgePairSource {
    pub index: usize,
    pub fingerprint: String,
}

fn pair_fingerprint(value: &Value) -> Result<String, String> {
    let text = serde_yaml::to_string(value).map_err(|e| format!("无法读取类型解法条目：{e}"))?;
    Ok(crate::book_file::content_fingerprint(text.as_bytes()).to_string())
}

impl BridgeDraft {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bridge {
    pub path: std::path::PathBuf,
    pub pending: bool,
    #[serde(flatten)]
    pub draft: BridgeDraft,
}

impl std::ops::Deref for Bridge {
    type Target = BridgeDraft;

    fn deref(&self) -> &Self::Target {
        &self.draft
    }
}

/// 书写页按当前章序读取的规划提示。它是纯读取结果：缺规划也始终可写。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterIntent {
    pub unit: Option<crate::chapter::UnitBrief>,
    pub bridge: Option<Bridge>,
    /// 规划里的区间或次序不一致只作提示，绝不阻断书写或保存。
    pub warnings: Vec<String>,
}

/// 桥段次序是人工确定的叙事次序；未填顺序的项只排在最后作稳定兜底。
fn compare_bridge_order(left: &Bridge, right: &Bridge) -> std::cmp::Ordering {
    left.order
        .unwrap_or(u32::MAX)
        .cmp(&right.order.unwrap_or(u32::MAX))
        .then_with(|| left.name.cmp(&right.name))
}

fn bridges_dir(project: &Path) -> std::path::PathBuf {
    project.join(crate::project::CONCEPT_DIR).join(BRIDGES_DIR)
}

/// 缺失桥段目录就是空桥段库。已安排项按人工「顺序」排，待安排项按文件名排，
/// 既不从章节区间推导次序，也不触碰旧单元的自由桥段备注。
pub fn scan_bridges(project: &Path) -> Result<Vec<Bridge>, String> {
    let dir = bridges_dir(project);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut bridges = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && !crate::book_file::is_hidden(path)
                && crate::book_file::has_md_extension(path)
        })
        .map(|path| read_bridge(&path))
        .collect::<Vec<_>>();
    bridges.sort_by(|left, right| {
        left.draft
            .unit
            .cmp(&right.draft.unit)
            .then_with(|| compare_bridge_order(left, right))
    });
    Ok(bridges)
}

/// 先按单元区间定位，再只在该单元已安排的桥段中找覆盖当前章的项。
/// 桥段区间可晚填；重叠时沿用人工桥段次序，取最靠前的一张并给出提示。
pub fn find_chapter_intent(project: &Path, ordinal: u32) -> Result<ChapterIntent, String> {
    let unit = crate::chapter::find_unit_for_chapter(project, ordinal)?;
    let Some(ref unit_brief) = unit else {
        return Ok(ChapterIntent {
            unit: None,
            bridge: None,
            warnings: Vec::new(),
        });
    };

    let bridges = scan_bridges(project)?
        .into_iter()
        .filter(|bridge| bridge.unit.as_deref() == Some(unit_brief.name.as_str()))
        .collect::<Vec<_>>();
    let mut warnings = chapter_intent_warnings(unit_brief, &bridges);
    let matches = bridges_for_chapter(&bridges, &unit_brief.name, ordinal);
    if matches.len() > 1 {
        warnings.push("多个桥段覆盖本章，按桥段次序显示最靠前的一项。".into());
    }

    Ok(ChapterIntent {
        unit,
        bridge: matches.first().map(|bridge| (*bridge).clone()),
        warnings,
    })
}

/// 章节卡与书写侧栏共用的桥段选择规则：同章重叠时按人工次序取首项。
pub(crate) fn bridges_for_chapter<'a>(
    bridges: &'a [Bridge],
    unit_name: &str,
    ordinal: u32,
) -> Vec<&'a Bridge> {
    let mut matches = bridges
        .iter()
        .filter(|bridge| {
            bridge.unit.as_deref() == Some(unit_name)
                && matches!(
                    (bridge.start_chapter, bridge.end_chapter),
                    (Some(start), Some(end)) if start <= end && start <= ordinal && ordinal <= end
                )
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| compare_bridge_order(left, right));
    matches
}

fn chapter_intent_warnings(unit: &crate::chapter::UnitBrief, bridges: &[Bridge]) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut ordered = bridges
        .iter()
        .filter_map(|bridge| {
            let (Some(start), Some(end)) = (bridge.start_chapter, bridge.end_chapter) else {
                return None;
            };
            if start > end {
                warnings.push(format!("桥段「{}」的起章晚于止章，仅作提示。", bridge.name));
                return None;
            }
            if unit
                .start_chapter
                .is_some_and(|unit_start| start < unit_start)
                || unit.end_chapter.is_some_and(|unit_end| end > unit_end)
            {
                warnings.push(format!(
                    "桥段「{}」的区间越出所属单元，仅作提示。",
                    bridge.name
                ));
            }
            Some(bridge)
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| compare_bridge_order(left, right));
    if ordered
        .windows(2)
        .any(|pair| pair[0].start_chapter > pair[1].start_chapter)
    {
        warnings.push("桥段章节区间与人工次序不一致，仅作提示。".into());
    }
    if ordered.iter().enumerate().any(|(index, bridge)| {
        ordered[index + 1..].iter().any(|other| {
            bridge.start_chapter <= other.end_chapter && other.start_chapter <= bridge.end_chapter
        })
    }) {
        warnings.push("桥段章节区间有重叠，仅作提示。".into());
    }
    warnings
}

fn read_bridge(path: &Path) -> Bridge {
    let mut draft = BridgeDraft::new(
        path.file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    // 无表也是一次载入状态，防止编辑期间外部新增表被空草稿抹掉。
    draft.type_solutions_fingerprint = pair_fingerprint(&Value::Null).ok();
    let Ok(raw) = crate::book_file::read_text(path) else {
        return Bridge {
            path: path.to_path_buf(),
            pending: false,
            draft,
        };
    };
    let raw = crate::book_file::strip_bom(&raw);
    let Some((yaml, body)) = crate::book_file::split_frontmatter(raw) else {
        draft.body = raw.to_string();
        return Bridge {
            path: path.to_path_buf(),
            pending: false,
            draft,
        };
    };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(&yaml) else {
        draft.body = raw.to_string();
        return Bridge {
            path: path.to_path_buf(),
            pending: false,
            draft,
        };
    };
    draft.unit = crate::book_file::map_scalar(&map, "所属单元");
    draft.order = crate::book_file::map_u32(&map, "顺序");
    draft.start_chapter = crate::book_file::map_u32(&map, "起章");
    draft.end_chapter = crate::book_file::map_u32(&map, "止章");
    draft.emotion_curve = crate::book_file::map_scalar(&map, "情绪曲线");
    draft.key_turn = crate::book_file::map_scalar(&map, "关键转折");
    draft.expectation_hook = crate::book_file::map_scalar(&map, "期待钩子");
    draft.beat_plan = crate::book_file::map_scalar(&map, "章节拍安排");
    draft.type_solutions = read_bridge_type_solutions(&map).unwrap_or_default();
    if let Some(value) = map.get(Value::String("类型解法".into())) {
        draft.type_solutions_fingerprint = pair_fingerprint(value).ok();
    }
    draft.body = body;
    Bridge {
        path: path.to_path_buf(),
        pending: crate::book_file::is_pending(&map),
        draft,
    }
}

/// 读-合-写当前桥段的 frontmatter，保留作者在 Obsidian 补的未知字段。
pub fn save_bridge(
    project: &Path,
    draft: &BridgeDraft,
    prev_path: Option<&Path>,
) -> Result<Bridge, String> {
    let name = crate::book_file::sanitize_file_name(&draft.name)?;
    let dir = bridges_dir(project);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建桥段目录 {}：{error}", dir.display()))?;
    let path = crate::book_file::unique_file_path(&dir, &format!("{name}.md"), prev_path);
    let base = prev_path
        .filter(|previous| *previous != path)
        .unwrap_or(&path);
    let mut map = if base.exists() {
        let raw = crate::book_file::read_text(base)?;
        match crate::book_file::split_frontmatter(crate::book_file::strip_bom(&raw)) {
            Some((yaml, _)) => match serde_yaml::from_str::<Value>(&yaml) {
                Ok(Value::Mapping(map)) => map,
                _ => return Err("桥段结构无法读取，拒绝覆盖".into()),
            },
            None => Mapping::new(),
        }
    } else {
        Mapping::new()
    };
    read_bridge_type_solutions(&map)?;
    if let Some(expected) = &draft.type_solutions_fingerprint {
        let current = map
            .get(Value::String("类型解法".into()))
            .unwrap_or(&Value::Null);
        if pair_fingerprint(current)? != *expected {
            return Err("类型解法已被外部修改，请重新打开桥段".into());
        }
    }
    apply_bridge_draft(&mut map, draft);
    let previous_pairs = map
        .get(Value::String("类型解法".into()))
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let mut pairs = Vec::new();
    for pair in &draft.type_solutions {
        if pair.source.is_none() && pair.kind.trim().is_empty() && pair.solution.trim().is_empty() {
            continue;
        }
        let mut item = if let Some(source) = &pair.source {
            let original = previous_pairs
                .get(source.index)
                .ok_or("类型解法已被外部修改，请重新打开桥段")?;
            if pair_fingerprint(original)? != source.fingerprint {
                return Err("类型解法已被外部修改，请重新打开桥段".into());
            }
            original
                .as_mapping()
                .cloned()
                .ok_or("无法读取原类型解法条目")?
        } else {
            Mapping::new()
        };
        item.insert(
            Value::String("类型".into()),
            Value::String(pair.kind.clone()),
        );
        item.insert(
            Value::String("解法".into()),
            Value::String(pair.solution.clone()),
        );
        pairs.push(Value::Mapping(item));
    }
    if pairs.is_empty() {
        map.remove(Value::String("类型解法".into()));
    } else {
        map.insert(Value::String("类型解法".into()), Value::Sequence(pairs));
    }
    if let Some(previous) = prev_path {
        if previous != path {
            fs::rename(previous, &path)
                .map_err(|error| format!("无法移动桥段到 {}：{error}", path.display()))?;
        }
    }
    crate::book_file::write_frontmatter(&path, map, &draft.body)?;
    Ok(read_bridge(&path))
}

fn read_bridge_type_solutions(map: &Mapping) -> Result<Vec<BridgeTypeSolution>, String> {
    let Some(value) = map.get(Value::String("类型解法".into())) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_sequence()
        .ok_or("桥段的类型解法应为列表，拒绝覆盖")?;
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let fields = item
                .as_mapping()
                .ok_or("桥段的类型解法条目应为对象，拒绝覆盖")?;
            let text = |key: &str| -> Result<String, String> {
                match fields.get(Value::String(key.into())) {
                    None | Some(Value::Null) => Ok(String::new()),
                    Some(Value::String(value)) => Ok(value.clone()),
                    _ => Err(format!("桥段类型解法的{key}应为文字，拒绝覆盖")),
                }
            };
            Ok(BridgeTypeSolution {
                kind: text("类型")?,
                solution: text("解法")?,
                source: Some(BridgePairSource {
                    index,
                    fingerprint: pair_fingerprint(item)?,
                }),
            })
        })
        .collect()
}

fn apply_bridge_draft(map: &mut Mapping, draft: &BridgeDraft) {
    crate::book_file::set_map_scalar(map, "所属单元", draft.unit.as_deref());
    crate::book_file::set_map_u32(map, "顺序", draft.order);
    crate::book_file::set_map_u32(map, "起章", draft.start_chapter);
    crate::book_file::set_map_u32(map, "止章", draft.end_chapter);
    crate::book_file::set_map_scalar(map, "情绪曲线", draft.emotion_curve.as_deref());
    crate::book_file::set_map_scalar(map, "关键转折", draft.key_turn.as_deref());
    crate::book_file::set_map_scalar(map, "期待钩子", draft.expectation_hook.as_deref());
    crate::book_file::set_map_scalar(map, "章节拍安排", draft.beat_plan.as_deref());
}

fn draft_from_bridge(bridge: &Bridge) -> BridgeDraft {
    bridge.draft.clone()
}

fn bridge_in_project(project: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(bridges_dir(project).as_path()) {
        return Err(format!("{} 不在 构思/桥段/ 下", path.display()));
    }
    Ok(())
}

/// 安排只补所属单元与末尾顺序；桥段正文仍只留在自己的文件里。
pub fn arrange_bridge(project: &Path, path: &Path, unit: &str) -> Result<Bridge, String> {
    bridge_in_project(project, path)?;
    let unit = required(unit, "所属单元")?;
    let unit_exists = crate::project::scan_notes(project, crate::project::NoteKind::Unit)?
        .iter()
        .any(|note| note.name == unit);
    if !unit_exists {
        return Err(format!("单元「{unit}」不存在，不能安排桥段"));
    }
    let bridge = read_bridge(path);
    let next_order = scan_bridges(project)?
        .iter()
        .filter(|item| item.path != path && item.draft.unit.as_deref() == Some(unit.as_str()))
        .filter_map(|item| item.draft.order)
        .max()
        .unwrap_or(0)
        + 1;
    let mut draft = draft_from_bridge(&bridge);
    draft.unit = Some(unit);
    draft.order = Some(next_order);
    save_bridge(project, &draft, Some(path))
}

/// 取消安排只摘掉关系与次序，其他桥段内容和提示字段完全保留。
pub fn unarrange_bridge(project: &Path, path: &Path) -> Result<Bridge, String> {
    bridge_in_project(project, path)?;
    let bridge = read_bridge(path);
    let mut draft = draft_from_bridge(&bridge);
    draft.unit = None;
    draft.order = None;
    save_bridge(project, &draft, Some(path))
}

/// 在同一单元内交换相邻桥段，落盘后的连续顺序即作者确定的叙事次序。
pub fn move_bridge(project: &Path, path: &Path, direction: i32) -> Result<Vec<Bridge>, String> {
    bridge_in_project(project, path)?;
    let current = read_bridge(path);
    let Some(unit) = current.draft.unit.as_deref() else {
        return Err("待安排桥段不需要调整单元内次序".to_string());
    };
    let mut bridges = scan_bridges(project)?
        .into_iter()
        .filter(|item| item.draft.unit.as_deref() == Some(unit))
        .collect::<Vec<_>>();
    bridges.sort_by(compare_bridge_order);
    let index = bridges
        .iter()
        .position(|item| item.path == path)
        .ok_or_else(|| "桥段未找到".to_string())?;
    let target = index as i32 + direction.signum();
    if !(0..bridges.len() as i32).contains(&target) {
        return Ok(bridges);
    }
    bridges.swap(index, target as usize);
    let mut saved = Vec::with_capacity(bridges.len());
    for (index, bridge) in bridges.iter().enumerate() {
        let mut draft = draft_from_bridge(bridge);
        draft.order = Some(index as u32 + 1);
        saved.push(save_bridge(project, &draft, Some(&bridge.path))?);
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 桥段类型解法与待打磨_保存重开保持正文与未知键() {
        let tmp = tempfile::TempDir::new().unwrap();
        let project = tmp.path();
        let dir = project.join("构思/桥段");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("夜探.md");
        fs::write(&path, "---\n待打磨: true\n手补: 保留\n---\n原正文").unwrap();
        let mut input = serde_json::to_value(BridgeDraft::new("夜探")).unwrap();
        input["body"] = serde_json::json!("原正文");
        input["typeSolutions"] = serde_json::json!([
            {"kind": "自定义爽点", "solution": "借对手之口揭晓"},
            {"kind": "掉马甲", "solution": ""}
        ]);
        let draft: BridgeDraft = serde_json::from_value(input).unwrap();
        save_bridge(project, &draft, Some(&path)).unwrap();
        let reopened = serde_json::to_value(&scan_bridges(project).unwrap()[0]).unwrap();
        assert_eq!(reopened["typeSolutions"][0]["kind"], "自定义爽点");
        assert_eq!(reopened["typeSolutions"][0]["solution"], "借对手之口揭晓");
        assert_eq!(reopened["typeSolutions"][1]["kind"], "掉马甲");
        assert_eq!(reopened["typeSolutions"][1]["solution"], "");
        assert_eq!(reopened["pending"], true);
        assert_eq!(reopened["body"], "原正文");
        assert!(fs::read_to_string(&path).unwrap().contains("手补: 保留"));
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        crate::book_file::set_pending(&path, false).unwrap();
        assert!(!scan_bridges(project).unwrap()[0].pending);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert_eq!(scan_bridges(project).unwrap()[0].body, "原正文");
        let mut cleared = draft.clone();
        cleared.type_solutions.clear();
        save_bridge(project, &cleared, Some(&path)).unwrap();
        assert!(scan_bridges(project).unwrap()[0].type_solutions.is_empty());
        assert!(!fs::read_to_string(&path).unwrap().contains("类型解法:"));
    }

    #[test]
    fn 桥段类型解法损坏_保存拒绝覆盖() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("构思/桥段");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("夜探.md");
        for original in [
            "---\n类型解法: 不是列表\n---\n保留正文",
            "---\n类型解法: [坏条目]\n---\n保留正文",
            "---\n类型解法: [\n---\n保留正文",
        ] {
            fs::write(&path, original).unwrap();
            assert!(save_bridge(tmp.path(), &BridgeDraft::new("夜探"), Some(&path)).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn 删除首组类型解法_剩余条目保留自己的未知键() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("构思/桥段");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("夜探.md");
        fs::write(&path, "---\n类型解法:\n- 类型: 甲\n  解法: 一\n  手补: 甲的字段\n- 类型: 乙\n  解法: 二\n  手补: 乙的字段\n---\n正文").unwrap();
        let mut draft = scan_bridges(tmp.path()).unwrap()[0].draft.clone();
        draft.type_solutions.remove(0);
        save_bridge(tmp.path(), &draft, Some(&path)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("乙的字段"));
        assert!(!text.contains("甲的字段"));
        let mut stale = scan_bridges(tmp.path()).unwrap()[0].draft.clone();
        stale.type_solutions.clear();
        let external = text.replace("乙的字段", "外部新增说明");
        fs::write(&path, &external).unwrap();
        assert!(save_bridge(tmp.path(), &stale, Some(&path)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), external);
    }

    #[test]
    fn 桥段旧空类型解法保留手补_原无表时也保护外部新增() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("构思/桥段");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("夜探.md");
        fs::write(&path, "---\n类型解法:\n- 手补: 待研究\n---\n正文").unwrap();
        let mut draft = scan_bridges(tmp.path()).unwrap()[0].draft.clone();
        draft.body = "新正文".into();
        save_bridge(tmp.path(), &draft, Some(&path)).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("待研究"));
        fs::write(&path, "旧桥段无表").unwrap();
        let loaded = scan_bridges(tmp.path()).unwrap()[0].draft.clone();
        let external = "---\n类型解法:\n- 类型: 外部新增\n---\n旧桥段无表";
        fs::write(&path, external).unwrap();
        assert!(save_bridge(tmp.path(), &loaded, Some(&path)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), external);
    }
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn 缺失大纲纸面是空状态且不创建文件() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        fs::create_dir_all(&project).unwrap();

        assert_eq!(read_outline(&project).unwrap(), Outline::default());
        assert!(!project.join("构思").join(OUTLINE_FILE).exists());
    }

    #[test]
    fn 保存大纲纸面使用轻模板且允许自由改写() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let initial = Outline {
            body: "## 立意\n\n## 主线总览\n\n## 阶段构想\n\n## 尚未解决\n".into(),
            fingerprint: None,
        };

        save_outline(&project, &initial, false).unwrap();
        assert_eq!(read_outline(&project).unwrap().body, initial.body);

        let rewritten = Outline {
            body: "随手记下的全书去向".into(),
            fingerprint: read_outline(&project).unwrap().fingerprint,
        };
        save_outline(&project, &rewritten, false).unwrap();
        assert_eq!(read_outline(&project).unwrap().body, rewritten.body);
    }

    #[test]
    fn 大纲纸面外部改动时拒绝静默覆盖() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let loaded = read_outline(&project).unwrap();
        let draft = Outline {
            body: "应用内的大纲".into(),
            fingerprint: loaded.fingerprint,
        };
        assert!(matches!(
            save_outline(&project, &draft, false).unwrap(),
            crate::book_file::SaveResult::Saved { .. }
        ));

        let loaded = read_outline(&project).unwrap();
        std::fs::write(project.join("构思").join(OUTLINE_FILE), "Obsidian 的新内容").unwrap();
        let changed = Outline {
            body: "应用内的后续修改".into(),
            fingerprint: loaded.fingerprint,
        };
        assert!(matches!(
            save_outline(&project, &changed, false).unwrap(),
            crate::book_file::SaveResult::Conflict
        ));
    }

    #[test]
    fn 主线里程碑按人工次序保存且保留未知字段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let plan = MainlinePlan {
            lines: vec![StoryLine {
                name: "为父正名".into(),
                is_main: true,
                milestones: vec![
                    Milestone {
                        title: "得知冤案".into(),
                        change: Some("从避祸转为追查".into()),
                        reader_feeling: None,
                        units: vec!["初入京城".into()],
                        note: None,
                        pending: false,
                        source: None,
                        extra: serde_yaml::Mapping::from_iter([(
                            serde_yaml::Value::String("手补说明".into()),
                            serde_yaml::Value::String("保留".into()),
                        )]),
                    },
                    Milestone {
                        title: "朝堂翻案".into(),
                        change: None,
                        reader_feeling: Some("痛快".into()),
                        units: vec!["大朝会".into()],
                        note: Some("终局".into()),
                        pending: false,
                        source: None,
                        extra: serde_yaml::Mapping::new(),
                    },
                ],
                extra: serde_yaml::Mapping::from_iter([(
                    serde_yaml::Value::String("颜色".into()),
                    serde_yaml::Value::String("#a8432f".into()),
                )]),
            }],
            fingerprint: None,
        };

        save_mainlines(&project, &plan, false).unwrap();
        let loaded = read_mainlines(&project).unwrap();
        assert_eq!(loaded.lines[0].name, plan.lines[0].name);
        assert_eq!(
            loaded.lines[0].milestones[0].title,
            plan.lines[0].milestones[0].title
        );
        assert_eq!(
            loaded.lines[0].milestones[0].extra,
            plan.lines[0].milestones[0].extra
        );
        assert_eq!(
            loaded.lines[0].milestones[0].source,
            Some(MilestoneSource {
                line_index: 0,
                milestone_index: 0
            })
        );
        assert_eq!(loaded.lines[0].milestones[0].title, "得知冤案");
    }

    #[test]
    fn 主线里程碑待打磨_同名精确定位保存退出恢复次序与未知字段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let path = mainlines_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "- 名称: 主线甲\n  主线: true\n  线手补: 甲线字段\n  里程碑:\n    - 标题: 重复标题\n      变化: 从避祸转为追查\n      待打磨: false\n      碑手补: 第一条字段\n    - 标题: 重复标题\n      待打磨: true\n      碑手补: 第二条字段\n- 名称: 支线乙\n  线手补: 乙线字段\n  里程碑:\n    - 标题: 重复标题\n      变化: 找到旧账\n      读者感受: 期待\n      单元: [单元乙]\n      备注: 证据仍有缺口\n      碑手补: 支线字段\n",
        )
        .unwrap();

        let loaded = read_mainlines(&project).unwrap();
        assert!(
            !loaded.lines[0].milestones[0].pending,
            "缺失或 false 都是普通状态"
        );
        assert!(loaded.lines[0].milestones[1].pending);
        assert!(!loaded.lines[1].milestones[0].pending);
        assert_eq!(
            loaded.lines[0].milestones[0].source,
            Some(MilestoneSource {
                line_index: 0,
                milestone_index: 0
            })
        );
        assert_eq!(
            loaded.lines[0].milestones[1].source,
            Some(MilestoneSource {
                line_index: 0,
                milestone_index: 1
            })
        );
        assert_eq!(
            loaded.lines[1].milestones[0].source,
            Some(MilestoneSource {
                line_index: 1,
                milestone_index: 0
            })
        );

        let source = loaded.lines[1].milestones[0].source.clone().unwrap();
        let first_write = set_milestone_pending(
            &project,
            &source,
            loaded.fingerprint.as_deref().unwrap(),
            true,
        )
        .unwrap();
        assert!(matches!(
            first_write,
            crate::book_file::SaveResult::Saved { .. }
        ));
        let pending = read_mainlines(&project).unwrap();
        assert!(
            pending.lines[1].milestones[0].pending,
            "只切换支线里的同名里程碑"
        );
        assert!(
            pending.lines[0].milestones[1].pending,
            "其他同名里程碑保持原状态"
        );
        assert_eq!(pending.lines[0].name, "主线甲");
        assert_eq!(pending.lines[1].name, "支线乙");
        assert_eq!(pending.lines[1].milestones[0].units, vec!["单元乙"]);
        assert_eq!(
            pending.lines[1].milestones[0].note.as_deref(),
            Some("证据仍有缺口")
        );

        let wire = serde_json::to_value(&pending).unwrap();
        let mut edited: MainlinePlan = serde_json::from_value(wire).unwrap();
        edited.lines[1].milestones[0].note = Some("补齐证人来历".into());
        save_mainlines(&project, &edited, false).unwrap();
        let edited = read_mainlines(&project).unwrap();
        assert!(
            edited.lines[1].milestones[0].pending,
            "编辑后仍保留待打磨状态"
        );
        assert_eq!(
            edited.lines[1].milestones[0].note.as_deref(),
            Some("补齐证人来历")
        );
        assert_eq!(
            edited.lines[0].extra[Value::String("线手补".into())],
            "甲线字段"
        );
        assert_eq!(
            edited.lines[1].extra[Value::String("线手补".into())],
            "乙线字段"
        );
        assert_eq!(
            edited.lines[0].milestones[0].extra[Value::String("碑手补".into())],
            "第一条字段"
        );
        assert_eq!(
            edited.lines[0].milestones[1].extra[Value::String("碑手补".into())],
            "第二条字段"
        );
        assert_eq!(
            edited.lines[1].milestones[0].extra[Value::String("碑手补".into())],
            "支线字段"
        );

        let source = edited.lines[1].milestones[0].source.clone().unwrap();
        set_milestone_pending(
            &project,
            &source,
            edited.fingerprint.as_deref().unwrap(),
            false,
        )
        .unwrap();
        let restored = read_mainlines(&project).unwrap();
        assert!(!restored.lines[1].milestones[0].pending);
        assert!(restored.lines[0].milestones[1].pending);
        assert_eq!(restored.lines[0].milestones[0].title, "重复标题");
        assert_eq!(restored.lines[0].milestones[1].title, "重复标题");
        assert_eq!(restored.lines[1].milestones[0].title, "重复标题");
        let value: Value = serde_yaml::from_slice(&fs::read(&path).unwrap()).unwrap();
        let lines = value.as_sequence().unwrap();
        let second_line = lines[1].as_mapping().unwrap();
        let milestones = second_line[Value::String("里程碑".into())]
            .as_sequence()
            .unwrap();
        assert!(!milestones[0]
            .as_mapping()
            .unwrap()
            .contains_key(Value::String("待打磨".into())));
        assert_eq!(
            crate::book_file::count_files_recursive(&project),
            1,
            "状态操作不建立副本"
        );
    }

    #[test]
    fn 主线里程碑待打磨_表指纹过期时外部重排拒写() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let path = mainlines_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "- 名称: 同名线\n  主线: true\n  里程碑:\n    - 标题: 重复标题\n      变化: 第一条\n- 名称: 同名线\n  里程碑:\n    - 标题: 重复标题\n      变化: 第二条\n",
        )
        .unwrap();
        let loaded = read_mainlines(&project).unwrap();
        let source = loaded.lines[0].milestones[0].source.clone().unwrap();
        let mut external: Value = serde_yaml::from_slice(&fs::read(&path).unwrap()).unwrap();
        external.as_sequence_mut().unwrap().swap(0, 1);
        let external_text = serde_yaml::to_string(&external).unwrap();
        fs::write(&path, &external_text).unwrap();

        assert!(matches!(
            set_milestone_pending(
                &project,
                &source,
                loaded.fingerprint.as_deref().unwrap(),
                true,
            )
            .unwrap(),
            crate::book_file::SaveResult::Conflict
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), external_text);
        let reloaded = read_mainlines(&project).unwrap();
        assert_eq!(
            reloaded.lines[0].milestones[0].change.as_deref(),
            Some("第二条")
        );
        assert!(!reloaded.lines[0].milestones[0].pending);
    }

    #[test]
    fn 主线里程碑待打磨_损坏_yaml拒写并保持原文件() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let path = mainlines_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let damaged = "- 名称: [损坏的 YAML";
        fs::write(&path, damaged).unwrap();
        let fingerprint = crate::book_file::content_fingerprint(damaged.as_bytes()).to_string();

        assert!(set_milestone_pending(
            &project,
            &MilestoneSource {
                line_index: 0,
                milestone_index: 0
            },
            &fingerprint,
            true,
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    }

    #[test]
    fn 外部新增主线时拒绝静默覆盖() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let plan = MainlinePlan {
            lines: vec![StoryLine {
                name: "为父正名".into(),
                is_main: true,
                milestones: vec![Milestone {
                    title: "得知冤案".into(),
                    change: None,
                    reader_feeling: None,
                    units: vec![],
                    note: None,
                    pending: false,
                    source: None,
                    extra: Mapping::new(),
                }],
                extra: Mapping::new(),
            }],
            fingerprint: None,
        };
        save_mainlines(&project, &plan, false).unwrap();
        fs::write(
            project.join("构思").join(MAINLINES_FILE),
            "- 名称: 为父正名\n  外部线字段: 保留\n  里程碑:\n    - 标题: 得知冤案\n      外部碑字段: 保留\n",
        )
        .unwrap();

        assert!(matches!(
            save_mainlines(&project, &plan, false).unwrap(),
            crate::book_file::SaveResult::Conflict
        ));
    }

    #[test]
    fn 保存非空主线图时总会确定一条主线() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let plan = MainlinePlan {
            lines: vec![StoryLine {
                name: "为父正名".into(),
                is_main: false,
                milestones: vec![],
                extra: Mapping::new(),
            }],
            fingerprint: None,
        };
        save_mainlines(&project, &plan, false).unwrap();
        assert!(read_mainlines(&project).unwrap().lines[0].is_main);
    }

    #[test]
    fn 读入外部主线图时总会高亮唯一主线() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let dir = project.join("构思");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MAINLINES_FILE),
            "- 名称: 为父正名\n  主线: true\n- 名称: 查清旧案\n  主线: true\n",
        )
        .unwrap();

        let loaded = read_mainlines(&project).unwrap();
        assert_eq!(loaded.lines.iter().filter(|line| line.is_main).count(), 1);
        assert!(loaded.lines[0].is_main);
    }

    #[test]
    fn 新桥段草案待安排_安排追加末尾_取消后回归待安排() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        crate::project::save_note(
            &project,
            &crate::project::NoteDraft::new(crate::project::NoteKind::Unit, "初入京城"),
            None,
        )
        .unwrap();
        let mut first = BridgeDraft::new("夜探旧宅");
        first.body = "沈砚夜探旧宅，发现父亲留下的密信。".into();
        let first = save_bridge(&project, &first, None).unwrap();
        assert!(first.unit.is_none());
        assert_eq!(scan_bridges(&project).unwrap(), vec![first.clone()]);

        let second = save_bridge(&project, &BridgeDraft::new("朝堂对质"), None).unwrap();
        let first = arrange_bridge(&project, &first.path, "初入京城").unwrap();
        let second = arrange_bridge(&project, &second.path, "初入京城").unwrap();
        assert_eq!(
            (first.unit.as_deref(), first.order),
            (Some("初入京城"), Some(1))
        );
        assert_eq!(
            (second.unit.as_deref(), second.order),
            (Some("初入京城"), Some(2))
        );

        let restored = unarrange_bridge(&project, &first.path).unwrap();
        assert_eq!((restored.unit.clone(), restored.order), (None, None));
    }

    #[test]
    fn 安排桥段只接受既有单元() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let bridge = save_bridge(&project, &BridgeDraft::new("夜探旧宅"), None).unwrap();

        assert!(arrange_bridge(&project, &bridge.path, "不存在的单元").is_err());
    }

    #[test]
    fn 单元内桥段可手动换序且保留未知字段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        crate::project::save_note(
            &project,
            &crate::project::NoteDraft::new(crate::project::NoteKind::Unit, "初入京城"),
            None,
        )
        .unwrap();
        let first = save_bridge(&project, &BridgeDraft::new("夜探旧宅"), None).unwrap();
        let second = save_bridge(&project, &BridgeDraft::new("朝堂对质"), None).unwrap();
        let first = arrange_bridge(&project, &first.path, "初入京城").unwrap();
        let second = arrange_bridge(&project, &second.path, "初入京城").unwrap();
        fs::write(
            &first.path,
            "---\n所属单元: 初入京城\n顺序: 1\n手补说明: 保留\n---\n夜探旧宅的正文\n",
        )
        .unwrap();

        move_bridge(&project, &second.path, -1).unwrap();
        let arranged = scan_bridges(&project)
            .unwrap()
            .into_iter()
            .filter(|bridge| bridge.unit.as_deref() == Some("初入京城"))
            .collect::<Vec<_>>();
        assert_eq!(arranged[0].name, "朝堂对质");
        assert_eq!(arranged[1].name, "夜探旧宅");
        assert_eq!(arranged[0].order, Some(1));
        assert_eq!(arranged[1].order, Some(2));
        assert!(fs::read_to_string(first.path)
            .unwrap()
            .contains("手补说明: 保留"));
    }

    #[test]
    fn 本章意图_命中所属单元与覆盖桥段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let mut unit = crate::project::NoteDraft::new(crate::project::NoteKind::Unit, "初入京城");
        unit.start_chapter = Some(5);
        unit.end_chapter = Some(8);
        unit.emotion_goal = Some("沉冤得雪的痛快".into());
        crate::project::save_note(&project, &unit, None).unwrap();

        let mut bridge = BridgeDraft::new("夜探旧宅");
        bridge.unit = Some("初入京城".into());
        bridge.order = Some(1);
        bridge.start_chapter = Some(5);
        bridge.end_chapter = Some(8);
        bridge.emotion_curve = Some("压抑 → 痛快".into());
        bridge.key_turn = Some("找到洗冤证据".into());
        bridge.expectation_hook = Some("证据指向幕后人".into());
        bridge.beat_plan = Some("第5章代入＋信息差".into());
        save_bridge(&project, &bridge, None).unwrap();

        let intent = find_chapter_intent(&project, 6).unwrap();
        let unit = intent.unit.unwrap();
        assert_eq!(unit.name, "初入京城");
        assert_eq!(unit.emotion_goal.as_deref(), Some("沉冤得雪的痛快"));
        let bridge = intent.bridge.unwrap();
        assert_eq!(bridge.name, "夜探旧宅");
        assert_eq!(bridge.emotion_curve.as_deref(), Some("压抑 → 痛快"));
        assert!(intent.warnings.is_empty());
    }

    #[test]
    fn 本章意图_缺少规划时保持空提示() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");

        let intent = find_chapter_intent(&project, 1).unwrap();
        assert!(intent.unit.is_none());
        assert!(intent.bridge.is_none());
        assert!(intent.warnings.is_empty());
    }

    #[test]
    fn 本章意图_异常区间只返回提示且仍按次序取桥段() {
        let root = tempdir().unwrap();
        let project = root.path().join("项目/《空书》");
        let mut unit = crate::project::NoteDraft::new(crate::project::NoteKind::Unit, "初入京城");
        unit.start_chapter = Some(5);
        unit.end_chapter = Some(8);
        crate::project::save_note(&project, &unit, None).unwrap();

        let mut later = BridgeDraft::new("后到的桥段");
        later.unit = Some("初入京城".into());
        later.order = Some(1);
        later.start_chapter = Some(6);
        later.end_chapter = Some(9);
        save_bridge(&project, &later, None).unwrap();

        let mut earlier = BridgeDraft::new("先发生的桥段");
        earlier.unit = Some("初入京城".into());
        earlier.order = Some(2);
        earlier.start_chapter = Some(5);
        earlier.end_chapter = Some(7);
        save_bridge(&project, &earlier, None).unwrap();

        let mut reversed = BridgeDraft::new("倒置区间");
        reversed.unit = Some("初入京城".into());
        reversed.order = Some(3);
        reversed.start_chapter = Some(8);
        reversed.end_chapter = Some(6);
        save_bridge(&project, &reversed, None).unwrap();

        let intent = find_chapter_intent(&project, 6).unwrap();
        assert_eq!(
            intent.bridge.unwrap().name,
            "后到的桥段",
            "仍由人工桥段次序决定"
        );
        assert!(intent
            .warnings
            .iter()
            .any(|hint| hint.contains("越出所属单元")));
        assert!(intent.warnings.iter().any(|hint| hint.contains("次序")));
        assert!(intent.warnings.iter().any(|hint| hint.contains("重叠")));
        assert!(intent
            .warnings
            .iter()
            .any(|hint| hint.contains("起章晚于止章")));
    }
}
