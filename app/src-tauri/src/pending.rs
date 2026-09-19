//! 工作台待办摘要（工单 #56 / T01）：窄轨「当前项目」面板的真实待办来源。
//!
//! 口径只有一条——**现扫派生、不造进度**：超期的伏笔与期待/目标线
//! （各自看板已有的 overdue 判定），按「已过未推进章数」降序，最多 5 条。
//! 没有就返回空表，面板如实显示「没有」；表坏了把错误原样递给前端。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::expectation;
use crate::foreshadow;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLine {
    /// 看板归属：伏笔｜期待｜目标（跳转落点即构思对应页签）。
    pub board: String,
    pub name: String,
    /// 距当前最大章序已过多少章未推进。
    pub lag: u32,
}

/// 待办全量带回：面板只摆 1～3 条标题，剩余数要如实报「还有 N 条」，
/// 在后端截断会把 N 说小——超期线索总量本身有限，不设上限。
pub fn project_pending(project: &Path) -> Result<Vec<PendingLine>, String> {
    let mut lines = Vec::new();
    for v in foreshadow::foreshadow_board(project)? {
        if v.overdue {
            lines.push(PendingLine {
                board: "伏笔".to_string(),
                name: v.name,
                lag: v.uncollected_chapters.unwrap_or(0),
            });
        }
    }
    for v in expectation::expectation_board(project)?.items {
        if v.overdue {
            lines.push(PendingLine {
                board: v.kind,
                name: v.name,
                lag: v.unadvanced_chapters.unwrap_or(0),
            });
        }
    }
    lines.sort_by(|a, b| b.lag.cmp(&a.lag).then_with(|| a.name.cmp(&b.name)));
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    use crate::expectation::{
        annotate_expectation, KIND_EXPECTATION, KIND_GOAL, HORIZON_SHORT,
    };
    use crate::foreshadow::{annotate_foreshadow, recover_foreshadow, RECOVERY_FINAL};

    fn write(path: &std::path::Path, content: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn project(root: &Path) -> std::path::PathBuf {
        let dir = root.join("项目/《大魏读书人》");
        fs::create_dir_all(dir.join("正文")).unwrap();
        dir
    }

    fn chapter(project: &Path, ordinal: u32) {
        write(
            &project.join(format!("正文/{ordinal:04} 章.md")),
            &format!("第{ordinal}章的正文，提到黄铜钥匙。"),
        );
    }

    #[test]
    fn 空项目_返回空表() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        assert_eq!(project_pending(&p).unwrap(), Vec::new());
    }

    #[test]
    fn 超期伏笔与超期期待线_按未推进章数降序() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        for n in 1..=30 {
            chapter(&p, n);
        }
        // 伏笔埋在第 1 章 → 距 30 章已 29 章未收（≥20 超期）。
        annotate_foreshadow(&p, "黄铜钥匙", 1, "他摸了摸口袋里的黄铜钥匙").unwrap();
        // 短档期待线埋在第 20 章 → 距 30 章已 10 章未兑现（短档阈值 8，超期）。
        annotate_expectation(&p, "主角何时亮出金手指", 20, "第20章的正文", KIND_EXPECTATION, HORIZON_SHORT).unwrap();
        // 长档目标线埋在第 29 章 → 只过 1 章，不超期，不该出现。
        annotate_expectation(&p, "打上界", 29, "第29章的正文", KIND_GOAL, "长").unwrap();

        let lines = project_pending(&p).unwrap();
        assert_eq!(lines.len(), 2);
        // 伏笔 lag 29 > 期待线 lag 10，降序在前。
        assert_eq!(lines[0].board, "伏笔");
        assert_eq!(lines[0].name, "黄铜钥匙");
        assert_eq!(lines[0].lag, 29);
        assert_eq!(lines[1].board, "期待");
        assert_eq!(lines[1].name, "主角何时亮出金手指");
        assert_eq!(lines[1].lag, 10);
        assert!(!lines.iter().any(|l| l.name == "打上界"));
    }

    #[test]
    fn 已收伏笔_不算待办() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        for n in 1..=25 {
            chapter(&p, n);
        }
        annotate_foreshadow(&p, "黄铜钥匙", 1, "他摸了摸口袋里的黄铜钥匙").unwrap();
        recover_foreshadow(&p, "黄铜钥匙", 25, "第25章的正文", RECOVERY_FINAL, None).unwrap();
        assert_eq!(project_pending(&p).unwrap(), Vec::new());
    }

    #[test]
    fn 线表坏了_错误上抛不吞() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&crate::foreshadow::foreshadow_path(&p), "顶层不是列表: true\n");
        assert!(project_pending(&p).is_err());
    }

    #[test]
    fn 超过多条_全量带回不截断() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        for n in 1..=40 {
            chapter(&p, n);
        }
        for i in 0..7 {
            annotate_foreshadow(&p, &format!("伏笔{i}"), 1, "他摸了摸口袋里的黄铜钥匙").unwrap();
        }
        let lines = project_pending(&p).unwrap();
        assert_eq!(lines.len(), 7);
        assert!(lines.iter().all(|l| l.lag == 39));
    }
}
