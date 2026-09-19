/** 「当前项目」记忆（工单 #56 / T01）：窄轨面板与「继续工作」的共享状态。
 *  只存项目文件夹路径（应用状态），构思/书写两板块谁最后打开项目谁更新；
 *  纯展示态，不进创作目录。 */

const KEY = "gongbi.currentProject";

export function getCurrentProjectDir(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCurrentProjectDir(dir: string): void {
  try {
    localStorage.setItem(KEY, dir);
  } catch {
    // 存不进（隐私模式等）只是记不住，不影响使用。
  }
}
