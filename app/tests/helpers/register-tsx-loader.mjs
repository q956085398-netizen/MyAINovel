/** 注册 TS/TSX 转译钩子；由 `node --import` 在测试进程启动时加载。 */
import { register } from "node:module";

register("./tsx-loader.mjs", import.meta.url);
