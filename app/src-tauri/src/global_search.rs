//! Ctrl+K 的只读检索边界。只扫描明确的创作目录，身份为项目＋类型＋文件/条目名。
use crate::book_file::{has_md_extension, is_hidden, map_scalar, read_text, split_frontmatter};
use serde::Serialize;
use serde_yaml::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const MAX_RESULTS: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchMatch {
    pub field: String,
    pub line: u32,
    pub snippet: String,
    /// 原文中的命中（保留大小写），供正文定位使用。
    pub quote: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchHit {
    pub kind: String,
    pub title: String,
    pub path: PathBuf,
    pub project_dir: Option<PathBuf>,
    pub project_title: Option<String>,
    pub category: Option<String>,
    pub matches: Vec<GlobalSearchMatch>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchReport {
    pub hits: Vec<GlobalSearchHit>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

fn children(dir: &Path, directories: bool, report: &mut GlobalSearchReport) -> Vec<PathBuf> {
    if !dir.exists() {
        return vec![];
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            report
                .warnings
                .push(format!("无法读取 {}：{e}", dir.display()));
            return vec![];
        }
    };
    let mut paths = vec![];
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                // 不跟随快捷链接进入缓存、导出目录或库外文件。
                if !is_hidden(&path)
                    && entry.file_type().is_ok_and(|t| {
                        if directories {
                            t.is_dir()
                        } else {
                            t.is_file()
                        }
                    })
                {
                    paths.push(path);
                }
            }
            Err(e) => report
                .warnings
                .push(format!("读取 {} 的条目失败：{e}", dir.display())),
        }
    }
    paths.sort();
    paths
}

fn matches(text: &str, field: &str, line: u32, needle: &str) -> Option<GlobalSearchMatch> {
    let lower = text.to_lowercase();
    let byte = lower.find(needle)?;
    let start = lower[..byte].chars().count();
    let length = needle.chars().count();
    let chars: Vec<char> = text.chars().collect();
    let from = start.saturating_sub(25);
    let to = (start + length + 55).min(chars.len());
    let quote = chars.iter().skip(start).take(length).collect();
    let snippet = format!(
        "{}{}{}",
        if from > 0 { "…" } else { "" },
        chars[from..to].iter().collect::<String>(),
        if to < chars.len() { "…" } else { "" }
    );
    Some(GlobalSearchMatch {
        field: field.into(),
        line,
        snippet,
        quote,
    })
}

fn document_matches(raw: &str, title: &str, needle: &str) -> Vec<GlobalSearchMatch> {
    let mut found: Vec<_> = matches(title, "标题", 0, needle).into_iter().collect();
    let header_end = if raw.trim_start_matches('\u{feff}').starts_with("---\n")
        || raw.trim_start_matches('\u{feff}').starts_with("---\r\n")
    {
        raw.lines()
            .enumerate()
            .skip(1)
            .find(|(_, line)| line.trim() == "---")
            .map(|(index, _)| index)
    } else {
        None
    };
    let mut field = "结构字段".to_string();
    for (index, line) in raw.lines().enumerate() {
        let in_header = header_end.is_some_and(|end| index > 0 && index < end);
        if in_header {
            if let Some((key, _)) = line.split_once(':') {
                if !line.starts_with(' ') {
                    field = key.trim().to_string();
                }
            }
        }
        if let Some(hit) = matches(
            line,
            if in_header { &field } else { "正文" },
            index as u32 + 1,
            needle,
        ) {
            found.push(hit);
        }
        if found.len() >= 8 {
            break;
        }
    }
    found
}

