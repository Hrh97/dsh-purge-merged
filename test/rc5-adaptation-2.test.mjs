// rc.5 适配回归 · 第二批（2026-11-24 晚）：宿主分区判定 + rc.5 压缩版锚点。
//
// 背景（第一批之后又挖出来的两个洞）：
//
//   A. 补丁门控按「当前进程」判区，而不是按「被清洗的宿主」判区。
//      CLI 在普通 node 下跑时 detectSurface() 恒判 web，而 findAiBase() 现在会把
//      桌面客户端正在跑的那份桌面宿主选出来。于是 11 条 desktop-only 补丁
//      （#45/#46/#82/#83/#84/#92/#93/#100/#103/#108/#109）在状态页全被判 na，
//      看着像「桌面补丁一条都没打上」，其实它们都写在桌面壳 main.js 里。
//      修法：surfaceForAiBase(aiBase) 按宿主路径落在不在桌面安装树内来判区，
//      门控点（patchStatus / applyPatches / groupPatchesForDisplay / gatherState /
//      anchor-doctor / patchesTouching）统一走它。
//
//   B. rc.5 的前端产物是压缩单行。#56/#77（rewind 两件套）原有多行锚点全部失配，
//      功能随官方升级静默失效（回退后被撤掉的轮次还留在聊天里）。
//      修法：吸收 ZXEB/dsh-purge v1.1.76 的 0.2.2+ 压缩版锚点。
//      另：#103 的 welcome cookie 清扫，rc.5 官方自己实现了（removeLegacyHostCookies），
//      锚点被改写 → 按 #94/#95 的既有做法改成 markersAny + softSettle。
//
// 断言不依赖本机宿主：合成夹具 + 纯函数 + 真实宿主文件内容（只读）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── A. 宿主分区判定 ────────────────────────────────────────────────────────

test("surfaceForAiBase 按宿主路径判区，不看当前进程", async () => {
  const core = await import("../lib/core.js");
  assert.equal(typeof core.surfaceForAiBase, "function");

  // 桌面安装树：路径尾部是 app.asar / resources/app 形态 → desktop
  const desktopBase = "D:/Program Files/DSH/resources/app/dsh/node_modules/@deepseek-ai";
  // 普通 web 副本 → 沿用当前进程（本测试跑在 node 下 = web）
  const webBase = "D:/hrh/dsh/node_modules/@deepseek-ai";

  assert.equal(core.surfaceForAiBase(desktopBase), "desktop", "桌面安装树内的宿主应判 desktop");
  assert.notEqual(core.surfaceForAiBase(webBase), "desktop", "普通 web 副本不该判 desktop");
  // 空值退回当前进程判定，不抛异常
  assert.ok(typeof core.surfaceForAiBase("") === "string");
  assert.ok(typeof core.surfaceForAiBase(null) === "string");
});

test("patchAppliesHere 显式传 surface 时按传入值判，不再被当前进程覆盖", async () => {
  const core = await import("../lib/core.js");
  const desktopOnly = core.ALL_PATCHES.find((p) => p.id === 108);
  assert.ok(desktopOnly, "#108 应存在");
  assert.deepEqual(desktopOnly.surfaces, ["desktop"]);

  assert.equal(core.patchAppliesHere(desktopOnly, "desktop"), true, "桌面宿主应适用 desktop-only 补丁");
  assert.equal(core.patchAppliesHere(desktopOnly, "web"), false, "web 面不该适用 desktop-only 补丁");
});

test("groupPatchesForDisplay 传 surface 后会把 desktop-only 补丁计入", async () => {
  const core = await import("../lib/core.js");
  const status = {};
  for (const p of core.ALL_PATCHES) status[p.id] = "applied";

  const webRows = core.groupPatchesForDisplay(core.ALL_PATCHES, status, "web");
  const desktopRows = core.groupPatchesForDisplay(core.ALL_PATCHES, status, "desktop");

  const has108 = (rows) => rows.some((r) => r.ids.includes(108));
  assert.equal(has108(webRows), false, "web 面不该出现 #108");
  assert.equal(has108(desktopRows), true, "桌面面必须出现 #108");
  assert.ok(desktopRows.length > webRows.length, "桌面面可展示的补丁条数应多于 web 面");
});

