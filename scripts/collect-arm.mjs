#!/usr/bin/env node
// collect-arm.mjs — 双臂采集管道（ABSORPTION-TASKBOOK.md T-03）
// 读 eval/prompts/*.jsonl（每行 {id, prompt, expected_domain?, category?}），
// POST 到 OpenAI 兼容端点 /chat/completions，产 {id, reply} jsonl 喂 bin/dsh-purge.js --eval。
//
// 用法：
//   DSH_PURGE_EVAL_BASE_URL=http://127.0.0.1:31415/v1 \
//   DSH_PURGE_EVAL_API_KEY=sk-... DSH_PURGE_EVAL_MODEL=deepseek-chat \
//   node scripts/collect-arm.mjs --prompts eval/prompts/probes-core.jsonl --label A
//
// 参数：--prompts <jsonl>（必填） --label <A|B|名字>（默认 A）
//       --out <jsonl>（默认 eval/results/arm-<label>-<yyyymmdd-hhmm>.jsonl）
//       --system <文本>（可选，作为 system 消息前缀；双臂对比的关键：臂 A 空/出厂，臂 B purge 后）
//       --system-file <路径> --concurrency <n>（默认 4） --retries <n>（默认 2）
//       --temperature <f>（默认 0.7） --timeout <ms>（默认 120000）
// 环境变量：DSH_PURGE_EVAL_BASE_URL / DSH_PURGE_EVAL_API_KEY / DSH_PURGE_EVAL_MODEL
// 输出：每行 {id, reply, ok, err?}；reply 为空串 + ok:false 表示该条失败（--eval 会按空回退判）。

import fs from "node:fs";
import path from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1 || i + 1 >= process.argv.length) return dflt;
  return process.argv[i + 1];
}

const promptsPath = arg("prompts", "");
if (!promptsPath) {
  console.error("collect-arm: --prompts <jsonl> 必填");
  process.exit(2);
}
const label = arg("label", "A");
const base = process.env.DSH_PURGE_EVAL_BASE_URL || "";
const key = process.env.DSH_PURGE_EVAL_API_KEY || "";
const model = process.env.DSH_PURGE_EVAL_MODEL || "";
if (!base || !model) {
  console.error("collect-arm: 需要 DSH_PURGE_EVAL_BASE_URL 与 DSH_PURGE_EVAL_MODEL");
  process.exit(2);
}
const concurrency = Math.max(1, parseInt(arg("concurrency", "4"), 10));
const retries = Math.max(0, parseInt(arg("retries", "2"), 10));
const temperature = parseFloat(arg("temperature", "0.7"));
const timeoutMs = parseInt(arg("timeout", "120000"), 10);

let systemText = arg("system", "");
const systemFile = arg("system-file", "");
if (systemFile) systemText = fs.readFileSync(systemFile, "utf8");

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
const outPath = arg("out", path.join("eval", "results", `arm-${label}-${stamp}.jsonl`));

const rows = fs.readFileSync(promptsPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
console.error(`collect-arm: ${rows.length} prompts -> ${outPath} (label=${label}, model=${model}, concurrency=${concurrency})`);

async function sendOne(row) {
  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  messages.push({ role: "user", content: row.prompt });
  const body = JSON.stringify({ model, messages, temperature });
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
        body,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content ?? "";
      return { id: row.id, reply, ok: reply.length > 0 };
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) return { id: row.id, reply: "", ok: false, err: String(e && e.message || e).slice(0, 300) };
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const results = new Array(rows.length);
let next = 0;
async function worker() {
  while (next < rows.length) {
    const i = next++;
    results[i] = await sendOne(rows[i]);
    const r = results[i];
    process.stderr.write(`  [${i + 1}/${rows.length}] ${r.id} ${r.ok ? "ok" : "FAIL " + (r.err || "")}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const outRows = results.filter(Boolean).map(({ id, reply }) => ({ id, reply }));
fs.writeFileSync(outPath, outRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const okN = results.filter((r) => r && r.ok).length;
console.error(`collect-arm: done ${okN}/${rows.length} ok -> ${outPath}`);
process.exit(okN === rows.length ? 0 : 1);
