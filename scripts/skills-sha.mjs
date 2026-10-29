#!/usr/bin/env node
// 红队技能清单：生成 / 校验 skills/redteam 的逐文件 SHA256。
//
// 背景：官方 1.1.72 起把 skills/ 从发布包移除（package.json 的 files 不再含
// skills），但 lib/redteam/ui.js 仍在探 skills/redteam —— 于是演练台技能清单
// 永远是空的。这里把技能树补回仓库，并用一份 SHA256 清单把它钉住：任何一次
// 误改（换行符、编码、删文件）都会在校验里现形，而不是等到用户打开演练台才发现。
//
// 用法：
//   node scripts/skills-sha.mjs            生成/覆盖 skills/redteam/SKILLS-SHA256.txt
//   node scripts/skills-sha.mjs --verify   校验，不匹配则 exit 1
//   node scripts/skills-sha.mjs --list     只打印清单，不落盘

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SKILL_DIR = path.join(ROOT, "skills", "redteam");
const MANIFEST = path.join(SKILL_DIR, "SKILLS-SHA256.txt");
const MANIFEST_NAME = "SKILLS-SHA256.txt";

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name !== MANIFEST_NAME) out.push(full);
  }
  return out;
}

function relPosix(full) {
  return path.relative(ROOT, full).split(path.sep).join("/");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildEntries() {
  if (!fs.existsSync(SKILL_DIR)) return [];
  return walk(SKILL_DIR)
    .map((full) => ({ path: relPosix(full), hash: sha256(full) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return [];
  return fs
    .readFileSync(MANIFEST, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const m = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
      return m ? { hash: m[1], path: m[2].trim() } : null;
    })
    .filter(Boolean);
}

function render(entries) {
  return entries.map((e) => `${e.hash}  ${e.path}`).join("\n") + "\n";
}

const args = process.argv.slice(2);
const entries = buildEntries();

if (args.includes("--list")) {
  process.stdout.write(render(entries));
} else if (args.includes("--verify")) {
  const wantMap = new Map(readManifest().map((e) => [e.path, e.hash]));
  const gotMap = new Map(entries.map((e) => [e.path, e.hash]));
  const problems = [];
  if (!wantMap.size) problems.push("SKILLS-SHA256.txt missing or empty");
  for (const [p, h] of wantMap) {
    if (!gotMap.has(p)) problems.push(`missing  ${p}`);
    else if (gotMap.get(p) !== h) problems.push(`changed  ${p}`);
  }
  for (const p of gotMap.keys()) if (!wantMap.has(p)) problems.push(`extra    ${p}`);
  if (problems.length) {
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(`ok  ${gotMap.size} files match SKILLS-SHA256.txt\n`);
} else {
  if (!entries.length) {
    process.stderr.write("skills/redteam not found\n");
    process.exit(1);
  }
  fs.writeFileSync(MANIFEST, render(entries), "utf8");
  process.stdout.write(`wrote ${relPosix(MANIFEST)} (${entries.length} files)\n`);
}
