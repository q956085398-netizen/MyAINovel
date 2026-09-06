//! 桥段标注：选中若干章 → 填类型/解法 → 存入该书 yaml 的「桥段」列表
//! （设计共识 §四）。起止为正文里章标题的序数（第几个章标题，1 起），
//! 与章前缀模板无关；必填只有类型（设计共识 §四「必填字段」）。
//!
//! yaml 形态（中文键，与书级元数据同一文件、同一套合并保留策略）：
//! ```yaml
//! 桥段:
//!   - 起: 3
//!     止: 6
//!     类型: [掉马甲, 打脸]
//!     解法: 扫地僧式深藏不露
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::book_file::{
    lossy_yaml_mapping, read_yaml_mapping, sibling_yaml_path, write_yaml_mapping,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TropeSpan {
    pub start_chapter: u32,
    pub end_chapter: u32,
    pub types: Vec<String>,
    pub solution: Option<String>,
}

impl TropeSpan {
    /// 写盘前归一：解法空串归 None。
    fn normalized(&self) -> TropeSpan {
        TropeSpan {
            start_chapter: self.start_chapter,
            end_chapter: self.end_chapter,
            types: self.types.clone(),
            solution: self
                .solution
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }
    }
}

fn validate(trope: &TropeSpan) -> Result<(), String> {
    if trope.start_chapter == 0 || trope.end_chapter < trope.start_chapter {
        return Err(format!(
            "桥段章范围不合法：起 {} 止 {}（起须 ≥1 且 ≤ 止）",
            trope.start_chapter, trope.end_chapter
        ));
    }
    if trope.types.is_empty() {
        return Err("桥段至少要标注一个类型".to_string());
    }
    Ok(())
}

/// 从 yaml 底图解析桥段列表；无「桥段」键视为空。解析失败（手改损坏）
/// 显式报错，由调用方先警告用户。
pub fn tropes_from_mapping(map: &serde_yaml::Mapping) -> Result<Vec<TropeSpan>, String> {
    let Some(list) = map.get(Value::String("桥段".to_string())) else {
        return Ok(Vec::new());
    };
    let Value::Sequence(seq) = list else {
        return Err("yaml 的「桥段」字段不是列表".to_string());
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| trope_from_value(i, item))
        .collect()
}

fn trope_from_value(index: usize, item: &Value) -> Result<TropeSpan, String> {
    let map = item
        .as_mapping()
        .ok_or_else(|| format!("桥段第 {} 条不是键值结构", index + 1))?;
    let get_u32 = |key: &str| -> Result<u32, String> {
        map.get(Value::String(key.to_string()))
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("桥段第 {} 条缺少有效的「{key}」", index + 1))
    };
    let types = match map.get(Value::String("类型".to_string())) {
        Some(Value::Sequence(seq)) => {
            let mut types = Vec::with_capacity(seq.len());
            for v in seq {
                let s = v
                    .as_str()
                    .ok_or_else(|| format!("桥段第 {} 条的类型里有非字符串", index + 1))?
                    .trim()
                    .to_string();
                if !s.is_empty() {
                    types.push(s);
                }
            }
            types
        }
        _ => return Err(format!("桥段第 {} 条缺少「类型」列表", index + 1)),
    };
    let solution = map
        .get(Value::String("解法".to_string()))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(TropeSpan {
        start_chapter: get_u32("起")?,
        end_chapter: get_u32("止")?,
        types,
        solution,
    })
}

fn trope_to_value(trope: &TropeSpan) -> Value {
    let mut m = serde_yaml::Mapping::new();
    m.insert(
        Value::String("起".to_string()),
        Value::Number(trope.start_chapter.into()),
    );
    m.insert(
        Value::String("止".to_string()),
        Value::Number(trope.end_chapter.into()),
    );
    m.insert(
        Value::String("类型".to_string()),
        Value::Sequence(
            trope
                .types
                .iter()
                .map(|t| Value::String(t.clone()))
                .collect(),
        ),
    );
    if let Some(s) = &trope.solution {
        m.insert(Value::String("解法".to_string()), Value::String(s.clone()));
    }
    Value::Mapping(m)
}

pub fn read_tropes(md_path: &Path) -> Result<Vec<TropeSpan>, String> {
    let map = read_yaml_mapping(&sibling_yaml_path(md_path))?;
    tropes_from_mapping(&map)
}

