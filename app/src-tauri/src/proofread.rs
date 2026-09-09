//! 发布前校对（工单 #14，docs/spec/导出与发布.md §四）。
//!
//! 只在点「发布前校对」时跑一次：只读正文、不写任何创作数据（正文零
//! 污染）。三类规则都走确定性匹配——敏感词 DFA、内置的地得小集、错词
//! 表——**宁可漏报不可误报**：命中的都是表内模式，不做统计模型。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::book_file::read_text;
use crate::chapter::scan_chapters;
use crate::export::ChapterRange;

pub const PROOFREAD_DIR: &str = "校对";
pub const SENSITIVE_FILE: &str = "敏感词.txt";
pub const WRONG_WORD_FILE: &str = "错词.txt";
pub const KIND_SENSITIVE: &str = "敏感词";
pub const KIND_DE: &str = "的地得";
pub const KIND_WRONG: &str = "错词";

/// 内置高置信错词种子（用户「校对/错词.txt」叠加在其上）。
const BUILTIN_WRONG_WORDS: &[(&str, &str)] = &[
    ("因该", "应该"),
    ("既使", "即使"),
    ("己经", "已经"),
    ("自已", "自己"),
    ("做为", "作为"),
    ("布署", "部署"),
    ("必竟", "毕竟"),
    ("竞然", "竟然"),
    ("决对", "绝对"),
    ("部份", "部分"),
    ("精采", "精彩"),
    ("宏扬", "弘扬"),
    ("供献", "贡献"),
    ("照像", "照相"),
    ("录相", "录像"),
    ("磨菇", "蘑菇"),
    ("罗嗦", "啰嗦"),
    ("胡涂", "糊涂"),
    ("喝采", "喝彩"),
    ("装璜", "装潢"),
    ("烦燥", "烦躁"),
    ("暴燥", "暴躁"),
    ("干躁", "干燥"),
    ("迫不急待", "迫不及待"),
    ("一如继往", "一如既往"),
    ("按耐", "按捺"),
    ("走头无路", "走投无路"),
    ("甘败下风", "甘拜下风"),
    ("相形见拙", "相形见绌"),
    ("美仑美奂", "美轮美奂"),
    ("一股作气", "一鼓作气"),
    ("谈笑风声", "谈笑风生"),
    ("穿流不息", "川流不息"),
    ("按步就班", "按部就班"),
    ("兵慌马乱", "兵荒马乱"),
    ("不径而走", "不胫而走"),
    ("出奇致胜", "出奇制胜"),
    ("眼花瞭乱", "眼花缭乱"),
    ("委屈求全", "委曲求全"),
    ("明辩是非", "明辨是非"),
    ("重蹈复辙", "重蹈覆辙"),
    ("严惩不怠", "严惩不贷"),
    ("不醒人事", "不省人事"),
    ("默守成规", "墨守成规"),
    ("名列前矛", "名列前茅"),
    ("融汇贯通", "融会贯通"),
    ("悬梁刺骨", "悬梁刺股"),
    ("声名雀起", "声名鹊起"),
    ("妄自匪薄", "妄自菲薄"),
    ("相辅相承", "相辅相成"),
    ("一诺千斤", "一诺千金"),
    ("灸手可热", "炙手可热"),
    ("世外桃园", "世外桃源"),
    ("张灯结采", "张灯结彩"),
    ("直接了当", "直截了当"),
    ("恰如其份", "恰如其分"),
    ("兴高彩烈", "兴高采烈"),
    ("无精打彩", "无精打采"),
    ("五彩斑澜", "五彩斑斓"),
    ("针贬时弊", "针砭时弊"),
    ("弱不经风", "弱不禁风"),
    ("情不自尽", "情不自禁"),
    ("不落巢臼", "不落窠臼"),
    ("陈词烂调", "陈词滥调"),
    ("星罗旗布", "星罗棋布"),
    ("心浮气燥", "心浮气躁"),
    ("迫在眉稍", "迫在眉睫"),
    ("心心相映", "心心相印"),
    ("投机捣把", "投机倒把"),
    ("挺而走险", "铤而走险"),
    ("有条不絮", "有条不紊"),
    ("再所不辞", "在所不辞"),
    ("明火执杖", "明火执仗"),
    ("以逸代劳", "以逸待劳"),
    ("独挡一面", "独当一面"),
    ("蜂涌而至", "蜂拥而至"),
    ("置若惘闻", "置若罔闻"),
];

