//! 书库全文搜索（设计共识 §五）：跨书逐行找子串（大小写不敏感），
//! 命中返回书名、行号与片段。个人库规模（百来本、几十 MB）请求时
//! 全量扫盘即可，不建索引（ADR 0002：索引只是缓存，先不做）。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::book_file::{sibling_yaml_path, strip_bom};
use crate::library::collect_book_files;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book_name: String,
    pub primary_md: PathBuf,
    /// 1 起行号。
    pub line: u32,
    pub snippet: String,
}

/// 命中上限：防巨库 payload 涨爆；达到即停止扫描，前端按上限提示截断。
pub const MAX_HITS: usize = 200;
const SNIPPET_CHARS: usize = 80;

pub fn search_library(root: &Path, query: &str) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    'outer: for files in collect_book_files(root)? {
        // 主文件同名 .yaml（书级四项、桥段标注）也是这本书拆书记录的一部分。
        let yaml = sibling_yaml_path(&files.primary_md);
        let docs = files
            .mds
            .iter()
            .chain(yaml.is_file().then_some(&yaml).into_iter());
        for doc in docs {
            scan_doc(doc, &files.name, &files.primary_md, &needle, &mut hits);
            if hits.len() >= MAX_HITS {
                break 'outer;
            }
        }
    }
    Ok(hits)
}

/// 逐行扫一个文档，命中即入列；达上限提前收手。
fn scan_doc(
    doc: &Path,
    book_name: &str,
    primary_md: &Path,
    needle_lower: &str,
    hits: &mut Vec<SearchHit>,
) {
    let Ok(bytes) = fs::read(doc) else {
        return;
    };
    let raw = String::from_utf8_lossy(&bytes);
    for (idx, line) in strip_bom(&raw).lines().enumerate() {
        if !line.to_lowercase().contains(needle_lower) {
            continue;
        }
        hits.push(SearchHit {
            book_name: book_name.to_string(),
            primary_md: primary_md.to_path_buf(),
            line: idx as u32 + 1,
            snippet: snippet_of(line, needle_lower),
        });
        if hits.len() >= MAX_HITS {
            return;
        }
    }
}

/// 片段：整行 trim 后压到 SNIPPET_CHARS 字内；超长行把窗口锚在首个命中
/// （大小写不敏感定位，to_lowercase 的字符数与原文在中英文场景一致，
/// 异形折叠属极端、接受近似），两端加省略号。
fn snippet_of(line: &str, needle_lower: &str) -> String {
    let line = line.trim();
    let total = line.chars().count();
    if total <= SNIPPET_CHARS {
        return line.to_string();
    }
    let lowered = line.to_lowercase();
    let hit_at = lowered
        .find(needle_lower)
        .map_or(0, |byte| lowered[..byte].chars().count());
    let start = hit_at
        .saturating_sub(10)
        .min(total.saturating_sub(SNIPPET_CHARS));
    let end = (start + SNIPPET_CHARS).min(total);
    let mut s: String = line.chars().skip(start).take(end - start).collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < total {
        s.push('…');
    }
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

    #[test]
    fn 跨书命中_散文件与一书一文件夹_都带书名行号() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("散书.md"), "开头\n这里有金手指设定\n结尾");
        write(&root.join("《夹书》/拆书.md"), "第一行\n第二行提到金手指");

        let hits = search_library(&root, "金手指").unwrap();
        assert_eq!(hits.len(), 2);
        let 散 = hits.iter().find(|h| h.book_name == "散书").unwrap();
        assert_eq!(散.line, 2);
        assert_eq!(散.snippet, "这里有金手指设定");
        let 夹 = hits.iter().find(|h| h.book_name == "《夹书》").unwrap();
        assert_eq!(夹.line, 2);
        assert!(夹.primary_md.ends_with("拆书.md"));
    }

    #[test]
    fn 一书一文件夹_所有_md_都参与搜索() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书/拆书.md"), "主文件不谈这事");
        write(&root.join("书/番外.md"), "番外里有目标词");

        let hits = search_library(&root, "目标词").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].book_name, "书");
        assert_eq!(hits[0].snippet, "番外里有目标词");
    }

    #[test]
    fn yaml_侧_也参与搜索() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("散书.md"), "正文里没有目标词");
        write(&root.join("散书.yaml"), "书名: 散书\n金手指: 签到系统\n");

        let hits = search_library(&root, "签到系统").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].book_name, "散书");
        assert_eq!(hits[0].line, 2);
        assert!(hits[0].snippet.contains("签到系统"));
    }

    #[test]
    fn 大小写不匹配的长行_片段仍包含命中词() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let long = format!("{}NeEdLe{}", "A".repeat(100), "b".repeat(100));
        write(&root.join("书.md"), &long);

        let hits = search_library(&root, "needle").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.contains("NeEdLe"),
            "片段应保留原文命中词：{}",
            hits[0].snippet
        );
    }

    #[test]
    fn 灵感库目录_不参与全文搜索() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书.md"), "正文一行");
        write(&root.join("灵感库/故事卡/某卡.md"), "卡片正文里有目标词");

        let hits = search_library(&root, "目标词").unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn 大小写不敏感() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书.md"), "Golden Finger 出现");

        assert_eq!(search_library(&root, "golden finger").unwrap().len(), 1);
        assert_eq!(search_library(&root, "GOLDEN").unwrap().len(), 1);
    }

    #[test]
    fn 空白查询_与无命中_返回空() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书.md"), "正文");

        assert!(search_library(&root, "   ").unwrap().is_empty());
        assert!(search_library(&root, "不存在的词").unwrap().is_empty());
    }

    #[test]
    fn 命中达上限_停止扫描() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let lines: Vec<String> = (0..MAX_HITS + 50)
            .map(|i| format!("第{i}行 needle 出现"))
            .collect();
        write(&root.join("书.md"), &lines.join("\n"));

        let hits = search_library(&root, "needle").unwrap();
        assert_eq!(hits.len(), MAX_HITS);
    }

    #[test]
    fn 长行_片段截断带省略号_不超上限() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let long = format!("{}needle{}", "前".repeat(100), "后".repeat(100));
        write(&root.join("书.md"), &long);

        let hits = search_library(&root, "needle").unwrap();
        assert_eq!(hits.len(), 1);
        let snippet = &hits[0].snippet;
        assert!(snippet.starts_with('…'), "{snippet}");
        assert!(snippet.ends_with('…'), "{snippet}");
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 2);
        assert!(snippet.contains("needle"));
    }
}
