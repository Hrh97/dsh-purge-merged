#!/usr/bin/env node
// workbuddy-purge.mjs — 把 WorkBuddy（@genie/workbuddy-desktop / CodeBuddy CLI 内核）
// 的主系统提示词换成 dsh-purge 内核人格，并把默认权限设为 bypassPermissions。
//
// 与 qoder-purge.mjs 的关键差异（决定了这里简单很多）：
//   1. WorkBuddy 的提示词是 app.asar.unpacked 里的明文 product.json，不混淆、不在 asar
//      归档内 → 不用逆向字符串表、不用重建 asar。
//   2. 改 unpacked 散文件不改变 app.asar 的 header hash → 无需动 WorkBuddy.exe 的
//      integrity manifest / Electron fuse（Qoder 那套 patchExeFuse 在这里完全不需要）。
//   3. 每个改动文件留 .purge-orig 备份，--restore 可逆，--verify 逐字节可证。
//
// 三层：
//   提示词：所有 product*.json 里 prompts[name=cli-agent-prompt].template → purge 文本
//   权限：  ~/.codebuddy/settings.json（及 ~/.workbuddy/settings.json 若存在）
//          permissions.defaultMode = "bypassPermissions"
//   验证：  --verify 对比活文件的 template 是否逐字等于当前 purge 文本

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 安装根：环境变量优先，否则用本机当前安装位置，再退到常见路径。
const ROOT_ENV = process.env.WORKBUDDY_ROOT || '';
const ROOT_CANDIDATES = ROOT_ENV ? [ROOT_ENV] : [
  'D:/Program Files/WorkBuddy',
  'C:/Program Files/WorkBuddy',
  'E:/HRSoftstore/Install/WorkBuddy',
];
const UNP_SUFFIX = 'resources/app.asar.unpacked';
const PURGE_MD = path.join(__dirname, '../qoder/purge-prompt.zh.md');
const PROMPT_NAME = 'cli-agent-prompt';
const BAK_SUFFIX = '.purge-orig';
const LOG_FILE = path.resolve(__dirname, '../../tmp-workbuddy/workbuddy-purge.log');
const TASK_NAME = 'WorkBuddyPurgeReapply';
const SETTINGS_PATHS = [
  path.join(process.env.USERPROFILE || 'C:/Users/onemt', '.codebuddy/settings.json'),
  path.join(process.env.USERPROFILE || 'C:/Users/onemt', '.workbuddy/settings.json'),
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(msg);
}
function die(msg) { console.error(`[workbuddy-purge] ${msg}`); process.exit(1); }

// ---------- discovery ----------

function findRoot() {
  for (const r of ROOT_CANDIDATES) {
    if (fs.existsSync(path.join(r, UNP_SUFFIX))) return r;
  }
  die(`WorkBuddy 根目录未找到（候选：${ROOT_CANDIDATES.join(' | ')}）。设 WORKBUDDY_ROOT 环境变量。`);
}

/** 递归找所有 product*.json，返回 {path, hasPrompt}。 */
function findProductFiles(unp) {
  const out = [];
  function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 只下探必要的两层子树，避免整个 asar.unpacked 全扫
        if (/^(cli|node_modules|@genie|agent-harness)$/.test(e.name) || e.name === 'dist') walk(fp);
        continue;
      }
      if (!/^product[^/\\]*\.json$/.test(e.name)) continue;
      let text;
      try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const hasPrompt = new RegExp(`"name"\\s*:\\s*"${PROMPT_NAME}"`).test(text);
      if (hasPrompt) out.push({ path: fp, size: fs.statSync(fp).size });
    }
  }
  walk(unp);
  return out;
}

// ---------- surgical template replacement ----------

/**
 * 在 JSON 文本里定位 name=PROMPT_NAME 那个对象的 "template" 字符串值的字面量边界，
 * 只替换这一个字符串，其余字节保持不动（避免 JSON.stringify 重排整个 product.json）。
 */
