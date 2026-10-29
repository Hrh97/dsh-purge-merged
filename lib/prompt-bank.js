// prompt-bank：对抗 prompt 评测集的加载与归一化。
//
// 来源与许可见 test/fixtures/prompt-bank/PROVENANCE.md。这里只做「读 + 归一化」，
// 不做任何判定 —— 判定在 leaf-inject（路由）和 refusal-scan（答复是否被拒）里。
//
// 为什么需要归一化：四个 bank 是不同时期、不同人写的，字段名不统一：
//   prompt-bank.jsonl        case_id / expected_domain
//   prompt-bank-maodie.jsonl case_id / expected_domain / expected_verdict
//   prompt-bank-mirror.jsonl 没有 case_id、没有 expected_domain，只有 scenario + descr
//   v4pro-benchmark.jsonl    case_id / domain（不是 expected_domain）/ expected_verdict
// 文件头还有以 `#` 开头的注释行（v4pro 那三个），JSON 解析必须跳过。
// 归一化把差异收敛到一处，评测代码只认一种形状。

import fs from "node:fs";
import path from "node:path";

/** 归一化后的单条用例。domain / verdict 为 null 表示该 bank 没标这一项。 */
export function normalizeCase(row) {
  const src = row && typeof row === "object" ? row : {};
  const prompt = typeof src.prompt === "string" ? src.prompt : "";
  const domain = src.expected_domain ?? src.domain ?? null;
  const verdict = src.expected_verdict ?? null;
  const id =
    (typeof src.case_id === "string" && src.case_id) ||
    [src.scenario, src.level, src.language].filter(Boolean).join("__") ||
    null;
  return {
    id,
    prompt,
    domain: typeof domain === "string" && domain ? domain : null,
    verdict: typeof verdict === "string" && verdict ? verdict : null,
    scenario: typeof src.scenario === "string" ? src.scenario : null,
    level: typeof src.level === "string" ? src.level : null,
    language: typeof src.language === "string" ? src.language : null,
    descr: typeof src.descr === "string" ? src.descr : null,
  };
}

/**
 * 解析 jsonl 文本。
 *
 * 跳过：空行、`#` 注释行、以及解析失败的坏行（坏行计入 bad，不抛）。
 * 坏行不抛是刻意的：这些 bank 是外部资产，一条脏数据不该让整个评测跑不起来；
 * 但必须把 bad 数报出去，否则「静默少测一半用例」比直接报错更糟。
 */
export function parseBankText(text) {
  const rows = [];
  const bad = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      bad.push({ line: i + 1, error: String((e && e.message) || e) });
      continue;
    }
    const one = normalizeCase(parsed);
    if (!one.prompt.trim()) {
      bad.push({ line: i + 1, error: "empty prompt" });
      continue;
    }
    rows.push(one);
  }
  return { rows, bad };
}

export function loadBank(file) {
  const text = fs.readFileSync(file, "utf8");
  return { ...parseBankText(text), file };
}

export const FIXTURE_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "test",
  "fixtures",
  "prompt-bank",
);

/** 列出夹具目录里的所有 bank（按文件名排序，保证评测顺序稳定）。 */
export function listBanks(dir = FIXTURE_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 全部 bank 合并成一份，便于跑「总体召回」。 */
export function loadAllBanks(dir = FIXTURE_DIR) {
  const banks = listBanks(dir);
  const rows = [];
  const bad = [];
  for (const file of banks) {
    const one = loadBank(file);
    const tag = path.basename(file);
    for (const row of one.rows) rows.push({ ...row, bank: tag });
    for (const item of one.bad) bad.push({ ...item, bank: tag });
  }
  return { rows, bad, banks: banks.map((f) => path.basename(f)) };
}
