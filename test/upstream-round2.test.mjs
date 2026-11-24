// 上游第二轮吸收回归（2026-11-24 晚）：ZXEB v1.1.76 剩余缺口 + --doctor 口径对齐。
//
// 背景：上一轮（rc5-adaptation / rc5-adaptation-2）把 rc.5 的五处真缺口修完后，
// 还剩三件事没做，这轮补上：
//
//   A. lib/reapply.js 重复解包 app.asar。
//      刚解包出来的那份（freshExtract）unpacked-asar.json 还没落盘，
//      stamp 对不上当前 asar。若 applyPatchesAllHosts 还传 forApply:true，
//      会再次走 resolveOfficialAiBase -> openSealedDesktopHost(forApply)
//      -> shouldExtractAsar，把 app.asar 又解一遍 —— 官方桌面端首次解包升级
//      会重复解包一次（实测一次解包要几十秒，官方 asar 200MB 量级）。
//      修法（吸收 ZXEB v1.1.76）：forApply 传 !freshExtract，另加 discover:true。
//
//   B. --doctor 的 drifted / missing_file 口径与 --status 打架。
//      doctor 原来只认「替换产物整行完全相等」，而官方产物常在行尾多一个分号
//      （`const X = "...";` vs 补丁 replace 写出的 `const X = "..."`）→
//      明明写进宿主却报 drifted（实测 39 条假 drifted）。
//      另外 doctor 逐 replacement 判，不认 marker 已在（#89→#107 这类链式改写
//      会把前一条的产物行改掉）；「可选文件在这份宿主里根本不存在」也压过了 applied。
//      修法：replacementResultPresent() 容忍行尾分号差异 + 前后缀匹配；
//      整体判据改用 core.filePatchOutcome（与 patchStatus 同一口径）；
//      rollup 改成 read_error > pending > drifted > applied > na/missing_file。
//
//   C. 旧用户预设的 rc.5 键迁移（modelSelectionSettings → modelSelection +
//      modelDiscovery、删 backgroundMode）。包内预设本轮已迁，但用户目录里
//      已落地的那份仍可能留着旧键 —— rc.5 的 Config 里 modelSelection 默认 false，
//      旧键留着等于模型选择静默失效。
//
// 断言不依赖本机宿主：合成夹具 + 纯函数 + 源码文本检查。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── A. lib/reapply.js 重复解包 ────────────────────────────────────────────

test("reapplyInstalled 在 freshExtract 时不再传 forApply:true（防重复解包 app.asar）", async () => {
  const src = fs.readFileSync(path.join(REPO, "lib", "reapply.js"), "utf8");
  const call = src.match(/applyPatchesAllHosts\([^;]*?\}/s);
  assert.ok(call, "reapply.js 里应能找到 applyPatchesAllHosts 调用");

  const body = call[0];
  assert.ok(
    /forApply:\s*!freshExtract/.test(body),
    "freshExtract 时 forApply 必须是 false（否则会二次 openSealedDesktopHost → 重复解包）",
  );
  assert.ok(
    /discover:\s*true/.test(body),
    "必须带 discover:true，保证 enumeratePatchAiBases 仍能枚举到桌面宿主",
  );
  assert.ok(
    !/forApply:\s*true\s*[,}]/.test(body),
    "不能再出现硬编码 forApply:true",
  );
});

test("reapplyInstalled 里 freshExtract 分支仍会落 unpacked-asar.json stamp", async () => {
  const src = fs.readFileSync(path.join(REPO, "lib", "reapply.js"), "utf8");
  assert.ok(
    /freshExtract\?\.archive\s*\)\s*core\.writeUnpackedAsarStamp/.test(src),
    "清洗成功后必须写 unpacked-asar.json，否则下一次启动 stamp 对不上会再解一次",
  );
});

// ── B. --doctor 口径 ──────────────────────────────────────────────────────

