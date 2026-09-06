//! 拆书稿文件操作：正文读写、书级元数据（双文件制的 .yaml 侧）、
//! 粘贴截图落盘、下一章前缀计算。写入均走临时文件＋改名（ADR 0002）。
//!
//! BookMeta 走 Tauri IPC（camelCase JSON）；yaml 侧键为中文且合并保留
//! 未知键——用户在 Obsidian 手补的字段不能被「书级资料」保存抹掉。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::library::{chapter_digits, is_chapter_heading};

/// 书级元数据 v0：字段按设计共识 §四的书级四项＋章前缀模板。
/// 最终 schema 由工单 #13 定稿。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub title: Option<String>,
    pub track_record: Option<String>,
    pub summary: Option<String>,
    pub golden_finger: Option<String>,
    pub chapter_prefix: Option<String>,
}

pub const DEFAULT_CHAPTER_PREFIX: &str = "第{n}章";

pub fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("无法读取文件 {}：{e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        "{}.gongbi.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed")
    ));
    if let Err(e) = fs::write(&tmp, content) {
        return Err(format!("无法写入临时文件 {}：{e}", tmp.display()));
    }
    // std 的 rename 在 Windows 上带 REPLACE_EXISTING，可直接覆盖。
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法保存文件 {}：{e}", path.display()));
    }
    Ok(())
}

fn sibling_yaml_path(md_path: &Path) -> PathBuf {
    let mut yaml = md_path.to_path_buf();
    yaml.set_extension("yaml");
    yaml
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn mapping_get(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(Value::String(key.to_string()))
        .and_then(scalar_to_string)
}

fn mapping_set(map: &mut serde_yaml::Mapping, key: &str, value: Option<&str>) {
    let k = Value::String(key.to_string());
    match value {
        Some(s) => {
            let v = coerce_like(map.get(&k), s);
            map.insert(k, v);
        }
        None => {
            map.remove(&k);
        }
    }
}

/// 新值与旧值同形时保持标量类型：yaml 里的「成绩: 20000」
/// 不会因为走了一趟表单就变成带引号的 '20000'。
fn coerce_like(old: Option<&Value>, s: &str) -> Value {
    match old {
        Some(Value::Number(_)) => {
            if let Ok(i) = s.parse::<i64>() {
                return Value::Number(i.into());
            }
            if let Ok(f) = s.parse::<f64>() {
                return Value::Number(f.into());
            }
        }
        Some(Value::Bool(_)) => {
            if let Ok(b) = s.parse::<bool>() {
                return Value::Bool(b);
            }
        }
        _ => {}
    }
    Value::String(s.to_string())
}

pub fn read_book_meta(md_path: &Path) -> Result<BookMeta, String> {
    let yaml = sibling_yaml_path(md_path);
    if !yaml.is_file() {
        return Ok(BookMeta::default());
    }
    let text = read_text(&yaml)?;
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", yaml.display()))?;
    let map = value.as_mapping();
    Ok(BookMeta {
        title: map.and_then(|m| mapping_get(m, "书名")),
        track_record: map.and_then(|m| mapping_get(m, "成绩")),
        summary: map.and_then(|m| mapping_get(m, "简介")),
        golden_finger: map.and_then(|m| mapping_get(m, "金手指")),
        chapter_prefix: map.and_then(|m| mapping_get(m, "章前缀")),
    })
}

pub fn write_book_meta(md_path: &Path, meta: &BookMeta) -> Result<(), String> {
    let yaml = sibling_yaml_path(md_path);
    // 以现有 yaml 为底合并：未知键原样保留；解析失败的旧文件按空底处理
    // （前端在读到解析错误时会先警告）。
    let base = read_text(&yaml)
        .ok()
        .and_then(|t| serde_yaml::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let mut map = match base {
        Value::Mapping(m) => m,
        _ => serde_yaml::Mapping::new(),
    };
    mapping_set(&mut map, "书名", meta.title.as_deref());
    mapping_set(&mut map, "成绩", meta.track_record.as_deref());
    mapping_set(&mut map, "简介", meta.summary.as_deref());
    mapping_set(&mut map, "金手指", meta.golden_finger.as_deref());
    mapping_set(&mut map, "章前缀", meta.chapter_prefix.as_deref());

    let text =
        serde_yaml::to_string(&Value::Mapping(map)).map_err(|e| format!("无法生成 yaml：{e}"))?;
    write_text_atomic(&yaml, &text)
}

/// 粘贴截图的落盘位置：一书一文件夹（拆书.md）用书内「附件/」；
/// 根目录散文件的 .md 与其他书同层，各建「附件/<书名>/」避免混放。
fn attachment_subdir(md_path: &Path) -> PathBuf {
    match md_path.file_name().and_then(|n| n.to_str()) {
        Some("拆书.md") => PathBuf::from("附件"),
        _ => PathBuf::from("附件").join(file_stem_of(md_path)),
    }
}

fn file_stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 保存一张剪贴板图片，返回可直接嵌入 markdown 的相对路径（正斜杠）。
/// 文件名「截图-N.ext」按目录内现有编号递增，保证唯一。
pub fn save_paste_image(md_path: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let sub = attachment_subdir(md_path);
    let dir = md_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&sub);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建附件文件夹 {}：{e}", dir.display()))?;

    let mut n: u32 = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().into_string().ok() else {
                continue;
            };
            let Some(stem) = name.strip_suffix(&format!(".{ext}")) else {
                continue;
            };
            if let Some(num) = stem.strip_prefix("截图-") {
                if let Ok(v) = num.parse::<u32>() {
                    n = n.max(v);
                }
            }
        }
    }
    n += 1;

    let file_name = format!("截图-{n}.{ext}");
    fs::write(dir.join(&file_name), bytes).map_err(|e| format!("无法写入附件 {file_name}：{e}"))?;

    Ok(sub.join(&file_name).to_string_lossy().replace('\\', "/"))
}