/// 动词表（的→得 的左侧、的→地 的右侧共用）。
const DE_VERBS: &[&str] = &[
    "跑", "走", "说", "看", "写", "做", "睡", "吃", "想", "笑", "哭", "唱", "打", "飞", "跳", "涨",
    "变", "长", "干", "活", "来", "去", "站", "坐", "躺", "听", "读", "问", "答", "喊", "叫", "喝",
    "拿", "放", "拉", "推", "点", "摇", "叹", "找", "改", "擦", "拍", "摸", "踢", "转", "翻", "关",
    "开", "收", "醒", "疼", "累", "饿", "吓", "急", "气", "忙", "玩", "学", "记", "忘", "懂", "认",
];

/// 程度副词补语：的→得 必报（「跑的很慢」）。
const DE_DEGREE_WORDS: &[&str] = &[
    "很", "太", "不", "真", "非常", "十分", "特别", "如此", "那么", "这么", "极其", "相当",
];

/// 结果/状态补语：的→得 需后接接续词或行尾才报（避开「做的好事」）。
const DE_RESULT_WORDS: &[&str] = &[
    "好", "快", "慢", "多", "少", "早", "晚", "远", "近", "高", "低", "大", "小", "久", "准", "对",
    "错", "干净", "清楚", "明白", "彻底", "漂亮", "厉害", "严重", "明显", "夸张", "舒服", "难受",
    "开心", "高兴",
];

/// 补语/动词之后允许的接续（含标点与行尾）：不是这些就大概率是名词。
const CONTINUATIONS: &[char] = &[
    '了', '着', '过', '多', '少', '一', '点', '些', '起', '下', '去', '来', '极', '不', '吗', '呢',
    '吧', '啊', '呀', '哦', '，', '。', '！', '？', '、', '；', '：', '…', '—', '」', '”', '）', ')',
];

/// 状语词（的→地 的左侧；都是「…地+动词」里的惯用状语）。
const DE_ADVERBS: &[&str] = &[
    "慢慢", "轻轻", "悄悄", "默默", "狠狠", "静静", "偷偷", "渐渐", "缓缓", "迅速", "快速", "缓慢",
    "大声", "小声", "仔细", "认真", "冷静", "愤怒", "兴奋", "开心", "难过", "疑惑", "好奇", "无奈",
    "尴尬", "勉强", "果断", "干脆", "郑重", "严肃", "温柔", "亲切", "熟练", "自然", "轻松", "随意",
    "直接", "简单", "清楚", "小心", "得意", "自信", "坚定", "迟疑", "犹豫", "茫然", "淡淡", "冷冷",
    "微微", "紧紧", "死死", "重重", "用力", "使劲", "拼命", "连忙", "急忙", "赶紧", "狼狈", "优雅",
    "从容", "淡定", "警惕", "惊讶", "惊恐", "疲惫", "虚弱", "飞快", "急促",
];

/// 无歧义的双字动词（的→地 的右侧；「笑容」「好事」这类名词不会命中）。
const DE_ADVERB_VERBS: &[&str] = &[
    "看着", "看向", "望着", "盯着", "听着", "想着", "说着", "笑着", "哭着", "走着", "跑着", "站着",
    "坐着", "躺着", "点头", "摇头", "皱眉", "叹气", "摆手", "挥手", "转身", "抬头", "低头", "开口",
    "起身", "上前", "后退", "回头", "问道", "说道", "回答", "解释", "打量", "扫视", "注视", "凝视",
    "耸肩", "摊手", "鼓掌", "跺脚", "抿嘴", "咬牙", "走去", "走来",
];

