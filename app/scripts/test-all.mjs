import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
if (files.length === 0) throw new Error("没有找到前端测试文件");
const result = spawnSync(process.execPath, [
  "--import", "./tests/helpers/register-tsx-loader.mjs", "--test", ...files,
], { cwd: appDir, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