/// 下一章前缀：优先按模板自身匹配到的最大编号续号；模板没匹配到过
/// 时退回「第X章」式标题（阿拉伯章号优先，否则按章标题行数＋1）。
/// 前缀/字数统计都是粗略启发，不追求精确（设计共识 §四）。
pub fn next_chapter_line(content: &str, template: &str) -> String {
    let template = if template.trim().is_empty() {
        DEFAULT_CHAPTER_PREFIX
    } else {
        template
    };
    let Some((pre, suf)) = template.split_once("{n}") else {
        return template.to_string();
    };

    let mut max_num: Option<u64> = None;
    let mut count: u64 = 0;
    for line in content.lines() {
        let t = line.trim_start_matches(['#', ' ', '\t']);
        let tmpl_num = template_number(t, pre, suf);
        let is_heading = is_chapter_heading(line);
        if tmpl_num.is_some() || is_heading {
            count += 1;
            let num = tmpl_num.or_else(|| {
                if is_heading {
                    chapter_digits(line).and_then(arabic_value)
                } else {
                    None
                }
            });
            if let Some(v) = num {
                max_num = Some(max_num.map_or(v, |m: u64| m.max(v)));
            }
        }
    }
    let n = max_num.map_or(count + 1, |m| m + 1);
    format!("{pre}{n}{suf}")
}

/// 行首按模板前缀匹配章号；后缀为空时取行首连续（全角）数字。
fn template_number(line: &str, pre: &str, suf: &str) -> Option<u64> {
    let rest = line.strip_prefix(pre)?;
    if suf.is_empty() {
        let digits: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || ('０'..='９').contains(c))
            .collect();
        return arabic_value(&digits);
    }
    let end = rest.find(suf)?;
    arabic_value(&rest[..end])
}

