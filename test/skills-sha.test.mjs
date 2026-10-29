// 红队技能树的存在性与完整性。
//
// 这组断言防的是同一类回归：官方 1.1.72 起把 skills/ 从发布包移除
// （package.json 的 files 不再含 skills），代码却仍在读 skills/redteam，
// 结果是演练台技能清单静默变空 —— 没有报错、没有日志，只有用户看见空白。
// 所以三件事都要钉住：目录在、清单对得上、files 里没漏。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "skills-sha.mjs");
const SKILL_DIR = path.join(ROOT, "skills", "redteam");

test("skills/redteam 与 SKILLS-SHA256.txt 逐文件一致", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--verify"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /^ok\s+\d+ files match SKILLS-SHA256\.txt/m);
});

test("skills/redteam 至少 24 个技能（1.1.73 的完整集合）", () => {
  const files = fs
    .readdirSync(SKILL_DIR)
    .filter((name) => name.endsWith(".md") && name !== "SKILLS-SHA256.txt");
  assert.ok(files.length >= 24, `expected >= 24 skill files, got ${files.length}`);
  for (const required of ["recon-pipeline.md", "webshell-toolkit.md", "evidence-discipline.md"]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
});

test("package.json 的 files 包含 skills，否则发布包里没有技能", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("skills"), "files must include \"skills\"");
});
