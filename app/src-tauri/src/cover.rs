//! 封面（工单 #23，spec 书库新建与展示 §五）：约定文件名
//! `附件/封面.png|jpg|webp`，扫描现识别、零 yaml 键——删文件即撤，
//! 在 Obsidian 里手动放一张同名字即生效。多扩展名并存按 png＞jpg＞webp
//! 取其一。封面是书的数据（进创作目录、随库走），与「编辑器背景」相反。

use std::fs;
use std::path::{Path, PathBuf};

use crate::book_file::write_bytes_atomic;

/// 约定扩展名（识别与落盘共用）；次序即优先级。
pub const COVER_EXTS: [&str; 3] = ["png", "jpg", "webp"];

/// 封面文件名前缀（不含扩展名）。
const COVER_STEM: &str = "封面";

/// 在封面目录（…/附件/）里按约定文件名找封面；无则 None。
/// 目录不存在不算错误（附件/ 本就懒生成）。
pub fn find_cover(dir: &Path) -> Option<PathBuf> {
    for ext in COVER_EXTS {
        let path = dir.join(format!("{COVER_STEM}.{ext}"));
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// 设封面：把选中的图**拷贝**为 dir/封面.<ext>（原图不动）；
/// 已有旧封面文件（任意约定扩展名）删除替换——附件内至多一个封面文件。
/// 目录不存在则创建（放封面即建，附件/ 懒生成的口子）。
pub fn set_cover(dir: &Path, image: &Path) -> Result<PathBuf, String> {
    let ext = image
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| COVER_EXTS.contains(&e.as_str()))
        .ok_or_else(|| "封面只支持 png/jpg/webp 图片".to_string())?;
    let bytes =
        fs::read(image).map_err(|e| format!("无法读取图片 {}：{e}", image.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    for ext in COVER_EXTS {
        let old = dir.join(format!("{COVER_STEM}.{ext}"));
        if old.exists() {
            fs::remove_file(&old)
                .map_err(|e| format!("无法删除旧封面 {}：{e}", old.display()))?;
        }
    }
    let dest = dir.join(format!("{COVER_STEM}.{ext}"));
    write_bytes_atomic(&dest, &bytes)?;
    Ok(dest)
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
    fn 找封面_约定文件名_多扩展名按次序取一() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("附件");
        assert_eq!(find_cover(&dir), None, "目录不存在不算错");

        write(&dir.join("封面.jpg"), "j");
        assert_eq!(find_cover(&dir), Some(dir.join("封面.jpg")));

        // png 加入后压过 jpg；webp 永远殿后。
        write(&dir.join("封面.png"), "p");
        write(&dir.join("封面.webp"), "w");
        assert_eq!(find_cover(&dir), Some(dir.join("封面.png")));

        fs::remove_file(dir.join("封面.png")).unwrap();
        assert_eq!(find_cover(&dir), Some(dir.join("封面.jpg")));
    }

    #[test]
    fn 找封面_附件里的截图不误认() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("附件");
        write(&dir.join("截图-1.png"), "png");
        write(&dir.join("封面备份.png"), "备份");
        assert_eq!(find_cover(&dir), None);
    }

    #[test]
    fn 设封面_拷贝内容_目录懒创建() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("选中的封面.PNG");
        write(&src, "图片字节");

        let dest = set_cover(&tmp.path().join("书/附件"), &src).unwrap();
        assert_eq!(dest, tmp.path().join("书/附件/封面.png"), "大写扩展名归一");
        assert_eq!(fs::read(&dest).unwrap(), "图片字节".as_bytes());
        assert!(src.is_file(), "原图不动（拷贝非移动）");
    }

    #[test]
    fn 设封面_替换删旧_附件内至多一个封面() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("附件");
        write(&dir.join("封面.jpg"), "旧");
        let src = tmp.path().join("新.webp");
        write(&src, "新");

        set_cover(&dir, &src).unwrap();

        assert!(dir.join("封面.webp").is_file());
        assert!(!dir.join("封面.jpg").exists(), "旧封面删除");
        let covers = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("封面"))
            .count();
        assert_eq!(covers, 1);
    }

    #[test]
    fn 设封面_非法扩展名报错() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("图.gif");
        write(&src, "gif");
        assert!(set_cover(&tmp.path().join("附件"), &src).is_err());
        assert!(!tmp.path().join("附件").exists(), "失败不留目录");
    }
}