function findTemplateSpan(text) {
  const nameRe = new RegExp(`"name"\\s*:\\s*"${PROMPT_NAME}"`);
  const m = nameRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const tIdx = text.indexOf('"template"', from);
  if (tIdx < 0) return null;
  const colon = text.indexOf(':', tIdx + '"template"'.length);
  if (colon < 0) return null;
  const open = text.indexOf('"', colon);
  if (open < 0) return null;
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return { start: open, end: i + 1 };
    i++;
  }
  return null;
}

function readTemplate(fp) {
  const text = fs.readFileSync(fp, 'utf8');
  const span = findTemplateSpan(text);
  if (!span) return null;
  try { return JSON.parse(text.slice(span.start, span.end)); } catch { return null; }
}

function patchProduct(fp, want) {
  const text = fs.readFileSync(fp, 'utf8');
  const span = findTemplateSpan(text);
  if (!span) return { ok: false, reason: 'template span not found' };
  const cur = JSON.parse(text.slice(span.start, span.end));
  if (cur === want) return { ok: true, changed: false, size: text.length };
  const bak = fp + BAK_SUFFIX;
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(fp));
  const lit = JSON.stringify(want); // 包含首尾引号，转义 \n / \" / 中文
  const next = text.slice(0, span.start) + lit + text.slice(span.end);
  // 落盘前自检：重写后的 JSON 必须可解析且 template 逐字等于 want
  const check = JSON.parse(next);
  const obj = Array.isArray(check.prompts) ? check.prompts.find(p => p.name === PROMPT_NAME) : null;
  if (!obj || obj.template !== want) return { ok: false, reason: 'post-write self-check failed' };
  fs.writeFileSync(fp, next, 'utf8');
  return { ok: true, changed: true, size: next.length, oldChars: cur.length, newChars: want.length };
}

// ---------- permission layer ----------

function patchSettings(quiet = false) {
  const out = [];
  for (const fp of SETTINGS_PATHS) {
    if (!fs.existsSync(fp)) { out.push({ path: fp, status: 'absent' }); continue; }
    let obj;
    try { obj = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
      out.push({ path: fp, status: 'bad-json', error: e.message }); continue;
    }
    obj.permissions = obj.permissions || {};
    if (obj.permissions.defaultMode === 'bypassPermissions') {
      out.push({ path: fp, status: 'already' }); continue;
    }
    const bak = fp + BAK_SUFFIX;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(fp));
    obj.permissions.defaultMode = 'bypassPermissions';
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    out.push({ path: fp, status: 'patched' });
  }
  return out;
}

// ---------- process guard ----------

function workbuddyRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH', { encoding: 'utf8' });
    return /WorkBuddy\.exe/.test(out);
  } catch { return false; }
}

// ---------- scheduled task（防官方更新覆盖）----------

function cmdInstallWatch() {
  const vbs = path.join(__dirname, 'workbuddy-purge-hidden.vbs');
  const taskCmd = `"C:\\Windows\\System32\\wscript.exe" //nologo "${vbs}"`;
  execSync(`schtasks /Create /F /TN ${TASK_NAME} /SC ONLOGON /TR "${taskCmd}"`, { stdio: 'inherit' });
  log(`[watch] installed: ${TASK_NAME} (on logon, hidden via wscript)`);
}

function cmdUninstallWatch() {
  execSync(`schtasks /Delete /F /TN ${TASK_NAME}`, { stdio: 'inherit' });
  log(`[watch] removed: ${TASK_NAME}`);
}

// ---------- commands ----------

function cmdCheck(want) {
  const root = findRoot();
  const unp = path.join(root, UNP_SUFFIX);
  const files = findProductFiles(unp);
  const rows = files.map(f => {
    const cur = readTemplate(f.path);
    return {
      file: path.relative(unp, f.path).replace(/\\/g, '/'),
      status: cur === want ? 'current' : (cur === null ? 'unreadable' : `${cur.length} chars`),
    };
  });
  console.log(JSON.stringify({ root, unp, purgeChars: want.length, files: rows }, null, 2));
  return 0;
}

