/**
 * TS/TSX 模块钩子（工单 #77 页面回归设施）：
 *  页面回归直接 import 生产源码（含 .tsx），Node 原生类型剥离不认 JSX，
 *  这里用仓库已有的 typescript 包做内存转译（ReactJSX 产出 → react/jsx-runtime），
 *  不落盘、不改生产代码。只对仓库 app/src 与 app/tests 下的相对导入生效。
 */
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const transpileOptions = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    useDefineForClassFields: true,
  },
  fileName: undefined,
};

function isRepoSource(url) {
  return url.includes("/app/src/") || url.includes("/app/tests/");
}

const candidates = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    isRepoSource(parent) &&
    !/\.(ts|tsx|js|jsx|css|json|mjs|cjs)$/i.test(specifier)
  ) {
    const base = path.join(path.dirname(fileURLToPath(parent)), specifier);
    for (const ext of candidates) {
      const candidate = base + ext;
      try {
        const s = await stat(candidate);
        if (s.isFile()) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      } catch {
        // 尝试下一个候选扩展名
      }
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if ((url.endsWith(".ts") || url.endsWith(".tsx")) && isRepoSource(url)) {
    const file = fileURLToPath(url);
    const source = await readFile(file, "utf8");
    const { outputText, diagnostics } = ts.transpileModule(source, {
      ...transpileOptions,
      fileName: file,
    });
    const serious = diagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error && d.code === 2307,
    );
    if (serious.length > 0) {
      throw new Error(
        `转译失败（模块解析）${file}: ${ts.flattenDiagnosticMessageText(serious[0].messageText, " ")}`,
      );
    }
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context, nextLoad);
}
