// 一屏自检（吸收自 kingcharleslzy-ai/dsh-purge Community 的 selfcheck 层思路）。
// 只读不改：把「插件现在到底接没接好」压成几行 —— 注入文件、备份、desktop
// 接入（symlink）、shim、锚点覆盖、探针、Qoder。每行 { key, ok, warn, label, detail }。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import { loadAnchorOverrides } from "./anchor-doctor.js";
import { probeStatus } from "./probe.js";

const FACTORY_MARKERS = ["<|im_start|>system:", "<project_instructions>", "Little Code Sauce"];

export async function runSelfcheck(options = {}) {
  const state = options.state ?? {};
  const dshHome = options.dshHome ?? state.dsh_home ?? core.findDshHome();
  const repoRoot = options.repoRoot ?? path.resolve(fileURLToPath(import.meta.url), "../..");
  const rows = [];
  const add = (key, ok, warn, label, detail = "") => rows.push({ key, ok, warn, label, detail });

  // 1 注入文件：存在 + 出厂标记计数（标记在 = 托管正文还没打上）
  const injectPath = state.override_path ?? path.join(dshHome, "prompt-inject.md");
  let injectText = null;
  try {
    injectText = fs.readFileSync(injectPath, "utf8");
  } catch {
    /* 还没有 */
  }
  if (injectText == null) {
    add("inject", false, true, "注入文件", `${injectPath} 不存在（--apply 会创建）`);
  } else {
    const marks = FACTORY_MARKERS.filter((m) => injectText.includes(m)).length;
    const hasProbe = injectText.includes("dsh-purge:probe-begin");
    add(
      "inject",
      marks === 0,
      marks > 0,
      "注入文件",
      marks === 0 ? `已清洗${hasProbe ? "（含探针）" : ""} ${injectPath}` : `出厂默认未应用（标记 ${marks}/3）`,
    );
  }

  // 2 备份：.dshpurge.bak（--revert 的还原点）
  let backup = state.has_backup;
  if (backup == null && state.ai_base) {
    try {
      backup = await core.hasBackup(state.ai_base);
    } catch {
      backup = null;
    }
  }
  if (backup == null) {
    // 没有宿主信息也意味着「没有还原点」：--revert 无处可退，照样告警
    add("backup", false, true, "备份", "无备份（--revert 没有还原点）");
  } else add("backup", !!backup, !backup, "备份", backup ? ".dshpurge.bak 在" : "无备份（--revert 没有还原点）");

  // 3 desktop 接入：profiles/desktop/node_modules/dsh-purge 应指向本仓库
  const link = path.join(dshHome, "profiles", "desktop", "node_modules", "dsh-purge");
  let linkOk = false;
  let linkDetail;
  try {
    const real = fs.realpathSync(link);
    linkOk = path.resolve(real).toLowerCase() === path.resolve(repoRoot).toLowerCase();
    linkDetail = `${link} → ${real}`;
  } catch {
    linkDetail = `${link} 缺失（桌面版没用上本仓库）`;
  }
  add("symlink", linkOk, !linkOk, "desktop 接入", linkDetail);

  // 4 shim：patched/already_patched 好，missing 两个以上算失联
  const shims = [
    ["dsh.cmd", state.shim_cmd],
    ["dsh.ps1", state.shim_ps1],
    ["dsh", state.shim_bin],
  ];
  const missing = shims.filter(([, v]) => v === "missing");
  add(
    "shim",
    missing.length < 2,
    missing.length >= 2,
    "shim",
    shims.map(([k, v]) => `${k}=${v ?? "?"}`).join("  ") + (missing.length >= 2 ? `（${missing.length} 个缺失）` : ""),
  );

  // 5 锚点覆盖（信息项）
  let anchorCount = 0;
  try {
    const { overrides } = loadAnchorOverrides(dshHome);
    anchorCount = Object.values(overrides).reduce((n, m) => n + Object.keys(m ?? {}).length, 0);
  } catch {
    /* 读不了当 0 */
  }
  add("anchors", true, false, "锚点覆盖", anchorCount > 0 ? `${anchorCount} 条生效（dsh-purge-anchors.json）` : "无");

  // 6 探针（信息项）
  let probeDetail = "无";
  try {
    const s = probeStatus(dshHome);
    probeDetail = s.active ? `活跃 ${s.state.token}` : s.live ? "文件里有块但 state 对不上（--probe --status）" : "无";
  } catch {
    /* 忽略 */
  }
  add("probe", true, false, "运行时探针", probeDetail);

  // 7 Qoder（信息项，装没装都不算坏）
  const qdir = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Qoder CN", ".qoder-versions");
  let qDetail = "未检测到";
  try {
    const vs = fs.readdirSync(qdir).filter((d) => /^\d/.test(d));
    if (vs.length) qDetail = vs.join(", ");
  } catch {
    /* 没装 */
  }
  add("qoder", true, false, "Qoder", qDetail);

  return { rows, warnCount: rows.filter((r) => r.warn).length };
}

export function formatSelfcheck(sc) {
  const lines = ["自检 / selfcheck"];
  for (const r of sc.rows) {
    const mark = r.warn ? "⚠" : "✓";
    lines.push(`  ${mark} ${r.label} — ${r.detail}`);
  }
  if (sc.warnCount > 0) lines.push(`  ${sc.warnCount} 项需要关注（⚠ 不影响已生效补丁）`);
  return lines.join("\n");
}