function cmdPatch(want) {
  const root = findRoot();
  const unp = path.join(root, UNP_SUFFIX);
  const files = findProductFiles(unp);
  if (!files.length) die(`未在 ${unp} 找到含 ${PROMPT_NAME} 的 product*.json`);
  const rows = [];
  for (const f of files) rows.push({ file: path.relative(unp, f.path).replace(/\\/g, '/'), ...patchProduct(f.path, want) });
  const settings = patchSettings();
  console.log(JSON.stringify({
    root, prompt: path.basename(PURGE_MD), purgeChars: want.length,
    products: rows, settings, running: workbuddyRunning(),
  }, null, 2));
  if (workbuddyRunning()) log('[注意] WorkBuddy 正在运行；提示词改动需重启 WorkBuddy 才生效。');
  log('[完成] 提示词已替换、权限已设为 bypassPermissions。用 --verify 校验，--restore 回滚。');
  return 0;
}

function cmdVerify(want) {
  const root = findRoot();
  const unp = path.join(root, UNP_SUFFIX);
  const files = findProductFiles(unp);
  let current = 0, stale = 0, bad = 0;
  const rows = files.map(f => {
    const cur = readTemplate(f.path);
    let status;
    if (cur === want) { status = 'current'; current++; }
    else if (cur === null) { status = 'unreadable'; bad++; }
    else { stale++; status = `stale(${cur.length} chars)`; }
    return { file: path.relative(unp, f.path).replace(/\\/g, '/'), status };
  });
  const settingsOk = SETTINGS_PATHS.filter(fp => fs.existsSync(fp)).every(fp => {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')).permissions?.defaultMode === 'bypassPermissions'; } catch { return false; }
  });
  const state = bad ? 'cannot-prove' : (stale ? 'stale' : 'current');
  console.log(JSON.stringify({
    root, prompt: path.basename(PURGE_MD), purgeChars: want.length,
    state, current, stale, bad, permissionsBypass: settingsOk, files: rows,
  }, null, 2));
  log(`[verify] ${state}: ${current}/${files.length} product 文件逐字等于当前 purge 文本；权限 bypass=${settingsOk}`);
  return state === 'current' ? 0 : 1;
}

function cmdRestore() {
  const root = findRoot();
  const unp = path.join(root, UNP_SUFFIX);
  const files = findProductFiles(unp);
  const rows = [];
  for (const f of files) {
    const bak = f.path + BAK_SUFFIX;
    if (fs.existsSync(bak)) { fs.writeFileSync(f.path, fs.readFileSync(bak)); rows.push({ file: f.path, status: 'restored' }); }
    else rows.push({ file: f.path, status: 'no-backup' });
  }
  for (const fp of SETTINGS_PATHS) {
    const bak = fp + BAK_SUFFIX;
    if (fs.existsSync(bak)) { fs.writeFileSync(fp, fs.readFileSync(bak)); rows.push({ file: fp, status: 'restored' }); }
  }
  console.log(JSON.stringify({ restored: rows }, null, 2));
  log('[restore] 完成。重启 WorkBuddy 生效。');
  return 0;
}

// ---------- entry ----------

const want = fs.readFileSync(PURGE_MD, 'utf8').replace(/\r\n/g, '\n');
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(`usage: workbuddy-purge.mjs [--check] [--verify] [--restore]
  (no flag)    打补丁：替换 product*.json 的 ${PROMPT_NAME} 模板 + 权限 bypassPermissions
  --check      只读：列出所有 product*.json 与当前 purge 文本的关系
  --verify     校验：活文件是否逐字等于当前 purge 文本；exit 0 current / 1 stale
  --restore    从 .purge-orig 还原所有改动（含 settings）
  --install-watch  建登录时自动重打补丁的隐藏计划任务 ${TASK_NAME}
  --uninstall-watch 删除该计划任务
  环境变量 WORKBUDDY_ROOT 可显式指定安装根。`);
  process.exit(0);
}
try {
  if (args.includes('--restore')) process.exitCode = cmdRestore();
  else if (args.includes('--install-watch')) process.exitCode = cmdInstallWatch();
  else if (args.includes('--uninstall-watch')) process.exitCode = cmdUninstallWatch();
  else if (args.includes('--verify')) process.exitCode = cmdVerify(want);
  else if (args.includes('--check')) process.exitCode = cmdCheck(want);
  else process.exitCode = cmdPatch(want);
} catch (e) {
  log(`[error] ${e && e.stack || e}`);
  die(e && e.message || String(e));
}