fn arabic_value(digits: &str) -> Option<u64> {
    let normalized: String = digits
        .chars()
        .map(|c| match c {
            '０'..='９' => char::from(b'0' + (c as u32 - '０' as u32) as u8),
            other => other,
        })
        .collect();
    normalized.parse().ok()
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
    fn 读写正文_往返一致() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "第一章\n旧内容");

        write_text_atomic(&md, "第一章\n新内容").unwrap();
        assert_eq!(read_text(&md).unwrap(), "第一章\n新内容");
        assert!(!root.join("书.md.gongbi.tmp").exists());
    }

    #[test]
    fn 元数据_ipc_走_camelCase() {
        let meta = BookMeta {
            title: Some("书名甲".into()),
            track_record: Some("均订 2 万".into()),
            golden_finger: Some("每日签到".into()),
            chapter_prefix: Some("第{n}章".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"trackRecord\""));
        assert!(json.contains("\"goldenFinger\""));
        let back: BookMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn 元数据_缺省为空_写入后往返() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");

        assert_eq!(read_book_meta(&md).unwrap(), BookMeta::default());

        let meta = BookMeta {
            title: Some("书名甲".into()),
            track_record: Some("均订 2 万".into()),
            summary: Some("少年得金手指".into()),
            golden_finger: Some("每日签到".into()),
            chapter_prefix: Some("第{n}章".into()),
        };
        write_book_meta(&md, &meta).unwrap();

        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(yaml_text.contains("书名: 书名甲"));
        assert!(yaml_text.contains("金手指: 每日签到"));

        assert_eq!(read_book_meta(&md).unwrap(), meta);
    }

    #[test]
    fn 元数据_保留未知键与数字标量() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(
            &root.join("书.yaml"),
            "书名: 旧名\n成绩: 20000\n自定义键: 保留我\n",
        );

        let meta = read_book_meta(&md).unwrap();
        assert_eq!(meta.title.as_deref(), Some("旧名"));
        assert_eq!(meta.track_record.as_deref(), Some("20000"));

        let mut updated = meta.clone();
        updated.title = Some("新名".into());
        write_book_meta(&md, &updated).unwrap();

        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(yaml_text.contains("自定义键: 保留我"));
        assert!(yaml_text.contains("书名: 新名"));
        assert!(yaml_text.contains("成绩: 20000"));
    }

    #[test]
    fn 元数据_清空字段_移除键() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "书名: 旧名\n自定义键: 保留我\n");

        write_book_meta(&md, &BookMeta::default()).unwrap();
        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(!yaml_text.contains("书名:"));
        assert!(yaml_text.contains("自定义键: 保留我"));
    }

    #[test]
    fn 元数据_损坏_yaml_报错不静默() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "{{{{不是 yaml");

        assert!(read_book_meta(&md).is_err());
    }

    #[test]
    fn 附件_一书一文件夹_落书内附件目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("《书》/拆书.md");
        write(&md, "");

        let rel = save_paste_image(&md, "png", b"png-bytes").unwrap();
        assert_eq!(rel, "附件/截图-1.png");
        assert_eq!(
            fs::read(root.join("《书》/附件/截图-1.png")).unwrap(),
            b"png-bytes"
        );

        let rel2 = save_paste_image(&md, "png", b"more").unwrap();
        assert_eq!(rel2, "附件/截图-2.png");
    }

    #[test]
    fn 附件_散文件_按书名分目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书乙.md");
        write(&md, "");

        let rel = save_paste_image(&md, "jpeg", b"jpg").unwrap();
        assert_eq!(rel, "附件/书乙/截图-1.jpeg");
        assert!(root.join("附件/书乙/截图-1.jpeg").is_file());
    }

    #[test]
    fn 下一章_默认模板_阿拉伯续号() {
        let content = "第1章\n正文\n## 第3章 标题\n正文";
        assert_eq!(next_chapter_line(content, DEFAULT_CHAPTER_PREFIX), "第4章");
    }

    #[test]
    fn 下一章_全角数字_按数值续号() {
        assert_eq!(next_chapter_line("第２０章\n", "第{n}章"), "第21章");
    }

    #[test]
    fn 下一章_中文数字_按行数续号() {
        assert_eq!(next_chapter_line("第一章\n第二章\n", "第{n}章"), "第3章");
    }

    #[test]
    fn 下一章_空文档_从第1章开始() {
        assert_eq!(next_chapter_line("", "第{n}章"), "第1章");
    }

    #[test]
    fn 下一章_自定义模板() {
        assert_eq!(next_chapter_line("第9章", "Chapter {n}: "), "Chapter 10: ");
    }

    #[test]
    fn 下一章_自定义模板_按模板自身续号() {
        assert_eq!(
            next_chapter_line("Chapter 1: 开\nChapter 9: 续", "Chapter {n}: "),
            "Chapter 10: "
        );
    }

    #[test]
    fn 下一章_模板无占位符_原样返回() {
        assert_eq!(next_chapter_line("x", "【场景】"), "【场景】");
    }

    #[test]
    fn 下一章_空模板_回退默认() {
        assert_eq!(next_chapter_line("第4章", ""), "第5章");
        assert_eq!(next_chapter_line("第4章", "   "), "第5章");
    }
}
