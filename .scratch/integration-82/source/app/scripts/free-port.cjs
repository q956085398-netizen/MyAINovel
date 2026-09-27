// predev 钩子：起 vite 前清掉占住 dev 端口的残留进程。孤儿 vite（上次没退干净）
// 会因 strictPort 把后续每次启动无声顶死，且报错全发生在隐藏控制台里（2026-09-19 踩坑）。
// 只结束 node.exe；别的程序占口不敢动，说明白后失败退出。
const { execSync } = require("node:child_process");

const PORT = Number(process.env.GONGBI_DEV_PORT || 1420);

if (process.platform !== "win32") process.exit(0);

function listenerPids() {
  const out = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length === 5 && cols[3] === "LISTENING" && cols[1].endsWith(`:${PORT}`)) {
      pids.add(cols[4]);
    }
  }
  return [...pids];
}

function imageName(pid) {
  const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
    encoding: "utf8",
    windowsHide: true,
  });
  const first = out.split(/\r?\n/)[0] || "";
  if (!first.startsWith('"')) return null; // 查到的瞬间进程已经不在了
  return first.slice(1, first.indexOf('",'));
}

for (const pid of listenerPids()) {
  const image = imageName(pid);
  if (image === null) continue;
  if (image.toLowerCase() !== "node.exe") {
    console.error(
      `[free-port] 端口 ${PORT} 被 ${image} (PID ${pid}) 占用，不是残留的 vite，不敢自动结束；请手动处理后再启动。`
    );
    process.exit(1);
  }
  execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true });
  console.log(`[free-port] 端口 ${PORT} 被残留 node.exe (PID ${pid}) 占用，已结束它。`);
}
