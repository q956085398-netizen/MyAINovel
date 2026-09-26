//! 构思首页只读模型（工单 #57）：从项目现有文件即时派生，不保存摘要副本，
//! 也不计算完成度。

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeationOverview {
    pub premise: Option<String>,
    pub mainline: Option<String>,
    pub reader_imaginations: Vec<String>,
    pub characters: Vec<OverviewItem>,
    pub maps: Vec<OverviewItem>,
    pub pending: Vec<OverviewItem>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewItem {
    pub tab: String,
    pub name: String,
    pub summary: Option<String>,
}

pub fn read_ideation_overview(project: &Path) -> Result<IdeationOverview, String> {
    let outline = crate::planning::read_outline(project)?;
    let circle = crate::project::read_circle(project)?;
    let mainlines = crate::planning::read_mainlines(project)?;
    let mainline = mainlines
        .lines
        .iter()
        .find(|line| line.is_main)
        .or_else(|| mainlines.lines.first())
        .map(|line| match line.milestones.first() {
            Some(milestone) => format!("{} · {}", line.name, milestone.title),
            None => line.name.clone(),
        });

    let characters = crate::project::scan_notes(project, crate::project::NoteKind::Character)?;
    let character_items = characters
        .iter()
        .map(|note| OverviewItem {
            tab: "人物".into(),
            name: note.name.clone(),
            summary: first_content_line(&note.body),
        })
        .collect::<Vec<_>>();

    let map_workspace = crate::map::map_workspace(project)?;
    let map_items = map_workspace
        .maps
        .iter()
        .map(|map| OverviewItem {
            tab: "地图".into(),
            name: map.name.clone(),
            summary: map.role.clone().or_else(|| first_content_line(&map.body)),
        })
        .collect::<Vec<_>>();

    let mut pending = Vec::new();
    for kind in crate::project::NoteKind::ALL {
        for note in crate::project::scan_notes(project, kind)? {
            if note.pending {
                pending.push(OverviewItem {
                    tab: kind.name().into(),
                    name: note.name,
                    summary: first_content_line(&note.body),
                });
            }
        }
    }
    pending.extend(
        map_workspace
            .maps
            .iter()
            .filter(|map| map.pending)
            .map(|map| OverviewItem {
                tab: "地图".into(),
                name: map.name.clone(),
                summary: map.role.clone().or_else(|| first_content_line(&map.body)),
            }),
    );
    pending.extend(
        map_workspace
            .regions
            .iter()
            .filter(|region| region.pending)
            .map(|region| OverviewItem {
                tab: "地图".into(),
                name: region.name.clone(),
                summary: region
                    .plot_role
                    .clone()
                    .or_else(|| first_content_line(&region.body)),
            }),
    );

    Ok(IdeationOverview {
        premise: section_items(&outline.body, "立意").into_iter().next(),
        mainline,
        reader_imaginations: circle.types,
        characters: character_items,
        maps: map_items,
        pending,
        unresolved: section_items(&outline.body, "尚未解决"),
    })
}

fn first_content_line(markdown: &str) -> Option<String> {
    markdown
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.trim_start_matches(['-', '*']).trim().to_string())
        .filter(|line| !line.is_empty())
}

fn section_items(markdown: &str, heading: &str) -> Vec<String> {
    let mut inside = false;
    let mut items = Vec::new();
    for raw in markdown.lines() {
        let line = raw.trim();
        if let Some(title) = line.strip_prefix("## ") {
            inside = title.trim() == heading;
            continue;
        }
        if inside && line.starts_with('#') {
            break;
        }
        if !inside || line.is_empty() {
            continue;
        }
        let item = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .unwrap_or(line)
            .trim();
        if !item.is_empty() {
            items.push(item.to_string());
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn 构思首页从大纲现读作品一句话和尚未解决且不写副本() {
        let temp = tempdir().unwrap();
        let project = temp.path().join("项目/《雾港》");
        let outline = project.join("构思/大纲.md");
        write(
            &outline,
            "## 立意\n\n失忆侦探追查一座会从记录中消失的港城。\n\n## 阶段构想\n\n先找到第七码头。\n\n## 尚未解决\n\n- 谁删掉了城市记录？\n- 主角为何记得第七码头？\n",
        );

        let before = fs::read_dir(project.join("构思")).unwrap().count();
        let overview = read_ideation_overview(&project).unwrap();

        assert_eq!(
            overview.premise.as_deref(),
            Some("失忆侦探追查一座会从记录中消失的港城。")
        );
        assert_eq!(
            overview.unresolved,
            ["谁删掉了城市记录？", "主角为何记得第七码头？"]
        );
        assert_eq!(fs::read_dir(project.join("构思")).unwrap().count(), before);
    }

    #[test]
    fn 构思首页汇总读者遐想主线人物地图与待打磨内容() {
        let temp = tempdir().unwrap();
        let project = temp.path().join("项目/《雾港》");
        write(
            &project.join("构思/类型圈.md"),
            "---\n类型: [抽丝剥茧, 身份揭晓]\n---\n读者想看真相一层层翻开。\n",
        );
        write(
            &project.join("构思/主线.yaml"),
            "- 名称: 找回第七码头\n  主线: true\n  里程碑:\n    - 标题: 找到消失的航海日志\n",
        );
        write(
            &project.join("构思/人物/祁雁.md"),
            "---\n待打磨: true\n---\n失忆侦探，记得不存在的码头。\n",
        );
        write(
            &project.join("构思/地图/雾港.md"),
            "---\n故事作用: 全书谜面\n待打磨: true\n---\n三面临海的港城。\n",
        );

        let overview = read_ideation_overview(&project).unwrap();

        assert_eq!(overview.reader_imaginations, ["抽丝剥茧", "身份揭晓"]);
        assert_eq!(
            overview.mainline.as_deref(),
            Some("找回第七码头 · 找到消失的航海日志")
        );
        assert_eq!(overview.characters[0].name, "祁雁");
        assert_eq!(overview.characters[0].tab, "人物");
        assert_eq!(overview.maps[0].name, "雾港");
        assert_eq!(
            overview
                .pending
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["祁雁", "雾港"]
        );
    }
}
