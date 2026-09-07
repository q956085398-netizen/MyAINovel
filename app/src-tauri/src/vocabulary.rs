//! 类型/解法词表（工单 #10 决议，docs/spec/类型解法词表.md）：
//! 桥段跨书筛选与构思爽点圈定共用的词汇基础。词表文件是用户数据
//! （库根「词表.yaml」，ADR 0002），首次使用落盘类型种子，此后只读
//! 不写；提示 = 词表词（文件序）＋库内已用词（按次数降序），增长靠
//! 使用、归并靠人。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::book_file::{read_yaml_mapping, write_yaml_mapping};
use crate::library;
use crate::trope::TropeSpan;

/// 类型种子初版（docs/spec/类型解法词表.md）：取自方法论文章的作者
/// 自述用例＋两个通用补位；解法不设种子——个人拆书攒的花样没有通用词。
pub const SEED_TYPES: &[&str] = &[
    "掉马甲",
    "打脸",
    "金手指装逼",
    "扮猪吃虎",
    "修罗场",
    "后台撑腰",
    "大人物欠人情",
    "情报装逼",
    "秘密拿捏",
    "料敌于先",
    "收妹子",
    "文抄",
    "帝王心术",
    "配角反应",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vocabulary {
    pub types: Vec<String>,
    pub solutions: Vec<String>,
}

pub fn vocab_path(root: &Path) -> PathBuf {
    root.join("词表.yaml")
}

/// 加载词表并合成提示。文件不存在 → 落盘种子版（首次使用）；
/// 存在但损坏 → Err（不覆盖、不静默重建），前端提示后输入不受影响。
pub fn load_vocab(root: &Path) -> Result<Vocabulary, String> {
    let path = vocab_path(root);
    let (file_types, file_solutions) = if path.is_file() {
        words_from_mapping(&read_yaml_mapping(&path)?, &path)?
    } else {
        write_seed(&path)?;
        (
            SEED_TYPES.iter().map(|s| s.to_string()).collect(),
            Vec::new(),
        )
    };
    let (used_types, used_solutions) = harvest(root);
    Ok(Vocabulary {
        types: merge(file_types, used_types),
        solutions: merge(file_solutions, used_solutions),
    })
}

/// 词表文件的「类型」「解法」两键 → 字符串列表；缺键按空处理
/// （用户删掉种子是有意为之，尊重文件）。
fn words_from_mapping(
    map: &serde_yaml::Mapping,
    path: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    Ok((
        word_list(map, "类型", path)?,
        word_list(map, "解法", path)?,
    ))
}

fn word_list(map: &serde_yaml::Mapping, key: &str, path: &Path) -> Result<Vec<String>, String> {
    let Some(list) = map.get(Value::String(key.to_string())) else {
        return Ok(Vec::new());
    };
    let Value::Sequence(seq) = list else {
        return Err(format!("词表 {} 的「{key}」不是字符串列表", path.display()));
    };
    seq.iter()
        .map(|v| {
            v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).ok_or_else(
                || format!("词表 {} 的「{key}」里有非字符串", path.display()),
            )
        })
        .collect()
}

fn write_seed(path: &Path) -> Result<(), String> {
    let mut map = serde_yaml::Mapping::new();
    map.insert(
        Value::String("类型".to_string()),
        Value::Sequence(
            SEED_TYPES
                .iter()
                .map(|s| Value::String(s.to_string()))
                .collect(),
        ),
    );
    map.insert(Value::String("解法".to_string()), Value::Sequence(Vec::new()));
    write_yaml_mapping(path, map)
}

/// 词 → 使用次数。
type WordCounts = Vec<(String, u32)>;

/// 库内已用词聚合：各书桥段的类型逐个计数、解法按条计数。损坏的书
/// yaml 降级为空（提示是尽力而为的，不因一本书的坏文件报错）。
fn harvest(root: &Path) -> (WordCounts, WordCounts) {
    let mut type_counts: HashMap<String, u32> = HashMap::new();
    let mut solution_counts: HashMap<String, u32> = HashMap::new();
    let Ok(files) = library::collect_book_files(root) else {
        return (Vec::new(), Vec::new());
    };
    for book in &files {
        for trope in library::tropes_lossy(&book.primary_md) {
            count_trope(&mut type_counts, &mut solution_counts, &trope);
        }
    }
    (sort_by_count(type_counts), sort_by_count(solution_counts))
}