// ---------- 结果结构 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofIssue {
    /// 未编号章为 None（校对不依赖章序，仍会扫到）。
    pub ordinal: Option<u32>,
    pub file_name: String,
    pub path: PathBuf,
    /// 1 起行号（原始文件行，与编辑器缓冲同口径）。
    pub line: u32,
    /// 命中词在本行内的第几次出现（0 起）——跳回时据此定位。
    pub occurrence: u32,
    pub word: String,
    pub suggestion: Option<String>,
    /// 敏感词｜的地得｜错词。
    pub kind: String,
    /// 上下文片段（命中词前后各约 12 字）。
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofReport {
    pub issues: Vec<ProofIssue>,
    pub scanned_chapters: u32,
    /// 敏感词库条数（0＝没有词库文件，前端提示怎么建）。
    pub sensitive_words: u32,
    /// 错词条数（含内置种子）。
    pub wrong_words: u32,
    pub sensitive_file_exists: bool,
}

// ---------- 词库 ----------

pub fn proofread_dir(root: &Path) -> PathBuf {
    root.join(PROOFREAD_DIR)
}

fn read_word_list(path: &Path) -> Result<Vec<String>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = read_text(path)?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect())
}

/// 错词表：`错词 => 对词`；没有 `=>` 的只报不改。
fn read_wrong_words(path: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    Ok(read_word_list(path)?
        .into_iter()
        .map(|line| match line.split_once("=>") {
            Some((wrong, right)) => (
                wrong.trim().to_string(),
                Some(right.trim().to_string()).filter(|r| !r.is_empty()),
            ),
            None => (line, None),
        })
        .filter(|(wrong, _)| !wrong.is_empty())
        .collect())
}

/// 内置错词种子（用户文件叠加在其上）。
fn builtin_wrong_words() -> Vec<(String, Option<String>)> {
    BUILTIN_WRONG_WORDS
        .iter()
        .map(|(wrong, right)| (wrong.to_string(), Some(right.to_string())))
        .collect()
}

/// 敏感词多模式匹配（自建 Trie，不引新依赖）：从每个位置取最长命中，
/// 命中后跳过整个词，嵌套词不重复报。
#[derive(Default)]
struct SensitiveTrie {
    nodes: Vec<HashMap<char, usize>>,
    terminal: Vec<bool>,
}

impl SensitiveTrie {
    fn new() -> Self {
        SensitiveTrie {
            nodes: vec![HashMap::new()],
            terminal: vec![false],
        }
    }

    fn insert(&mut self, word: &str) {
        let mut cur = 0usize;
        for c in word.chars() {
            let next = match self.nodes[cur].get(&c) {
                Some(next) => *next,
                None => {
                    self.nodes.push(HashMap::new());
                    self.terminal.push(false);
                    let next = self.nodes.len() - 1;
                    self.nodes[cur].insert(c, next);
                    next
                }
            };
            cur = next;
        }
        self.terminal[cur] = true;
    }

    /// 从 chars[start] 起的最长命中长度（字符数）；不中返回 0。
    fn longest(&self, chars: &[char], start: usize) -> usize {
        let mut cur = 0usize;
        let mut best = 0usize;
        for (i, c) in chars.iter().enumerate().skip(start) {
            let Some(next) = self.nodes[cur].get(c) else {
                break;
            };
            cur = *next;
            if self.terminal[cur] {
                best = i - start + 1;
            }
        }
        best
    }
}

// ---------- 单行规则 ----------

struct Hit {
    start: usize,
    len: usize,
    word: String,
    suggestion: Option<String>,
    kind: &'static str,
}

/// 占位：命中区间没被别的规则占用就标上并返回 true，否则返回 false。
fn claim(taken: &mut [bool], start: usize, len: usize) -> bool {
    if taken[start..start + len].iter().any(|slot| *slot) {
        return false;
    }
    for slot in taken.iter_mut().skip(start).take(len) {
        *slot = true;
    }
    true
}

