#!/usr/bin/env node
// 侦察宿主补丁锚点的真实路径：不猜布局，直接复用 lib/core.js 的 targetFiles。
//
// 用法：
//   node scripts/probe-host-targets.mjs [aiBase]
//     aiBase 缺省依次试：D:\Program Files\DSH\resources\app、
//     D:\Program Files\DSH\resources\app\dsh、%LOCALAPPDATA%\Programs\DSH\resources\app
//
// 输出：本次吸收任务关心的锚点键 → 真实文件路径（空 = 该布局没有这一层）。

import path from "node:path";
import fs from "node:fs";

const CANDIDATES = [
  "D:\\Program Files\\DSH\\resources\\app",
  "D:\\Program Files\\DSH\\resources\\app\\dsh",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "DSH", "resources", "app"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "DSH", "resources", "app", "dsh"),
];

const KEYS = [
  "tool-bash", "tool-pwsh", "agent-loop", "session", "dsh-tools", "dsh-tools-types",
  "app-boot", "compaction-tool-result-pruner", "agent-model-selection", "agent-model-selection-inline",
];

const argBase = process.argv[2];
const bases = argBase ? [argBase] : CANDIDATES.filter((b) => b && fs.existsSync(b));

const { targetFiles } = await import("../lib/core.js");

let hitAny = false;
for (const aiBase of bases) {
  let files;
  try {
    files = targetFiles(aiBase);
  } catch (e) {
    console.log(`[skip] aiBase=${aiBase} → ${String(e).slice(0, 120)}`);
    continue;
  }
  const hits = KEYS.filter((k) => files[k] && files[k].length > 0);
  if (hits.length === 0) {
    console.log(`[miss] aiBase=${aiBase}（关心的锚点全空）`);
    continue;
  }
  hitAny = true;
  console.log(`=== aiBase=${aiBase} ===`);
  for (const k of hits) console.log(`  ${k}:`);
  for (const k of hits) for (const fp of files[k]) console.log(`    ${fp}`);
}
if (!hitAny) {
  console.log("[FAIL] 没有任何候选 aiBase 命中锚点；用 node scripts/probe-host-targets.mjs <aiBase> 手动指定");
  process.exit(1);
}