fn add_document(
    report: &mut GlobalSearchReport,
    path: PathBuf,
    kind: &str,
    title: String,
    project: Option<(&Path, &str)>,
    category: Option<String>,
    needle: &str,
) {
    if report.truncated {
        return;
    }
    let raw = if path.is_file() {
        match read_text(&path) {
            Ok(raw) => raw,
            Err(e) => {
                report.warnings.push(e);
                return;
            }
        }
    } else {
        String::new()
    };
    // 损坏的 frontmatter 保留正文检索能力，但明确提示，不修写文件。
    if has_md_extension(&path) {
        if let Some((yaml, _)) = split_frontmatter(&raw) {
            if let Err(e) = serde_yaml::from_str::<serde_yaml::Mapping>(&yaml) {
                report
                    .warnings
                    .push(format!("{} 的结构字段损坏：{e}", path.display()));
            }
        }
    }
    let matches = document_matches(&raw, &title, needle);
    if matches.is_empty() {
        return;
    }
    if report.hits.len() == MAX_RESULTS {
        report.truncated = true;
        return;
    }
    report.hits.push(GlobalSearchHit {
        kind: kind.into(),
        title,
        path,
        project_dir: project.map(|p| p.0.to_path_buf()),
        project_title: project.map(|p| p.1.to_string()),
        category,
        matches,
    });
}

fn add_threads(
    report: &mut GlobalSearchReport,
    project: &Path,
    title: &str,
    kind: &str,
    file: &str,
    needle: &str,
) {
    let path = project.join(file);
    if !path.is_file() || report.truncated {
        return;
    }
    let validated = if kind == "伏笔" {
        crate::foreshadow::read_foreshadows(project).map(|_| ())
    } else {
        crate::expectation::read_expectations(project).map(|_| ())
    };
    if let Err(e) = validated {
        report.warnings.push(e);
        return;
    }
    let rows = match read_text(&path)
        .and_then(|raw| serde_yaml::from_str::<Vec<Value>>(&raw).map_err(|e| e.to_string()))
    {
        Ok(rows) => rows,
        Err(e) => {
            report.warnings.push(format!("{}：{e}", path.display()));
            return;
        }
    };
    for row in rows {
        let Some(map) = row.as_mapping() else {
            continue;
        };
        let Some(name) = map_scalar(map, "名") else {
            continue;
        };
        let mut found: Vec<_> = matches(&name, "标题", 0, needle).into_iter().collect();
        for (key, value) in map {
            let Some(field) = key.as_str() else {
                continue;
            };
            if let Some(hit) = matches(
                &serde_yaml::to_string(value).unwrap_or_default(),
                field,
                0,
                needle,
            ) {
                found.push(hit);
            }
        }
        if found.is_empty() {
            continue;
        }
        if report.hits.len() == MAX_RESULTS {
            report.truncated = true;
            return;
        }
        report.hits.push(GlobalSearchHit {
            kind: kind.into(),
            title: name,
            path: path.clone(),
            project_dir: Some(project.to_path_buf()),
            project_title: Some(title.into()),
            category: map_scalar(map, "类别"),
            matches: found,
        });
    }
}

pub fn search(root: &Path, query: &str) -> Result<GlobalSearchReport, String> {
    if !root.is_dir() {
        return Err("请先打开有效的库文件夹".into());
    }
    let needle = query.trim().to_lowercase();
    let mut report = GlobalSearchReport::default();
    if needle.is_empty() {
        return Ok(report);
    }
    for book in crate::library::collect_book_files(root)? {
        for path in book.mds {
            if path.strip_prefix(root).is_ok_and(|p| {
                p.iter()
                    .any(|part| part == "导出" || part == "附件" || part == "缓存")
            }) {
                continue;
            }
            add_document(
                &mut report,
                path,
                "拆书",
                book.name.clone(),
                None,
                None,
                &needle,
            );
            if report.truncated {
                break;
            }
        }
        if report.truncated {
            break;
        }
    }
    for project in children(&root.join("项目"), true, &mut report) {
        if report.truncated {
            break;
        }
        let title = crate::project::read_project_meta(&project)
            .ok()
            .and_then(|m| m.title)
            .unwrap_or_else(|| {
                project
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .trim_matches(['《', '》'])
                    .to_string()
            });
        add_document(
            &mut report,
            project.join("项目.yaml"),
            "项目",
            title.clone(),
            Some((&project, &title)),
            None,
            &needle,
        );
        for (dir, kind) in [
            ("正文", "章节"),
            ("构思/人物", "人物"),
            ("构思/组织", "组织"),
            ("构思/地图", "地图"),
            ("构思/地域", "地域"),
            ("构思/单元", "单元"),
            ("构思/桥段", "桥段"),
            ("构思/矛盾", "矛盾"),
            ("构思/世界观", "世界观"),
            ("构思/开头", "开头"),
        ] {
            for path in children(&project.join(dir), false, &mut report) {
                if has_md_extension(&path) {
                    let name = path.file_stem().unwrap().to_string_lossy().into_owned();
                    add_document(
                        &mut report,
                        path,
                        kind,
                        name,
                        Some((&project, &title)),
                        None,
                        &needle,
                    );
                }
                if report.truncated {
                    break;
                }
            }
            if report.truncated {
                break;
            }
        }
        add_threads(&mut report, &project, &title, "伏笔", "伏笔.yaml", &needle);
        add_threads(
            &mut report,
            &project,
            &title,
            "期待线",
            "三线.yaml",
            &needle,
        );
    }
    for category_dir in children(&root.join("灵感库"), true, &mut report) {
        let category = category_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        for path in children(&category_dir, false, &mut report) {
            if has_md_extension(&path) {
                let title = path.file_stem().unwrap().to_string_lossy().into_owned();
                add_document(
                    &mut report,
                    path,
                    "灵感",
                    title,
                    None,
                    Some(category.clone()),
                    &needle,
                );
            }
            if report.truncated {
                break;
            }
        }
        if report.truncated {
            break;
        }
    }
    Ok(report)
}

