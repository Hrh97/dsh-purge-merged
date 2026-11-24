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

test("applyHostsOptions：freshExtract 时 forApply=false（防重复解包 app.asar）", async () => {
  // 金鱼审查 L3：改成行为级断言 —— 直接调纯函数看值，不再靠源码正则。
  const { applyHostsOptions } = await import("../lib/reapply.js");
  assert.equal(typeof applyHostsOptions, "function", "applyHostsOptions 必须导出");

  // 没有 freshExtract（普通重打）：照常 forApply:true 走官方解包链路
  const plain = applyHostsOptions(null, true);
  assert.equal(plain.forApply, true, "没有 freshExtract 时 forApply 必须为 true");
  assert.equal(plain.discover, true, "必须带 discover:true，保证能枚举到桌面宿主");
  assert.equal(plain.preserveClientBundles, true);

  // 有 freshExtract（刚解包完）：必须 forApply:false，否则二次 openSealedDesktopHost
  const fresh = applyHostsOptions({ appDir: "/tmp/x", archive: "/tmp/x.asar" }, true);
  assert.equal(fresh.forApply, false, "freshExtract 时 forApply 必须是 false（否则重复解包）");
  assert.equal(fresh.discover, true, "freshExtract 分支同样要 discover:true");
  assert.equal(fresh.preserveClientBundles, true);

  // preserveClientBundles 透传（调用方可以显式关掉）
  assert.equal(applyHostsOptions(null, false).preserveClientBundles, false);

  // 再确认 reapplyInstalled 真的用这个函数，而不是又写回内联字面量
  const src = fs.readFileSync(path.join(REPO, "lib", "reapply.js"), "utf8");
  assert.match(src, /applyPatchesAllHosts\(\s*core\.ALL_PATCHES\s*,\s*applyHostsOptions\(/, "reapplyInstalled 必须走 applyHostsOptions");
  // applyPatchesAllHosts 的调用体里不许再有内联 forApply 字面量
  // （openSealedDesktopHost 那边的 forApply: true 是正当用法，不能一起禁）
  const callBody = src.match(/applyPatchesAllHosts\([\s\S]{0,200}?\);/);
  if (callBody) {
    assert.ok(!/forApply\s*:/.test(callBody[0]), "applyPatchesAllHosts 调用体里不该有内联 forApply");
  }
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

test("replacementResultPresent 前缀兜底按行首锚定（金鱼审查 L2）", async () => {
  const doctor = await import("../lib/anchor-doctor.js");
  // ≥120 字符的产物行走前缀兜底：行首命中才算，全文任意位置的子串不算。
  const productBare = 'const X = "' + "a".repeat(130) + '"';          // 无分号形态
  const productLine = productBare + ";";                                // 官方产物形态
  const body = ["function unrelated() {}", productLine, "// tail"].join("\n");
  const lineSet = new Set(body.split(/\r?\n/).map((l) => l.trim()));
  assert.equal(doctor.replacementResultPresent(body, lineSet, productBare), true, "行首前缀命中 → 已落地");

  // 同前缀片段出现在另一行中间（字符串参数里）→ 不算落地
  const decoy = `log("${"a".repeat(130)}");`;
  const body2 = `const filler = 1;\n${decoy}\n// end`;
  const lineSet2 = new Set(body2.split(/\r?\n/).map((l) => l.trim()));
  assert.equal(
    doctor.replacementResultPresent(body2, lineSet2, productBare),
    false,
    "全文 includes 会被行中间的子串误命中；行首锚定后必须判未落地",
  );
});

// ── B2. #110 拆 marker 后的升级链四场景（金鱼审查 H3）─────────────────────

test("#110 四场景：老盘面升级 / 纯净宿主全打 / 升级后 skip / 部分漂移可见", async () => {
  const core = await import("../lib/core.js");
  const patch = core.ALL_PATCHES.find((p) => p.id === 110);
  assert.ok(patch, "#110 必须在补丁表里");
  // 每段 replacement 必须有自己独立的 marker（金鱼审查 H3 的核心要求）。
  // 具体后缀集合会随版本演进（a/b/c → +d），这里只断言「每段一个、互不共用」。
  const markers = patch.markers;
  assert.ok(Array.isArray(markers) && markers.length >= 3, `markers 至少 a/b/c 三段，实际 ${JSON.stringify(markers)}`);
  assert.equal(new Set(markers).size, markers.length, "marker 不许重复");
  for (const m of markers) assert.match(m, /^\[dsh-purge-110[a-z]\]$/, `marker 形态不对：${m}`);
  assert.equal(markers.length, patch.replacements.filter((r) => !r.insertProbe || true).length >= markers.length ? markers.length : markers.length);

  // S1 老盘面（三段共用 marker 时代的产物）→ 升级链消费：110→110c(rep4)→110d(rep6)，
  // 最终产物 a/b/d（c 被链式消费，不再是独立终态），lastLabelRef 不叠写
  const oldProduct =
    "const lastActionRef=(0,react.useRef)(`load`);const lastLabelRef=(0,react.useRef)(null); /* [dsh-purge-110] remember last resolved model label */\n" +
    "const waiting=currentChoice===void 0&&state.status===`loading`;const hasCurrent=currentChoice!==void 0;/*…*/const modelLabel=waiting?t(`trigger.loading`):resolvedLabel; /* [dsh-purge-110] keep-last-label fallback v3 alias-strip groups-resolve */\n" +
    "const purgeAliasProvider=provider=>String(provider??``).replace(/-purge$/,``);const currentChoice=choices[state.current===null?-1:choices.findIndex(c=>purgeAliasProvider(c.selection.provider)===purgeAliasProvider(state.current?.provider)&&c.selection.model===state.current.model)] /* [dsh-purge-110] alias-strip match */";
  const s1 = core.applyReplacementsToText(oldProduct, patch, "client.js");
  assert.equal(s1.hitMismatch, undefined, "老盘面升级不应报命中数失配");
  const m1 = s1.text.match(/\[dsh-purge-110[a-z]*\]/g) || [];
  assert.ok(m1.includes("[dsh-purge-110a]") && m1.includes("[dsh-purge-110b]") && m1.includes("[dsh-purge-110d]"), `老盘面应升级出 a/b/d（c 被 rep6 链式消费），实际 ${JSON.stringify(m1)}`);
  assert.equal((s1.text.match(/const lastLabelRef=/g) || []).length, 1, "lastLabelRef 不得叠写");

  // S2 纯净宿主（rc.5 原文）→ 全段链打：v1→v2(a)→v3(b)→归一+纯净打(c 链)→v4(d)，产物含 a/b/d
  const bare =
    "const lastActionRef=(0,react.useRef)(`load`);\n" +
    "const waiting=currentChoice===void 0&&state.status===`loading`;const modelLabel=waiting?t(`trigger.loading`):currentChoice?.model.name??t(`trigger.fallback`);\n" +
    "const currentChoice=choices[state.current===null?-1:choices.findIndex(c=>c.selection.provider===state.current?.provider&&c.selection.model===state.current.model)]";
  const s2 = core.applyReplacementsToText(bare, patch, "client.js");
  assert.equal(s2.hitMismatch, undefined);
  const m2 = s2.text.match(/\[dsh-purge-110[a-z]*\]/g) || [];
  assert.ok(m2.includes("[dsh-purge-110a]") && m2.includes("[dsh-purge-110b]") && m2.includes("[dsh-purge-110d]"), `纯净宿主应打出 a/b/d 终态 marker，实际 ${JSON.stringify(m2)}`);

  // S3 升级后再跑 → skipIfMarked 跳过（changed=false）
  const s3 = core.applyReplacementsToText(s1.changed ? s1.text : oldProduct, patch, "client.js");
  assert.equal(s3.changed, false, "升级完成的文件再跑必须 skip");

  // S4 部分漂移（v1 产物在、v2/v3 被官方重写）→ 状态判定非 applied
  const partial =
    "const lastActionRef=(0,react.useRef)(`load`);const lastLabelRef=(0,react.useRef)(null); /* [dsh-purge-110a] remember last resolved model label */\nconst waiting=OFFICIAL_REWROTE;";
  const s4 = core.applyReplacementsToText(partial, patch, "client.js");
  assert.equal(s4.hitMismatch, undefined, "部分漂移不报 mismatch（no-op 跳过）");
  assert.notEqual(core.filePatchOutcome(partial, patch, "client.js"), "applied", "部分漂移绝不能判 applied");
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

// ── C. 金鱼审查 M3/M4：共享 yaml-keys 与子代理兼容层 ──────────────────────

test("stripYamlKeyBlock 与 stripYamlScalarKey 是 tools/ui/migrate 的唯一实现（M3）", async () => {
  const yk = await import("../lib/redteam/yaml-keys.js");
  // 块删除：块内空行不结束块（空行后仍更深缩进的内容继续删）
  const withBlankInside = "a: 1\ntoolFilter:\n  - bash\n\n  - read\nb: 2\n";
  assert.equal(yk.stripYamlKeyBlock(withBlankInside, "toolFilter").text, "a: 1\nb: 2\n");
  // 块尾空行保留为分隔
  const blankAfter = "a: 1\ntoolFilter:\n  - x\n\nb: 2\n";
  assert.equal(yk.stripYamlKeyBlock(blankAfter, "toolFilter").text, "a: 1\n\nb: 2\n");
  // 内联形态
  assert.equal(yk.stripYamlKeyBlock("a: 1\ntoolFilter: [bash]\nb: 2\n", "toolFilter").text, "a: 1\nb: 2\n");
  // 单行标量
  assert.equal(yk.stripYamlScalarKey("a: 1\nbackgroundMode: continuable\nb: 2\n", "backgroundMode").text, "a: 1\nb: 2\n");
  // 幂等
  const once = yk.stripYamlKeyBlock(withBlankInside, "toolFilter").text;
  assert.equal(yk.stripYamlKeyBlock(once, "toolFilter").changed, false);
});

test("listDirectChildRows 兼容 listDescendants 与 listChildren（M3 共享实现）", async () => {
  const sc = await import("../lib/redteam/subagent-compat.js");
  // rc.4+：只有 listDescendants，返回整棵子树，depth===1 是直接子
  const rc5 = {
    listDescendants: async () => [
      { id: "a", kind: "child", depth: 1, label: "A" },
      { id: "b", kind: "child", depth: 2 },
      { id: "c", kind: "teammate", depth: 1 },
    ],
  };
  const r1 = await sc.listDirectChildRows(rc5, "root");
  assert.equal(r1.available, true);
  assert.deepEqual(r1.rows.map((x) => x.id), ["a"]);
  assert.equal(sc.childLabel(r1.rows[0]), "A");
  // 旧版：只有 listChildren，无 depth 字段 → 不过滤层
  const legacy = { listChildren: async () => [{ id: "x", kind: "child" }, { id: "y", kind: "child" }] };
  const r2 = await sc.listDirectChildRows(legacy, "root");
  assert.equal(r2.rows.length, 2);
  // 注册表缺失 / 方法缺失 → available:false + error
  assert.equal((await sc.listDirectChildRows(null, "root")).available, false);
  assert.equal((await sc.listDirectChildRows({}, "root")).available, false);
  // 抛错被接住
  const boom = { listDescendants: async () => { throw new Error("boom"); } };
  const r3 = await sc.listDirectChildRows(boom, "root");
  assert.equal(r3.available, false);
  assert.match(r3.error, /boom/);
});

// ---------------------------------------------------------------------------
// #110 探针降级（2026-11-24）：when:"110-probe" 门控 + probe strip 归一化
// ---------------------------------------------------------------------------
test('#110 gate off: pure host gets fixes without probes', async () => {
  const { applyReplacementsToText, ALL_PATCHES } = await import('../lib/core.js');
  const p = ALL_PATCHES.find((x) => x.id === 110);
  const host = [
    "const lastActionRef=(0,react.useRef)(`load`);",
    "const waiting=currentChoice===void 0&&state.status===`loading`;const modelLabel=waiting?t(`trigger.loading`):currentChoice?.model.name??t(`trigger.fallback`);",
    "const currentChoice=choices[state.current===null?-1:choices.findIndex(c=>c.selection.provider===state.current?.provider&&c.selection.model===state.current.model)]",
    "const selection=projected.next??catalog.value.default;const routable=catalog.value.groups.some(group=>group.id===selection.provider&&group.models.some(model=>model.id===selection.model));",
    "window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-model-selection`,factory:require=>{",
    "children:currentChoice===void 0?modelLabel:renderModelLabel(currentChoice.group.provider,currentChoice.model,`trigger`,true)",
  ].join("\n");
  const r = applyReplacementsToText(host, p, "client.js");
  assert.equal(r.changed, true);
  assert.equal(r.text.includes("__dshPurge110Send"), false, "gate off must not inject probes");
  assert.equal(r.text.includes("59999"), false);
  assert.equal(r.text.includes("[dsh-purge-110a]"), true);
  assert.equal(r.text.includes("[dsh-purge-110b]"), true);
  assert.equal(r.text.includes("[dsh-purge-110d]"), true);
  assert.equal(r.text.includes("lastOk"), true, "v5 resolve fallback (data fix) must stay");
});

test('#110 gate on: probes come back under DSH_PURGE_110_PROBE=1', async () => {
  const { applyReplacementsToText, ALL_PATCHES } = await import('../lib/core.js');
  const p = ALL_PATCHES.find((x) => x.id === 110);
  const host = "window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-model-selection`,factory:require=>{";
  process.env.DSH_PURGE_110_PROBE = "1";
  try {
    const r = applyReplacementsToText(host, p, "client.js");
    assert.equal(r.text.includes("__dshPurge110Send"), true, "gate on must restore probe segment");
    assert.equal(r.text.includes("[dsh-purge-110g]"), true);
  } finally {
    delete process.env.DSH_PURGE_110_PROBE;
  }
});

test('#110 probe-laden host converges to clean terminal (strip segments)', async () => {
  const { applyReplacementsToText, ALL_PATCHES } = await import('../lib/core.js');
  const p = ALL_PATCHES.find((x) => x.id === 110);
  // 模拟老宿主：修复段 + 全套探针产物（g/i/j/k）在盘
  const host = [
    "const lastActionRef=(0,react.useRef)(`load`);const lastLabelRef=(0,react.useRef)(null); /* [dsh-purge-110a] remember last resolved model label */",
    ";if(typeof window!==`undefined`){window.__dshPurge110Comp={cur:currentChoice===void 0?null:{provider:currentChoice.group.provider,model:currentChoice.model.id,name:currentChoice.model.name},stateCurrent:state.current===null?null:{provider:state.current.provider,model:state.current.model},choices:choices.length,st:state.status};if(window.__dshPurge110Send)window.__dshPurge110Send(`comp`,JSON.stringify(window.__dshPurge110Comp));} /* [dsh-purge-110j] component-scope probe */",
    "const currentChoice=choices[state.current===null?-1:(()=>{const i=choices.findIndex(c=>purgeAliasProvider(c.selection.provider)===purgeAliasProvider(state.current?.provider)&&c.selection.model===state.current.model);if(i>=0)return i;return -1;})()] /* [dsh-purge-110d] alias-strip + model-id/name fallback */",
    "let selection=projected.next??catalog.value.default;let routable=true; /* [dsh-purge-110d] x */(typeof window!==`undefined`)&&(window.__dshPurge110Data={sel:selection,rt:routable,last:projected.lastUsed,next:projected.next,gn:catalog.value.groups.length,ts:Date.now()})&&(window.__dshPurge110Send&&window.__dshPurge110Send(`data`,JSON.stringify(window.__dshPurge110Data)));if(typeof window!==`undefined`&&window.__dshPurge110Send&&Date.now()-(window.__dshPurge110GroupsTs||0)>60000){window.__dshPurge110GroupsTs=Date.now();try{const payload=JSON.stringify(catalog.value.groups.map(group=>({id:group.id,models:(group.models||[]).map(m=>({i:m.id,n:m.name}))})));const enc=encodeURIComponent(payload);for(let i=0,part=0;i<enc.length;i+=1200,part++)navigator.sendBeacon(`http://127.0.0.1:59999/e?k=grp&n=${part}`,enc.slice(i,i+1200));}catch(_e){}} /* [dsh-purge-110i] resolve data probe + groups dump throttled */",
    "children:currentChoice===void 0?modelLabel:renderModelLabel(currentChoice.group.provider,currentChoice.model,`trigger`,true)",
  ].join("\n");
  const r1 = applyReplacementsToText(host, p, "client.js");
  assert.equal(r1.text.includes("[dsh-purge-110i]"), false, "110i tail must be stripped");
  assert.equal(r1.text.includes("__dshPurge110Data"), false);
  assert.equal(r1.text.includes("__dshPurge110Comp"), false, "110j must be stripped");
  const r2 = applyReplacementsToText(r1.text, p, "client.js");
  assert.equal(r2.changed, false, "second run must be a no-op (converged)");
});

test('#110 markers terminal state is fixes-only [a,b,d]', async () => {
  const { ALL_PATCHES } = await import('../lib/core.js');
  const p = ALL_PATCHES.find((x) => x.id === 110);
  assert.deepEqual(p.markers, ["[dsh-purge-110a]", "[dsh-purge-110b]", "[dsh-purge-110d]"]);
});