fn ends_with_at(chars: &[char], end: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if end < w.len() {
        return false;
    }
    chars[end - w.len()..end] == w[..]
}

fn starts_with_at(chars: &[char], start: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if start + w.len() > chars.len() {
        return false;
    }
    chars[start..start + w.len()] == w[..]
}

fn longest_ending_at<'a>(chars: &[char], end: usize, table: &[&'a str]) -> Option<&'a str> {
    table
        .iter()
        .filter(|word| ends_with_at(chars, end, word))
        .max_by_key(|word| word.chars().count())
        .copied()
}

fn longest_starting_at<'a>(chars: &[char], start: usize, table: &[&'a str]) -> Option<&'a str> {
    table
        .iter()
        .filter(|word| starts_with_at(chars, start, word))
        .max_by_key(|word| word.chars().count())
        .copied()
}

/// 的地得小集：的→得（动词＋的＋程度/结果补语）、的→地（状语＋的＋动词）。
/// 只在表内命中时开口，且结果补语/单字动词后必须是接续词或行尾。
fn de_hits(chars: &[char], taken: &[bool]) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        if *c != '的' || taken.get(i) == Some(&true) {
            continue;
        }
        if let Some(hit) = de_de_hit(chars, i).or_else(|| de_di_hit(chars, i)) {
            hits.push(hit);
        }
    }
    hits
}

/// 的→得：动词＋的＋程度/结果补语。结果补语后必须是接续词或行尾，
/// 否则大概率是「做的好事」这类名词短语。
fn de_de_hit(chars: &[char], i: usize) -> Option<Hit> {
    let verb = longest_ending_at(chars, i, DE_VERBS)?;
    let after = i + 1;
    let complement = match (
        longest_starting_at(chars, after, DE_DEGREE_WORDS),
        longest_starting_at(chars, after, DE_RESULT_WORDS),
    ) {
        (Some(word), _) => word,
        (None, Some(word)) => match chars.get(after + word.chars().count()) {
            None => word,
            Some(ch) if CONTINUATIONS.contains(ch) => word,
            _ => return None,
        },
        (None, None) => return None,
    };
    let vlen = verb.chars().count();
    let clen = complement.chars().count();
    Some(Hit {
        start: i - vlen,
        len: vlen + 1 + clen,
        word: format!("{verb}的{complement}"),
        suggestion: Some(format!("{verb}得{complement}")),
        kind: KIND_DE,
    })
}

/// 的→地：状语＋的＋动词。动词优先取无歧义双字动词；单字动词后必须
/// 是接续词或行尾（避开「开心的笑容」这类名词短语）。
fn de_di_hit(chars: &[char], i: usize) -> Option<Hit> {
    let adverb = longest_ending_at(chars, i, DE_ADVERBS)?;
    let after = i + 1;
    let verb = longest_starting_at(chars, after, DE_ADVERB_VERBS).or_else(|| {
        longest_starting_at(chars, after, DE_VERBS).filter(|v| {
            let next = chars.get(after + v.chars().count());
            next.is_none_or(|ch| CONTINUATIONS.contains(ch))
        })
    })?;
    let alen = adverb.chars().count();
    let vlen = verb.chars().count();
    Some(Hit {
        start: i - alen,
        len: alen + 1 + vlen,
        word: format!("{adverb}的{verb}"),
        suggestion: Some(format!("{adverb}地{verb}")),
        kind: KIND_DE,
    })
}