/// 展开结果时现读权威文件；仅允许与搜索相同的创作目录。
pub fn preview(root: &Path, path: &Path, name: &str) -> Result<String, String> {
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let absolute = path.canonicalize().map_err(|e| e.to_string())?;
    let relative = absolute
        .strip_prefix(&base)
        .map_err(|_| "结果已不在当前库中")?;
    let parts: Vec<_> = relative
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if parts.iter().any(|part| part.starts_with('.')) {
        return Err("搜索不读取应用缓存或隐藏文件".into());
    }
    if parts
        .iter()
        .any(|part| ["导出", "附件", "缓存"].contains(&part.as_str()))
    {
        return Err("搜索不读取导出产物、附件或缓存".into());
    }
    let project_doc = parts.first().is_some_and(|p| p == "项目")
        && match parts.as_slice() {
            [_, _, file] => ["项目.yaml", "伏笔.yaml", "三线.yaml"].contains(&file.as_str()),
            [_, _, dir, file] => dir == "正文" && has_md_extension(Path::new(file)),
            [_, _, concept, kind, file] => {
                concept == "构思"
                    && [
                        "人物",
                        "组织",
                        "地图",
                        "地域",
                        "单元",
                        "桥段",
                        "矛盾",
                        "世界观",
                        "开头",
                    ]
                    .contains(&kind.as_str())
                    && has_md_extension(Path::new(file))
            }
            _ => false,
        };
    let inspiration = parts.len() == 3 && parts[0] == "灵感库" && has_md_extension(&absolute);
    let book = crate::library::collect_book_files(root)?
        .iter()
        .any(|book| {
            book.mds
                .iter()
                .any(|md| md.canonicalize().ok().as_ref() == Some(&absolute))
        });
    if !project_doc && !inspiration && !book {
        return Err("不是可搜索的创作文件".into());
    }
    let raw = read_text(&absolute)?;
    if parts
        .last()
        .is_some_and(|p| p == "伏笔.yaml" || p == "三线.yaml")
    {
        let rows: Vec<Value> = serde_yaml::from_str(&raw).map_err(|e| e.to_string())?;
        let row = rows
            .into_iter()
            .find(|row| {
                row.as_mapping()
                    .and_then(|m| map_scalar(m, "名"))
                    .as_deref()
                    == Some(name)
            })
            .ok_or("条目已被改名或删除，请重新搜索")?;
        return serde_yaml::to_string(&row).map_err(|e| e.to_string());
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    #[test]
    fn 全局搜索区分同名实体与项目_字段正文及未编号章节均可定位() {
        let root = TempDir::new().unwrap();
        for project in ["甲", "乙"] {
            for kind in [
                "人物",
                "组织",
                "地图",
                "地域",
                "单元",
                "桥段",
                "矛盾",
                "世界观",
                "开头",
            ] {
                write(
                    root.path(),
                    &format!("项目/{project}/构思/{kind}/晨光.md"),
                    "---\n秘密: 中文线索\n---\n正文中文线索",
                );
            }
            write(
                root.path(),
                &format!("项目/{project}/正文/未编号.md"),
                "开头\n中文线索",
            );
        }
        let result = search(root.path(), "中文线索").unwrap();
        assert_eq!(result.hits.len(), 20);
        assert!(result.hits.iter().all(|hit| hit.project_dir.is_some()));
        let person = result.hits.iter().find(|hit| hit.kind == "人物").unwrap();
        assert_eq!(person.matches[0].field, "秘密");
        assert_eq!(person.matches[1].field, "正文");
        assert_eq!(person.matches[1].line, 4);
        let chapter = result.hits.iter().find(|hit| hit.kind == "章节").unwrap();
        assert_eq!(chapter.matches[0].line, 2);
        let titled = search(root.path(), "晨光").unwrap();
        assert_eq!(titled.hits.len(), 18);
        assert_eq!(titled.hits[0].matches[0].field, "标题");
    }

    #[test]
    fn 线索按条目定位_灵感拆书参与_损坏文件告警_搜索不写文件() {
        let root = TempDir::new().unwrap();
        write(
            root.path(),
            "项目/甲/伏笔.yaml",
            "- 名: 铜铃\n  状态: 待埋\n- 名: 铃声\n  埋设:\n    - 章: 1\n      引文: 铜铃响起\n",
        );
        write(
            root.path(),
            "项目/甲/三线.yaml",
            "- 名: 回家\n  类别: 目标\n  档位: 长\n  埋设:\n    - 章: 1\n      引文: 铜铃声\n",
        );
        write(root.path(), "灵感库/故事卡/铃声.md", "铜铃故事");
        write(root.path(), "《拆书》/拆书.md", "铜铃桥段");
        write(root.path(), "项目/坏/伏笔.yaml", "破损: [");
        write(
            root.path(),
            "项目/甲/构思/人物/坏.md",
            "---\n秘密: [\n---\n铜铃\n",
        );
        let watched = root.path().join("项目/甲/构思/人物/坏.md");
        let before = fs::read(&watched).unwrap();
        let stamp = fs::metadata(&watched).unwrap().modified().unwrap();
        let result = search(root.path(), "铜铃").unwrap();
        assert_eq!(result.hits.len(), 6);
        assert!(result.hits.iter().any(|h| h.kind == "拆书"));
        let expectation = result.hits.iter().find(|h| h.kind == "期待线").unwrap();
        assert_eq!(expectation.category.as_deref(), Some("目标"));
        assert_eq!(expectation.title, "回家");
        assert_eq!(result.warnings.len(), 2);
        assert_eq!(before, fs::read(&watched).unwrap());
        assert_eq!(stamp, fs::metadata(&watched).unwrap().modified().unwrap());
    }

    #[test]
    fn 跳过导出缓存附件_全文预览拒绝非创作文件_空查询与上限() {
        let root = TempDir::new().unwrap();
        for path in [
            "项目/甲/导出/产物.md",
            "导出/产物.md",
            "项目/甲/.gongbi/历史/旧章.md",
            "项目/甲/附件/说明.md",
            ".gongbi/缓存.md",
            "灵感库/故事卡/.旧.md",
        ] {
            write(root.path(), path, "不该检索");
            assert!(preview(root.path(), &root.path().join(path), "").is_err());
        }
        assert!(search(root.path(), "不该检索").unwrap().hits.is_empty());
        write(root.path(), "项目/甲/正文/未编号.md", "可读正文");
        assert_eq!(
            preview(root.path(), &root.path().join("项目/甲/正文/未编号.md"), "").unwrap(),
            "可读正文"
        );
        assert!(search(root.path(), "  ").unwrap().hits.is_empty());
        for n in 0..MAX_RESULTS + 1 {
            write(root.path(), &format!("项目/甲/构思/人物/{n}.md"), "命中词");
        }
        let result = search(root.path(), "命中词").unwrap();
        assert_eq!(result.hits.len(), MAX_RESULTS);
        assert!(result.truncated);
    }
}
