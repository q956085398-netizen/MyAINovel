mod book_file;
mod library;

use std::path::Path;

use book_file::BookMeta;
use library::BookEntry;

#[tauri::command]
fn scan_library(root: String) -> Result<Vec<BookEntry>, String> {
    let path = std::path::PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("不是有效的文件夹：{root}"));
    }
    library::scan_library(&path)
}

#[tauri::command]
fn read_book_md(path: String) -> Result<String, String> {
    book_file::read_text(Path::new(&path))
}

#[tauri::command]
fn save_book_md(path: String, content: String) -> Result<(), String> {
    book_file::write_text_atomic(Path::new(&path), &content)
}

#[tauri::command]
fn read_book_meta(md_path: String) -> Result<BookMeta, String> {
    book_file::read_book_meta(Path::new(&md_path))
}

#[tauri::command]
fn save_book_meta(md_path: String, meta: BookMeta) -> Result<(), String> {
    book_file::write_book_meta(Path::new(&md_path), &meta)
}

#[tauri::command]
fn next_chapter_line(content: String, template: String) -> String {
    book_file::next_chapter_line(&content, &template)
}

#[tauri::command]
fn save_paste_image(md_path: String, ext: String, bytes: Vec<u8>) -> Result<String, String> {
    book_file::save_paste_image(Path::new(&md_path), &ext, &bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            read_book_md,
            save_book_md,
            read_book_meta,
            save_book_meta,
            next_chapter_line,
            save_paste_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
