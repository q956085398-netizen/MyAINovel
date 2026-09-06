import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { BookEntry } from "./types";

const PATH_KEY = "gongbi.libraryPath";

const layoutLabel: Record<BookEntry["layout"], string> = {
  scattered: "散文件",
  "folder-book": "一书一文件夹",
};

function formatCount(n: number): string {
  return n.toLocaleString("zh-Hans-CN");
}

export default function BookLibrary() {
  const [libraryPath, setLibraryPath] = useState<string | null>(
    () => localStorage.getItem(PATH_KEY),
  );
  const [books, setBooks] = useState<BookEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async (path: string) => {
    setScanning(true);
    setError(null);
    try {
      setBooks(await invoke<BookEntry[]>("scan_library", { root: path }));
    } catch (e) {
      setBooks([]);
      setError(`扫描失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (libraryPath) void scan(libraryPath);
  }, [libraryPath, scan]);

  async function chooseFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择拆书库文件夹",
    });
    if (typeof picked === "string") {
      localStorage.setItem(PATH_KEY, picked);
      setLibraryPath(picked);
    }
  }

  const scatteredCount = books.filter((b) => b.layout === "scattered").length;
  const folderCount = books.length - scatteredCount;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>拆书书库</h1>
          {libraryPath && (
            <p className="library-path" title={libraryPath}>
              {libraryPath}
            </p>
          )}
        </div>
        <div className="page-actions">
          {libraryPath && (
            <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
              刷新
            </button>
          )}
          <button className="btn primary" onClick={() => void chooseFolder()}>
            打开库文件夹
          </button>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {!libraryPath && (
        <div className="empty-state">
          <p>还没有打开拆书库。</p>
          <p className="hint">
            库文件夹可以直接指向现有的 Obsidian vault 子目录；
            <br />
            根目录散文件与一书一文件夹两种布局都认，不会搬动或改写你的文件。
          </p>
        </div>
      )}

      {libraryPath && scanning && <div className="empty-state">正在扫描……</div>}

      {libraryPath && !scanning && !error && books.length === 0 && (
        <div className="empty-state">
          <p>这个文件夹里没有找到拆书稿（.md）。</p>
          <p className="hint">确认选中的是存放拆书 .md 文件的那一层目录。</p>
        </div>
      )}

      {books.length > 0 && (
        <>
          <p className="stats">
            共 {formatCount(books.length)} 本 · 散文件 {formatCount(scatteredCount)} ·
            一书一文件夹 {formatCount(folderCount)}
          </p>
          <table className="book-table">
            <thead>
              <tr>
                <th>书名</th>
                <th>布局</th>
                <th className="num">章数</th>
                <th className="num">字数</th>
                <th>元数据</th>
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.primaryMd}>
                  <td className="book-name">{b.name}</td>
                  <td>{layoutLabel[b.layout]}</td>
                  <td className="num">{formatCount(b.chapterCount)}</td>
                  <td className="num">{formatCount(b.wordCount)}</td>
                  <td>{b.yamlPath ? "已生成" : "未生成"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
