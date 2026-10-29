// 运行时探针（吸收自 kingcharleslzy-ai/dsh-purge Community 的 probe 思路）。
//
// 往注入文件尾部装一个带唯一 token 的小块，然后跟 dsh 对话让它复述那一行——
// 答得出 token 就证明「写进文件的注入 → 模型真的看到了」整条链路是通的。
// 自愈：正文若仍是出厂默认（含出厂标记），下次 --apply 会整体回写托管正文，
// 探针块随之消失——不会留脏东西；要立刻撤就 --probe --clear。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as core from "./core.js";

export const PROBE_BEGIN = "<!-- dsh-purge:probe-begin -->";
export const PROBE_END = "<!-- dsh-purge:probe-end -->";
export const PROBE_STATE_FILE = "dsh-purge-probe.json";

export function probeStatePath(dshHome = core.findDshHome()) {
  return path.join(dshHome, PROBE_STATE_FILE);
}

export function makeProbeToken() {
  return `DSPROBE-${crypto.randomBytes(4).toString("hex")}`;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function probeBlock(token) {
  return `\n${PROBE_BEGIN}\n- probe: ${token}\n${PROBE_END}\n`;
}

export function findProbeToken(text) {
  const re = new RegExp(`${escapeRe(PROBE_BEGIN)}\\s*\\n- probe: (DSPROBE-[0-9a-f]{8})\\s*\\n${escapeRe(PROBE_END)}`);
  const m = String(text ?? "").match(re);
  return m ? m[1] : null;
}

export function stripProbeBlock(text) {
  const re = new RegExp(`\\n?${escapeRe(PROBE_BEGIN)}[\\s\\S]*?${escapeRe(PROBE_END)}\\n?`, "g");
  return String(text ?? "").replace(re, "");
}

// 探针是磁盘级验证，必须直读原始文件字节。
// readPromptInjectFileSync 走 normalizeOverride/托管正文路径，返回的不是磁盘现状
// （实测同一文件：磁盘原文 21193 字符 vs 托管读取 20968 字符），token 会被吃掉。
function readRawInject(dshHome) {
  const fp = core.findOverrideFile(dshHome) ?? path.join(dshHome, "prompt-inject.md");
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

export async function armProbe(dshHome = core.findDshHome()) {
  const text = readRawInject(dshHome);
  if (!text.trim()) {
    // 直读磁盘：文件不存在/为空就拒绝——没被 --apply 注入过的宿主装探针没有意义。
    throw new Error("注入文件为空或不存在（先跑 --apply）");
  }
  const token = makeProbeToken();
  const next = stripProbeBlock(text).replace(/\s*$/, "") + probeBlock(token);
  await core.saveOverrideContent(dshHome, next);
  const state = { token, armedAt: new Date().toISOString() };
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(probeStatePath(dshHome), JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

export async function clearProbe(dshHome = core.findDshHome()) {
  const text = readRawInject(dshHome);
  const had = findProbeToken(text) != null;
  const next = stripProbeBlock(text);
  if (next !== text) {
    // 直写磁盘：saveOverrideContent 会经 normalize/托管路径重写正文，
    // 与探针的「磁盘级」语义不符。
    const fp = core.findOverrideFile(dshHome) ?? path.join(dshHome, "prompt-inject.md");
    fs.writeFileSync(fp, next, "utf8");
  }
  try {
    fs.unlinkSync(probeStatePath(dshHome));
  } catch {
    /* 本来就没有 */
  }
  return { cleared: had || next !== text };
}

export function probeStatus(dshHome = core.findDshHome()) {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(probeStatePath(dshHome), "utf8"));
  } catch {
    /* 无 state */
  }
  const text = readRawInject(dshHome);
  const live = findProbeToken(text);
  return { state, live, active: !!(state?.token && live === state.token) };
}