test("replacementResultPresent 容忍行尾分号差异（官方产物多一个 ; ）", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  assert.equal(typeof doctor.replacementResultPresent, "function");

  const body = 'const X = "hello world";\nconst Y = 1;\n';
  const lineSet = new Set(body.split("\n").map((l) => l.trim()));

  // 补丁 replace 写的是不带分号的版本
  assert.equal(
    doctor.replacementResultPresent(body, lineSet, 'const X = "hello world"'),
    true,
    "文件里多一个行尾分号也应判定为已落地",
  );
  // 反向：补丁 replace 带分号、文件里没有
  const body2 = 'const X = "hello world"\n';
  const lineSet2 = new Set(body2.split("\n").map((l) => l.trim()));
  assert.equal(
    doctor.replacementResultPresent(body2, lineSet2, 'const X = "hello world";'),
    true,
    "反过来的分号差异同样应判定为已落地",
  );
  // 真没落地时不能误判
  const absent = 'const Z = 3;\n';
  const absentSet = new Set(absent.split("\n").map((l) => l.trim()));
  assert.equal(
    doctor.replacementResultPresent(absent, absentSet, 'const X = "hello world"'),
    false,
    "文件里确实没有这一行时必须判未落地",
  );
});

test("replacementResultPresent 不把过短的产物行当成已落地", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  const body = "x\n";
  const lineSet = new Set(body.split("\n").map((l) => l.trim()));
  assert.equal(
    doctor.replacementResultPresent(body, lineSet, "x"),
    false,
    "长度不足的产物行不能算已落地（避免误判 applied）",
  );
});

