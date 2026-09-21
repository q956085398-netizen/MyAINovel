//! 构思首页只读派生模型（工单 #57）。
//! 所有字段都从现有权威文件现读，不写摘要副本。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::project::NoteKind;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeationOverviewItem {
    pub name: String,
    pub detail: Option<String>,
    pub tab: String,
    pub focus: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeationOverview {
    pub logline: Option<String>,
    pub reader_imagination: Option<String>,
    pub mainlines: Vec<IdeationOverviewItem>,
    pub characters: Vec<IdeationOverviewItem>,
    pub maps: Vec<IdeationOverviewItem>,
    pub pending: Vec<IdeationOverviewItem>,
    pub unresolved: Vec<String>,
}

pub fn read_ideation_overview(project: &Path) -> Result<IdeationOverview, String> {
    let outline = crate::planning::read_outline(project)?;
    let mainlines = crate::planning::read_mainlines(project)?;
    let circle = crate::project::read_circle(project)?;
    let meta = crate::project::read_project_meta(project)?;

    let characters = crate::project::scan_notes(project, NoteKind::Character)?
        .into_iter()
        .map(|note| IdeationOverviewItem {
            name: note.name.clone(),
            detail: first_meaningful_line(&note.body),
            tab: "人物".to_string(),
            focus: Some(note.name),
        })
        .collect();

    let maps = meta
        .maps
        .into_iter()
        .map(|name| IdeationOverviewItem {
            name,
            detail: None,
            tab: "项目资料".to_string(),
            focus: None,
        })
        .collect();

    let mut pending = Vec::new();
    for kind in NoteKind::ALL {
        for note in crate::project::scan_notes(project, kind)? {
            let pending_state = note
                .status
                .as_deref()
                .is_some_and(|status| matches!(status.trim(), "待打磨" | "待处理"));
            if pending_state {
                pending.push(IdeationOverviewItem {
                    name: note.name.clone(),
                    detail: note.status.clone(),
                    tab: kind.name().to_string(),
                    focus: if kind == NoteKind::Character {
                        Some(note.name)
                    } else {
                        None
                    },
                });
            }
        }
    }

    let reader_imagination = if !circle.types.is_empty() {
        Some(circle.types.join("、"))
    } else {
        first_meaningful_line(&circle.body)
    };

    Ok(IdeationOverview {
        logline: section_first_line(&outline.body, &["立意", "作品一句话", "一句话"]),
        reader_imagination,
        mainlines: mainlines
            .lines
            .into_iter()
            .map(|line| IdeationOverviewItem {
                detail: if line.milestones.is_empty() {
                    None
                } else {
                    Some(
                        line.milestones
                            .iter()
                            .take(3)
                            .map(|milestone| milestone.title.as_str())
                            .collect::<Vec<_>>()
                            .join(" → "),
                    )
                },
                name: line.name,
                tab: "大纲".to_string(),
                focus: None,
            })
            .collect(),
        characters,
        maps,
        pending,
        unresolved: section_lines(&outline.body, "尚未解决"),
    })
}

fn first_meaningful_line(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(clean_list_prefix)
        .filter(|line| !line.is_empty())
}

fn clean_list_prefix(line: &str) -> String {
    line.trim()
        .trim_start_matches("- ")
        .trim_start_matches("* ")
        .trim_start_matches("+ ")
        .trim()
        .to_string()
}

fn heading_title(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('#')?;
    let title = rest.trim_start_matches('#').trim();
    (!title.is_empty()).then_some(title)
}

fn section_first_line(body: &str, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| section_lines(body, name).into_iter().next())
}

fn section_lines(body: &str, section: &str) -> Vec<String> {
    let mut inside = false;
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(title) = heading_title(line) {
            if inside {
                break;
            }
            inside = title == section;
            continue;
        }
        if !inside {
            continue;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let line = clean_list_prefix(line);
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gongbi-ideation-{nonce}"));
        fs::create_dir_all(root.join("构思")).expect("create temp project");
        root
    }

    #[test]
    fn 构思首页从大纲现读作品一句话和尚未解决且不写副本() {
        let project = temp_project();
        fs::write(
            project.join("构思").join("大纲.md"),
            "# 立意\n\n谨慎的人也必须走出门。\n\n# 尚未解决\n\n- 为什么现在出发？\n- 第一站去哪里？\n",
        )
        .expect("write outline");
        let before = fs::read_dir(project.join("构思")).expect("before").count();

        let overview = read_ideation_overview(&project).expect("overview");

        assert_eq!(overview.logline.as_deref(), Some("谨慎的人也必须走出门。"));
        assert_eq!(
            overview.unresolved,
            vec!["为什么现在出发？".to_string(), "第一站去哪里？".to_string()]
        );
        assert_eq!(fs::read_dir(project.join("构思")).expect("after").count(), before);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn 构思首页汇总读者遐想主线人物地图与待打磨内容() {
        let project = temp_project();
        fs::write(
            project.join("构思").join("类型圈.md"),
            "---\n类型:\n  - 冒险\n  - 搜刮\n---\n\n读者想看准备转化成真正的行动。\n",
        )
        .expect("circle");
        fs::write(
            project.join("构思").join("主线.yaml"),
            "- 名称: 出发\n  主线: true\n  里程碑:\n    - 标题: 离开村庄\n",
        )
        .expect("mainline");
        fs::write(project.join("项目.yaml"), "地图:\n  - 边境村\n").expect("meta");
        fs::create_dir_all(project.join("构思").join("人物")).expect("characters");
        fs::write(
            project.join("构思").join("人物").join("里昂.md"),
            "谨慎，但想去看看世界。\n",
        )
        .expect("character");
        fs::create_dir_all(project.join("构思").join("开头")).expect("openings");
        fs::write(
            project.join("构思").join("开头").join("版本A.md"),
            "---\n状态: 待打磨\n---\n\n从出发前一晚切入。\n",
        )
        .expect("opening");

        let overview = read_ideation_overview(&project).expect("overview");
        assert_eq!(overview.reader_imagination.as_deref(), Some("冒险、搜刮"));
        assert_eq!(overview.mainlines[0].name, "出发");
        assert_eq!(overview.characters[0].name, "里昂");
        assert_eq!(overview.maps[0].name, "边境村");
        assert_eq!(overview.pending[0].name, "版本A");
        let _ = fs::remove_dir_all(project);
    }
}