test("patchStatus 对桌面宿主不再把 desktop-only 补丁判 na", async () => {
  const core = await import("../lib/core.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-rc5-surface-"));
  // 造一个「桌面安装树」形态的宿主：<root>/resources/app/dsh/node_modules/@deepseek-ai
  // isInsideDesktopInstall 的判据之一是「推断出的安装目录旁边真有官方 exe」，
  // 所以夹具里要放一个 DeepSeek Harness.exe。
  const install = path.join(root, "resources");
  const aiBase = path.join(install, "app", "dsh", "node_modules", "@deepseek-ai");
  fs.writeFileSync(path.join(root, "DeepSeek Harness.exe"), "MZ", "utf8");
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.mkdirSync(path.join(aiBase, "dsh"), { recursive: true });
  fs.writeFileSync(
    path.join(aiBase, "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }),
    "utf8",
  );

  try {
    const { isInsideDesktopInstall } = await import("../lib/desktop.js");
    assert.equal(
      isInsideDesktopInstall(aiBase),
      true,
      "夹具应被认成桌面安装树内的宿主",
    );

    // 只跑一条 desktop-only 补丁（#108），文件键 desktop-shell 在这个夹具里不存在，
    // 所以状态不会是 na —— 只要不是 na 就说明门控放行了。
    const status = await core.patchStatus(aiBase, [core.ALL_PATCHES.find((p) => p.id === 108)]);
    assert.notEqual(status[108], "na", "桌面宿主上的 desktop-only 补丁不应被判 na");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── B. rc.5 压缩版锚点 ─────────────────────────────────────────────────────

const RC5_CLIENT_ANCHORS = {
  56: ["var ConversationNodeAssembler=class{", "replaceWindow(entries,hasMore){this.contexts.clear();"],
  77: ["append(record){const event=record.event;if(this.inputs.has(event.seq))return`none`;if(this.revised.size>0)this.revised.clear();this.inputs.set(event.seq,record);"],
};

test("#56/#77 带 0.2.2+ 压缩版锚点（rc.5 单行产物）", async () => {
  const core = await import("../lib/core.js");
  for (const id of [56, 77]) {
    const p = core.ALL_PATCHES.find((x) => x.id === id);
    assert.ok(p, `#${id} 应存在`);
    const patterns = (p.replacements ?? []).map((r) => r.pattern);
    for (const anchor of RC5_CLIENT_ANCHORS[id]) {
      assert.ok(
        patterns.some((pat) => typeof pat === "string" && pat.includes(anchor)),
        `#${id} 缺压缩版锚点：${anchor.slice(0, 60)}`,
      );
    }
  }
});

test("#56/#77 的压缩版锚点在 rc.5 真实文件上能落地且产物语法合法", async () => {
  const core = await import("../lib/core.js");
  // 用与 rc.5 同构的压缩片段当夹具（不依赖本机是否装了 rc.5）
  const compressed =
    "function foo(){return 1}" +
    "var ConversationNodeAssembler=class{constructor(){this.x=1}};" +
    "replaceWindow(entries,hasMore){this.contexts.clear();this.contextsByKind.clear();}" +
    "append(record){const event=record.event;if(this.inputs.has(event.seq))return`none`;if(this.revised.size>0)this.revised.clear();this.inputs.set(event.seq,record);" +
    "let publication=`none`;return publication}";

  for (const id of [56, 77]) {
    const p = core.ALL_PATCHES.find((x) => x.id === id);
    const r = core.applyReplacementsToText(compressed, p, "client.js");
    assert.equal(r.hitMismatch, undefined, `#${id} 命中数不符：${JSON.stringify(r.hitMismatch)}`);
    assert.equal(r.changed, true, `#${id} 应对压缩版锚点有改动`);
  }
});

test("#103 在 rc.5 由官方自己实现 → markersAny + softSettle，不再判 drifted", async () => {
  const core = await import("../lib/core.js");
  const p = core.ALL_PATCHES.find((x) => x.id === 103);
  assert.ok(p, "#103 应存在");
  assert.equal(p.markersAny, true, "#103 必须 markersAny（官方已自带 removeLegacyHostCookies）");
  assert.equal(p.softSettle, true, "#103 必须 softSettle（锚点形态已变）");
  assert.ok(
    p.markers.some((m) => m.includes("removeLegacyHostCookies")),
    "#103 的 marker 应认官方函数名 removeLegacyHostCookies",
  );

  // 官方形态的产物 → 判 applied（而不是 drifted）
  const officialShaped = "async function removeLegacyHostCookies(cookies, url) { return cookies; }";
  assert.equal(core.filePatchOutcome(officialShaped, p, "main.js"), "applied");
});

// ── C. 巡检脚本补漏的 4 个活跃仓 ────────────────────────────────────────────

test("巡检脚本已收录 4 个 rc.5 适配参考仓", () => {
  const watch = fs.readFileSync("D:/hrh/dsh-watch/watch-upstream.mjs", "utf8");
  for (const repo of [
    "ZXEB/dsh-purge",
    "qiuqianyi66/dsh-purge",
    "CallMeGuLab/dsh-purge-safe",
    "NANA7MI0/dsh-purge-go",
  ]) {
    assert.ok(watch.includes(`repo: "${repo}"`), `巡检脚本缺仓库 ${repo}`);
  }
});