fn count_trope(
    type_counts: &mut HashMap<String, u32>,
    solution_counts: &mut HashMap<String, u32>,
    trope: &TropeSpan,
) {
    for ty in &trope.types {
        *type_counts.entry(ty.clone()).or_insert(0) += 1;
    }
    if let Some(sol) = &trope.solution {
        *solution_counts.entry(sol.clone()).or_insert(0) += 1;
    }
}

fn sort_by_count(counts: HashMap<String, u32>) -> WordCounts {
    let mut list: Vec<(String, u32)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list
}

/// 文件词原序在前，已用词按次数降序追加，去重。
fn merge(file_words: Vec<String>, used: Vec<(String, u32)>) -> Vec<String> {
    let mut seen: HashSet<String> = file_words.iter().cloned().collect();
    let mut merged = file_words;
    for (word, _) in used {
        if seen.insert(word.clone()) {
            merged.push(word);
        }
    }
    merged
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
    fn 首次使用_落盘种子_空库无已用词() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书甲.md"), "第1章");

        let vocab = load_vocab(&root).unwrap();
        assert_eq!(
            vocab.types,
            SEED_TYPES.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
        assert!(vocab.solutions.is_empty());

        let yaml = fs::read_to_string(root.join("词表.yaml")).unwrap();
        assert!(yaml.contains("类型:"));
        assert!(yaml.contains("- 掉马甲"));
        assert!(yaml.contains("解法: []"));
    }

    #[test]
    fn 已有词表_文件序在前_已用词按次数降序追加去重() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "类型:\n- 自定义甲\n- 掉马甲\n解法:\n- 写法一\n");
        write(&root.join("书甲.md"), "第1章");
        write(
            &root.join("书甲.yaml"),
            "桥段:\n- 起: 1\n  止: 2\n  类型: [掉马甲, 新类型]\n  解法: 扫地僧式\n",
        );
        write(&root.join("书乙.md"), "第1章");
        write(
            &root.join("书乙.yaml"),
            "桥段:\n- 起: 1\n  止: 1\n  类型: [掉马甲]\n- 起: 2\n  止: 3\n  类型: [更少用的]\n",
        );

        let vocab = load_vocab(&root).unwrap();
        // 文件序在前；掉马甲（用 2 次）排在其后；同频（各 1 次）按字典序：
        // 「新」U+65B0 < 「更」U+66F4。
        assert_eq!(vocab.types, vec!["自定义甲", "掉马甲", "新类型", "更少用的"]);
        assert_eq!(vocab.solutions, vec!["写法一", "扫地僧式"]);
    }

    #[test]
    fn 损坏书yaml_聚合降级为空_不报错() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "类型: [掉马甲]\n");
        write(&root.join("坏书.md"), "第1章");
        write(&root.join("坏书.yaml"), "{{{{不是 yaml");

        let vocab = load_vocab(&root).unwrap();
        assert_eq!(vocab.types, vec!["掉马甲"]);
    }

    #[test]
    fn 灵感库目录_不参与聚合() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "类型: []\n");
        write(&root.join("书甲.md"), "第1章");
        write(
            &root.join("灵感库/故事卡/某卡.md"),
            "---\n标签: [桥段]\n---\n正文",
        );

        let vocab = load_vocab(&root).unwrap();
        assert!(vocab.types.is_empty());
    }

    #[test]
    fn 损坏词表_报错且不覆盖() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "{{{{不是 yaml");

        assert!(load_vocab(&root).is_err());
        assert_eq!(
            fs::read_to_string(root.join("词表.yaml")).unwrap(),
            "{{{{不是 yaml"
        );
    }

    #[test]
    fn 词表键形态错误_报错() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "类型: 掉马甲\n");

        assert!(load_vocab(&root).is_err());
    }

    #[test]
    fn 词表条目非字符串_报错() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "类型:\n- 掉马甲\n- 3\n");

        assert!(load_vocab(&root).is_err());
    }

    #[test]
    fn 删掉类型键_按空词表对待_不回填种子() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("词表.yaml"), "解法: [写法一]\n");
        write(&root.join("书甲.md"), "第1章");

        let vocab = load_vocab(&root).unwrap();
        assert!(vocab.types.is_empty());
        assert_eq!(vocab.solutions, vec!["写法一"]);
        // 不回填种子：用户删键是有意的。
        let yaml = fs::read_to_string(root.join("词表.yaml")).unwrap();
        assert!(!yaml.contains("掉马甲"));
    }
}
