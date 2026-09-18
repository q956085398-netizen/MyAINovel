//! 构思规划边界：大纲纸面、主线里程碑，以及后续桥段库都从这里读写。
//!
//! 缺失的规划文件代表尚未开始，不是错误；所有写入遵循 ADR 0004 的原子写。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

pub const OUTLINE_FILE: &str = "大纲.md";
pub const MAINLINES_FILE: &str = "主线.yaml";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outline {
    pub body: String,
}

pub fn read_outline(_project: &Path) -> Result<Outline, String> {
    let path = _project
        .join(crate::project::CONCEPT_DIR)
        .join(OUTLINE_FILE);
    if !path.exists() {
        return Ok(Outline::default());
    }
    crate::book_file::read_text(&path).map(|body| Outline { body })
}

/// 大纲是自由纸面而非长活编辑器；保存以同目录临时文件＋rename 原子替换。
pub fn save_outline(project: &Path, outline: &Outline) -> Result<(), String> {
    let dir = project.join(crate::project::CONCEPT_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", dir.display()))?;
    crate::book_file::write_text_atomic(&dir.join(OUTLINE_FILE), &outline.body)
}

/// 主线图唯一的数据来源。数组顺序即作者确定的叙事次序。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainlinePlan {
    pub lines: Vec<StoryLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryLine {
    pub name: String,
    pub is_main: bool,
    pub milestones: Vec<Milestone>,
    /// Obsidian 手补字段只在磁盘往返，不成为应用表单字段。
    #[serde(skip, default)]
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
    #[serde(skip, default)]
    pub extra: Mapping,
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
    let text = crate::book_file::read_text(&path)?;
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    let Value::Sequence(lines) = value else {
        return Err(format!("{} 应为主线列表", path.display()));
    };
    let lines = lines
        .into_iter()
        .enumerate()
        .map(|(index, value)| line_from_value(value, &path, index + 1))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MainlinePlan { lines })
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
        extra: map,
    })
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

pub fn save_mainlines(project: &Path, plan: &MainlinePlan) -> Result<(), String> {
    let dir = project.join(crate::project::CONCEPT_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建构思目录 {}：{e}", dir.display()))?;
    let values = plan
        .lines
        .iter()
        .map(line_to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let text = serde_yaml::to_string(&Value::Sequence(values))
        .map_err(|e| format!("无法生成主线.yaml：{e}"))?;
    crate::book_file::write_text_atomic(&dir.join(MAINLINES_FILE), &text)
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

#[cfg(test)]
mod tests {
    use super::*;
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
        };

        save_outline(&project, &initial).unwrap();
        assert_eq!(read_outline(&project).unwrap(), initial);

        let rewritten = Outline {
            body: "随手记下的全书去向".into(),
        };
        save_outline(&project, &rewritten).unwrap();
        assert_eq!(read_outline(&project).unwrap(), rewritten);
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
                        extra: serde_yaml::Mapping::new(),
                    },
                ],
                extra: serde_yaml::Mapping::from_iter([(
                    serde_yaml::Value::String("颜色".into()),
                    serde_yaml::Value::String("#a8432f".into()),
                )]),
            }],
        };

        save_mainlines(&project, &plan).unwrap();
        let loaded = read_mainlines(&project).unwrap();
        assert_eq!(loaded, plan);
        assert_eq!(loaded.lines[0].milestones[0].title, "得知冤案");
    }
}