pub fn write_tropes(md_path: &Path, tropes: &[TropeSpan]) -> Result<(), String> {
    let normalized: Vec<TropeSpan> = tropes.iter().map(TropeSpan::normalized).collect();
    for t in &normalized {
        validate(t)?;
    }
    let yaml = sibling_yaml_path(md_path);
    // 与书级元数据同一套合并策略：书级键与未知键原样保留（解析失败的
    // 旧文件按空底处理，前端读到解析错误时会先警告）。
    let mut map = lossy_yaml_mapping(&yaml);
    let key = Value::String("桥段".to_string());
    if normalized.is_empty() {
        map.remove(&key);
    } else {
        map.insert(
            key,
            Value::Sequence(normalized.iter().map(trope_to_value).collect()),
        );
    }
    write_yaml_mapping(&yaml, map)
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

    fn sample() -> Vec<TropeSpan> {
        vec![TropeSpan {
            start_chapter: 3,
            end_chapter: 6,
            types: vec!["掉马甲".into(), "打脸".into()],
            solution: Some("扫地僧式深藏不露".into()),
        }]
    }

    #[test]
    fn 桥段_ipc_走_camelCase() {
        let t = TropeSpan {
            start_chapter: 1,
            end_chapter: 4,
            types: vec!["掉马甲".into()],
            solution: None,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"startChapter\""));
        assert!(json.contains("\"endChapter\""));
        let back: TropeSpan = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn 读写_往返一致() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("拆书.md");
        write(&md, "");

        write_tropes(&md, &sample()).unwrap();
        assert_eq!(read_tropes(&md).unwrap(), sample());

        let yaml_text = fs::read_to_string(root.join("拆书.yaml")).unwrap();
        assert!(yaml_text.contains("桥段:"));
        assert!(yaml_text.contains("起: 3"));
        assert!(yaml_text.contains("- 掉马甲"));
        assert!(yaml_text.contains("解法: 扫地僧式深藏不露"));
    }

    #[test]
    fn 读写_无解法_不落键() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");

        let no_solution = vec![TropeSpan {
            start_chapter: 1,
            end_chapter: 2,
            types: vec!["打脸".into()],
            solution: None,
        }];
        write_tropes(&md, &no_solution).unwrap();
        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(!yaml_text.contains("解法"));
        assert_eq!(read_tropes(&md).unwrap(), no_solution);
    }

    #[test]
    fn 读写_解法空串_归一为无() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");

        let padded = vec![TropeSpan {
            start_chapter: 1,
            end_chapter: 1,
            types: vec!["打脸".into()],
            solution: Some("   ".into()),
        }];
        write_tropes(&md, &padded).unwrap();
        assert_eq!(read_tropes(&md).unwrap()[0].solution, None);
    }

    #[test]
    fn 合并_书级键与未知键保留() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(
            &root.join("书.yaml"),
            "书名: 书甲\n成绩: 20000\n自定义键: 保留我\n",
        );

        write_tropes(&md, &sample()).unwrap();
        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(yaml_text.contains("书名: 书甲"));
        assert!(yaml_text.contains("成绩: 20000"));
        assert!(yaml_text.contains("自定义键: 保留我"));

        // 反向也成立：桥段先写，书级元数据后写不丢桥段。
        write_tropes(&md, &sample()).unwrap();
        assert_eq!(read_tropes(&md).unwrap(), sample());
    }

    #[test]
    fn 清空_移除键_其余保留() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "书名: 书甲\n");

        write_tropes(&md, &sample()).unwrap();
        write_tropes(&md, &[]).unwrap();
        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(!yaml_text.contains("桥段"));
        assert!(yaml_text.contains("书名: 书甲"));
        assert_eq!(read_tropes(&md).unwrap(), Vec::new());
    }

    #[test]
    fn 校验_起止倒置_起为零_类型为空_都报错() {
        let md = Path::new("x.md");
        assert!(write_tropes(
            md,
            &[TropeSpan {
                start_chapter: 6,
                end_chapter: 3,
                types: vec!["打脸".into()],
                solution: None,
            }]
        )
        .is_err());
        assert!(write_tropes(
            md,
            &[TropeSpan {
                start_chapter: 0,
                end_chapter: 3,
                types: vec!["打脸".into()],
                solution: None,
            }]
        )
        .is_err());
        assert!(write_tropes(
            md,
            &[TropeSpan {
                start_chapter: 1,
                end_chapter: 3,
                types: vec![],
                solution: None,
            }]
        )
        .is_err());
    }

    #[test]
    fn 读取_损坏_yaml_报错不静默() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "{{{{不是 yaml");

        assert!(read_tropes(&md).is_err());
    }

    #[test]
    fn 读取_桥段非列表_报错() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "桥段: 掉马甲\n");

        assert!(read_tropes(&md).is_err());
    }

    #[test]
    fn 读取_条目缺起_报错带序号() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(
            &root.join("书.yaml"),
            "桥段:\n- 止: 4\n  类型: [打脸]\n",
        );

        let err = read_tropes(&md).unwrap_err();
        assert!(err.contains("第 1 条"), "{err}");
    }

    #[test]
    fn 读取_多条_保序() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(
            &root.join("书.yaml"),
            "桥段:\n- 起: 5\n  止: 8\n  类型: [打脸]\n- 起: 1\n  止: 4\n  类型: [掉马甲]\n",
        );

        let tropes = read_tropes(&md).unwrap();
        assert_eq!(tropes.len(), 2);
        assert_eq!(tropes[0].start_chapter, 5);
        assert_eq!(tropes[1].types, vec!["掉马甲".to_string()]);
    }
}