/// 一行里跑三类规则；返回按起点排序、互不重叠的命中。
fn scan_line(
    line: &str,
    sensitive: &SensitiveTrie,
    wrong_words: &[(String, Option<String>)],
) -> Vec<Hit> {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut taken = vec![false; chars.len()];
    let mut hits: Vec<Hit> = Vec::new();

    let mut i = 0usize;
    while i < chars.len() {
        let len = sensitive.longest(&chars, i);
        if len > 0 {
            hits.push(Hit {
                start: i,
                len,
                word: chars[i..i + len].iter().collect(),
                suggestion: None,
                kind: KIND_SENSITIVE,
            });
            claim(&mut taken, i, len);
            i += len;
        } else {
            i += 1;
        }
    }

    // 错词：同一位置长词优先，已被敏感词占用的位置跳过。
    let mut candidates: Vec<Hit> = Vec::new();
    for (wrong, right) in wrong_words {
        let w: Vec<char> = wrong.chars().collect();
        if w.is_empty() {
            continue;
        }
        let mut start = 0usize;
        while start + w.len() <= chars.len() {
            if chars[start..start + w.len()] == w[..]
                && !taken[start..start + w.len()].iter().any(|slot| *slot)
            {
                candidates.push(Hit {
                    start,
                    len: w.len(),
                    word: wrong.clone(),
                    suggestion: right.clone(),
                    kind: KIND_WRONG,
                });
                start += w.len();
            } else {
                start += 1;
            }
        }
    }
    candidates.sort_by(|a, b| a.start.cmp(&b.start).then(b.len.cmp(&a.len)));
    for hit in candidates {
        if claim(&mut taken, hit.start, hit.len) {
            hits.push(hit);
        }
    }

    for hit in de_hits(&chars, &taken) {
        if claim(&mut taken, hit.start, hit.len) {
            hits.push(hit);
        }
    }

    hits.sort_by_key(|hit| hit.start);
    hits
}

/// 命中词在本行内第几次出现（0 起）；跳回时用它定位到具体那一次。
fn occurrence_before(chars: &[char], start: usize, word: &str) -> u32 {
    let w: Vec<char> = word.chars().collect();
    if w.is_empty() {
        return 0;
    }
    let mut count = 0u32;
    let mut i = 0usize;
    while i + w.len() <= start {
        if chars[i..i + w.len()] == w[..] {
            count += 1;
            i += w.len();
        } else {
            i += 1;
        }
    }
    count
}

fn snippet_of(chars: &[char], start: usize, len: usize) -> String {
    const PAD: usize = 12;
    let from = start.saturating_sub(PAD);
    let to = (start + len + PAD).min(chars.len());
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.extend(&chars[from..to]);
    if to < chars.len() {
        out.push('…');
    }
    out
}

// ---------- 入口 ----------