test("diagnosePatches 对已写进宿主的补丁不再报 drifted（marker 口径）", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  const core = await import("../lib/core.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-doctor-"));
  try {
    // 用一条真补丁（#1），但只给它一个「宿主文件里已经写好产物」的场景：
    // 产物行比 replace 多一个行尾分号 —— 官方产物就是这个形态。
    const p = core.ALL_PATCHES.find((x) => x.id === 1);
    assert.ok(p, "#1 应存在");
    const rep = p.replacements[1];
    const repLine = String(rep.replace)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    assert.ok(repLine.length >= 12);

    const fp = path.join(root, "agent-instructions.js");
    fs.writeFileSync(fp, `${repLine};\n`, "utf8");

    const rep2 = await doctor.diagnosePatches(root, [p], {
      files: { "agent-instructions": fp },
      surface: "web",
    });
    assert.equal(
      rep2.counts.drifted,
      0,
      `产物已在文件里（只差行尾分号）时不该报 drifted，实际 counts=${JSON.stringify(rep2.counts)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diagnosePatches：可选文件缺失不算 missing_file（与 --status 的 na 对齐）", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  const core = await import("../lib/core.js");

  const p = core.ALL_PATCHES.find((x) => x.optional === true && x.id !== 80);
  assert.ok(p, "应至少有一条 optional 补丁");

  const rep = await doctor.diagnosePatches("D:/nowhere", [p], {
    files: {},
    surface: "web",
  });
  assert.equal(rep.counts.missing_file, 0, "optional 补丁的目标文件不存在时不应算 missing_file");
  assert.equal(rep.counts.na, 1, "optional 补丁应当计入 na（与 patchStatus 一致）");
});

test("diagnosePatches：非 optional 补丁目标文件全缺才算 missing_file", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  const core = await import("../lib/core.js");

  const p = core.ALL_PATCHES.find((x) => x.optional !== true && x.id !== 80);
  assert.ok(p, "应至少有一条非 optional 补丁");

  const rep = await doctor.diagnosePatches("D:/nowhere", [p], {
    files: {},
    surface: "web",
  });
  assert.equal(rep.counts.missing_file, 1, "非 optional 补丁目标文件全缺时应算 missing_file");
});

test("diagnosePatches 与 patchStatus 对同一夹具给出一致的 applied/pending 结论", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  const core = await import("../lib/core.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-doctor-b-"));
  try {
    const p = core.ALL_PATCHES.find((x) => x.id === 1);
    const rep = p.replacements[1];
    // 只留 pattern 不留产物 → 两边都该说 pending
    const fp = path.join(root, "agent-instructions.js");
    fs.writeFileSync(fp, `${rep.pattern}\n`, "utf8");

    const dr = await doctor.diagnosePatches(root, [p], {
      files: { "agent-instructions": fp },
      surface: "web",
    });
    assert.ok(
      dr.counts.pending + dr.counts.applied + dr.counts.drifted >= 1,
      "doctor 至少要给出一条结论",
    );
    assert.equal(dr.counts.drifted, 0, "pattern 还在、产物不在 = pending，不是 drifted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── C. 旧用户预设的 rc.5 键迁移 ──────────────────────────────────────────

test("redteam 预设自愈会把 modelSelectionSettings 迁成 modelSelection + modelDiscovery", async () => {
  const redteam = await import("../lib/redteam/index.js");
  assert.equal(typeof redteam.migrateSubagentConfigKeys, "function");

  const old = [
    "    - id: tool-subagent",
    "      name: '@deepseek-ai/dsh-tool-subagent'",
    "      config:",
    "        provider: spawn",
    "        toolName: subagent",
    "        modelSelectionSettings: true",
    "        backgroundMode: continuable",
    "        maxDepth: 1",
    "",
  ].join("\n");

  const out = redteam.migrateSubagentConfigKeys(old);
  assert.ok(out.changed, "旧键应被判为需要迁移");
  assert.ok(/modelSelection:\s*true/.test(out.text), "应迁出 modelSelection: true");
  assert.ok(/modelDiscovery:\s*true/.test(out.text), "应迁出 modelDiscovery: true");
  assert.ok(!/modelSelectionSettings/.test(out.text), "modelSelectionSettings 应被移除");
  assert.ok(!/backgroundMode/.test(out.text), "backgroundMode 在 rc.5 已被移除，应被删掉");
  assert.ok(/maxDepth:\s*1/.test(out.text), "maxDepth: 1 必须保留（叶子约束）");
});

test("migrateSubagentConfigKeys 是幂等的（已是新键就不动）", async () => {
  const redteam = await import("../lib/redteam/index.js");
  const modern = [
    "    - id: tool-subagent",
    "      config:",
    "        provider: spawn",
    "        modelSelection: true",
    "        modelDiscovery: true",
    "        maxDepth: 1",
    "",
  ].join("\n");
  const out = redteam.migrateSubagentConfigKeys(modern);
  assert.equal(out.changed, false, "已是新形态不应再改");
  assert.equal(out.text, modern, "内容不应被改动");
});

test("migrateSubagentConfigKeys 保留 modelSelection:false（不擅自开启模型选择）", async () => {
  const redteam = await import("../lib/redteam/index.js");
  const old = [
    "    - id: tool-subagent",
    "      config:",
    "        modelSelectionSettings: false",
    "",
  ].join("\n");
  const out = redteam.migrateSubagentConfigKeys(old);
  assert.ok(out.changed);
  assert.ok(/modelSelection:\s*false/.test(out.text), "false 应原样迁移，不能被改成 true");
  assert.ok(!/modelDiscovery/.test(out.text), "false 时不应新增 modelDiscovery: true");
});

test("包内预设已无 rc.5 废弃键（backgroundMode / modelSelectionSettings / toolFilter）", async () => {
  const yml = fs.readFileSync(path.join(REPO, "presets", "redteam", "agent.cordis.yml"), "utf8");
  const configLines = yml
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.ok(!/backgroundMode:/.test(configLines), "backgroundMode 在 rc.5 已被移除");
  assert.ok(!/modelSelectionSettings:/.test(configLines), "modelSelectionSettings 在 rc.4+ 已改名");
  assert.ok(!/toolFilter:/.test(configLines), "toolFilter 在 rc.5 会直接抛错");
  assert.ok(!/dsh-workflow-worker-thread/.test(configLines), "rc.5 没有 workflow-worker-thread 这个包");
});