/// 校对范围内的章节。范围含全书时未编号章也扫（校对不依赖章序）。
/// root 为空＝没有库根（词库缺席），只用内置规则。
pub fn proofread_chapters(
    root: &Path,
    project: &Path,
    range: ChapterRange,
) -> Result<ProofReport, String> {
    let dir = (!root.as_os_str().is_empty()).then(|| proofread_dir(root));
    let sensitive_path = dir.as_ref().map(|d| d.join(SENSITIVE_FILE));
    let sensitive_words = match &sensitive_path {
        Some(path) => read_word_list(path)?,
        None => Vec::new(),
    };
    let sensitive_file_exists = sensitive_path.as_ref().is_some_and(|path| path.is_file());
    let mut wrong_words = builtin_wrong_words();
    if let Some(path) = dir.as_ref().map(|d| d.join(WRONG_WORD_FILE)) {
        wrong_words.extend(read_wrong_words(&path)?);
    }

    let mut trie = SensitiveTrie::new();
    for word in &sensitive_words {
        trie.insert(word);
    }

    let mut issues: Vec<ProofIssue> = Vec::new();
    let mut scanned = 0u32;
    for entry in scan_chapters(project)? {
        let in_scope = match entry.ordinal {
            Some(ordinal) => range.contains(ordinal),
            None => range.is_all(),
        };
        if !in_scope {
            continue;
        }
        scanned += 1;
        let Ok(content) = fs::read(&entry.path) else {
            continue;
        };
        let content = String::from_utf8_lossy(&content);
        for (index, line) in content.lines().enumerate() {
            let chars: Vec<char> = line.chars().collect();
            for hit in scan_line(line, &trie, &wrong_words) {
                issues.push(ProofIssue {
                    ordinal: entry.ordinal,
                    file_name: entry.file_name.clone(),
                    path: entry.path.clone(),
                    line: index as u32 + 1,
                    occurrence: occurrence_before(&chars, hit.start, &hit.word),
                    snippet: snippet_of(&chars, hit.start, hit.len),
                    word: hit.word,
                    suggestion: hit.suggestion,
                    kind: hit.kind.to_string(),
                });
            }
        }
    }
    issues.sort_by(|a, b| {
        a.file_name
            .cmp(&b.file_name)
            .then(a.line.cmp(&b.line))
            .then(a.occurrence.cmp(&b.occurrence))
    });

    Ok(ProofReport {
        issues,
        scanned_chapters: scanned,
        sensitive_words: sensitive_words.len() as u32,
        wrong_words: wrong_words.len() as u32,
        sensitive_file_exists,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn project(root: &Path) -> PathBuf {
        let dir = root.join("项目/《大魏读书人》");
        fs::create_dir_all(dir.join("正文")).unwrap();
        dir
    }

    fn empty_trie() -> SensitiveTrie {
        SensitiveTrie::new()
    }

    fn builtin_wrong() -> Vec<(String, Option<String>)> {
        builtin_wrong_words()
    }

    #[test]
    fn 敏感词_最长匹配_嵌套不重复报() {
        let mut trie = SensitiveTrie::new();
        trie.insert("色情");
        trie.insert("色情片");
        trie.insert("暴恐");
        let hits = scan_line("这是色情片和暴恐内容", &trie, &[]);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].word, "色情片");
        assert_eq!(hits[1].word, "暴恐");
    }

    #[test]
    fn 的地得_动词加补语报得_名词短语不报() {
        let hits = scan_line("他跑的很慢，但做的好事不少", &empty_trie(), &[]);
        assert_eq!(hits.len(), 1, "{:?}", hits.iter().map(|h| &h.word).collect::<Vec<_>>());
        assert_eq!(hits[0].word, "跑的很");
        assert_eq!(hits[0].suggestion.as_deref(), Some("跑得很"));
    }

    #[test]
    fn 的地得_状语加动词报地_名词不报() {
        let hits = scan_line("认真的看着，开心的笑容，慢慢的走。", &empty_trie(), &[]);
        let words: Vec<&str> = hits.iter().map(|h| h.word.as_str()).collect();
        assert!(words.contains(&"认真的看着"), "{words:?}");
        assert!(words.contains(&"慢慢的走"), "{words:?}");
        assert!(!words.iter().any(|w| w.contains("笑容")), "{words:?}");
    }

    #[test]
    fn 的地得_行尾单字动词报_接名词不报() {
        let hits = scan_line("他走的很快，眼神仔细的打量她", &empty_trie(), &[]);
        let words: Vec<&str> = hits.iter().map(|h| h.word.as_str()).collect();
        assert!(words.contains(&"走的很"), "{words:?}");
        assert!(words.contains(&"仔细的打量"), "{words:?}");
        // 「跑的快慢」这类名词性搭配不报
        let hits = scan_line("看谁跑的快慢", &empty_trie(), &[]);
        assert!(hits.is_empty(), "{:?}", hits.iter().map(|h| &h.word).collect::<Vec<_>>());
    }

    #[test]
    fn 错词_内置种子命中并给建议() {
        let hits = scan_line("他迫不急待的想走", &empty_trie(), &builtin_wrong());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].word, "迫不急待");
        assert_eq!(hits[0].suggestion.as_deref(), Some("迫不及待"));
    }

    #[test]
    fn 错词_同一行多次出现给不同occurrence() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let p = project(root);
        write(&p.join("正文/0001 甲.md"), "因该走，因该留");
        let report = proofread_chapters(root, &p, ChapterRange::default()).unwrap();
        let issues: Vec<&ProofIssue> = report.issues.iter().filter(|i| i.word == "因该").collect();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].occurrence, 0);
        assert_eq!(issues[1].occurrence, 1);
        assert_eq!(issues[0].line, 1);
        assert_eq!(issues[0].ordinal, Some(1));
    }

    #[test]
    fn 词库_文件不存在只跑内置_存在则叠加() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let p = project(root);
        write(&p.join("正文/0001 甲.md"), "这里有个怪词和一个错词");
        let report = proofread_chapters(root, &p, ChapterRange::default()).unwrap();
        assert!(!report.sensitive_file_exists);
        assert_eq!(report.sensitive_words, 0);
        assert_eq!(report.issues.len(), 0);

        write(&root.join("校对/敏感词.txt"), "# 注释\n怪词\n");
        write(&root.join("校对/错词.txt"), "错词 => 对词\n裸词\n");
        let report = proofread_chapters(root, &p, ChapterRange::default()).unwrap();
        assert!(report.sensitive_file_exists);
        assert_eq!(report.sensitive_words, 1);
        assert_eq!(report.issues.len(), 2, "{:?}", report.issues);
        let kinds: Vec<&str> = report.issues.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&KIND_SENSITIVE));
        assert!(kinds.contains(&KIND_WRONG));
        assert!(report.wrong_words > BUILTIN_WRONG_WORDS.len() as u32);
    }

    #[test]
    fn 空库根_只用内置规则_不碰工作目录() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), "因该");
        let report = proofread_chapters(Path::new(""), &p, ChapterRange::default()).unwrap();
        assert!(!report.sensitive_file_exists);
        assert_eq!(report.issues.len(), 1, "{:?}", report.issues);
    }

    #[test]
    fn 范围_区间只扫选中章_全书扫未编号章() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let p = project(root);
        write(&p.join("正文/0001 甲.md"), "因该");
        write(&p.join("正文/0002 乙.md"), "因该");
        write(&p.join("正文/番外.md"), "因该");
        let range = ChapterRange {
            from: Some(2),
            to: Some(2),
        };
        let report = proofread_chapters(root, &p, range).unwrap();
        assert_eq!(report.scanned_chapters, 1);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].ordinal, Some(2));

        let report = proofread_chapters(root, &p, ChapterRange::default()).unwrap();
        assert_eq!(report.scanned_chapters, 3);
        assert!(report.issues.iter().any(|i| i.ordinal.is_none()));
    }

    #[test]
    fn 片段_前后各十二字带省略号() {
        let line = format!("{}因该{}", "前".repeat(20), "后".repeat(20));
        let hits = scan_line(&line, &empty_trie(), &builtin_wrong());
        assert_eq!(hits.len(), 1);
        let chars: Vec<char> = line.chars().collect();
        let snippet = snippet_of(&chars, hits[0].start, hits[0].len);
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.contains("因该"));
        assert_eq!(snippet.chars().count(), 1 + 12 + 2 + 12 + 1);
    }

    #[test]
    fn 校对_ipc_走_camelCase_与前端字段对齐() {
        let issue = ProofIssue {
            ordinal: Some(1),
            file_name: "0001 甲.md".to_string(),
            path: PathBuf::from("项目/《甲》/正文/0001 甲.md"),
            line: 2,
            occurrence: 0,
            word: "因该".to_string(),
            suggestion: Some("应该".to_string()),
            kind: KIND_WRONG.to_string(),
            snippet: "…因该…".to_string(),
        };
        let value = serde_json::to_value(&issue).unwrap();
        for key in [
            "ordinal", "fileName", "path", "line", "occurrence", "word", "suggestion", "kind",
            "snippet",
        ] {
            assert!(value.get(key).is_some(), "缺字段 {key}");
        }

        let report = ProofReport {
            issues: vec![issue],
            scanned_chapters: 1,
            sensitive_words: 0,
            wrong_words: 2,
            sensitive_file_exists: false,
        };
        let value = serde_json::to_value(&report).unwrap();
        for key in [
            "issues",
            "scannedChapters",
            "sensitiveWords",
            "wrongWords",
            "sensitiveFileExists",
        ] {
            assert!(value.get(key).is_some(), "缺字段 {key}");
        }
    }
}
