// 预设依赖体检：presets/**/*.cordis.yml 里每个 `@deepseek-ai/*` 声明，
// 要么能在宿主里 resolve 到，要么显式 `disabled: true`。
//
// 为什么要有这个：0.2.2 把 `dsh-tool-subagent-control/list-agents` 子路径并进主包，
// 但红队预设里那一行是 `disabled: false`，cordis 注册了它却永远起不来 →
// 整个预设被判 broken，模式下拉里直接「加载失败」。上游合包/删包会重演同类事故，
// 所以把它变成一条可以在 CI 里跑的静态断言，而不是等用户看到「加载失败」再查。
//
// 用法：
//   node scripts/check-preset-plugins.mjs            有宿主就核对，没宿主只做结构断言
//   node scripts/check-preset-plugins.mjs --host DIR 指定宿主根（默认自动探测）
//   node scripts/check-preset-plugins.mjs --json     机器可读
//
// 退出码：0 = 全部 OK（或没有宿主可核对）；1 = 有声明既不可解析也没 disabled。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PRESET_DIR = path.join(REPO, "presets");

/** 从 YAML 文本里按缩进解析出 [{ id, name, disabled }]（只认我们关心的三个键）。 */
export function parsePresetEntries(text) {
  const entries = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const row = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line);
    if (row) {
      cur = { id: row[2], indent: row[1].length, name: "", disabled: null };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const indent = (/^(\s*)/.exec(line) || ["", ""])[1].length;
    if (line.trim() && indent <= cur.indent && !/^\s*#/.test(line)) {
      cur = null;
      continue;
    }
    const name = /^\s*name:\s*'?([^'\s#]+)'?/.exec(line);
    if (name && !cur.name) cur.name = name[1];
    const off = /^\s*disabled:\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (off) cur.disabled = off[1] === "true";
  }
  return entries.filter((e) => e.name);
}

export function collectPresetFiles(root = PRESET_DIR) {
  const out = [];
  const walk = (dir) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.cordis\.ya?ml$|^preset\.ya?ml$/.test(e.name)) out.push(fp);
    }
  };
  walk(root);
  return out.sort();
}

/** 找一个能把 @deepseek-ai/* 解出来的宿主根；找不到返回 ""（CI 里没有宿主是正常情况）。 */
export function detectHostRoot(explicit = "") {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DSH_HOST_ROOT) candidates.push(process.env.DSH_HOST_ROOT);
  candidates.push(
    "D:/Program Files/DSH/resources/app/dsh",
    "C:/Program Files/DSH/resources/app/dsh",
    "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh",
    "/usr/lib/deepseek-harness/app/dsh",
  );
  for (const c of candidates) {
    if (!c) continue;
    const pkg = path.join(c, "package.json");
    const ai = path.join(c, "node_modules", "@deepseek-ai");
    if (fs.existsSync(pkg) && fs.existsSync(ai)) return c;
  }
  return "";
}

function makeResolver(hostRoot) {
  const req = createRequire(path.join(hostRoot, "package.json"));
  return (name) => {
    try {
      req.resolve(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e?.code || "ERR", message: String(e?.message || e) };
    }
  };
}

/**
 * 体检。hostRoot 为空时只做结构断言（每行必须有 name）。
 * 返回 { ok, hostRoot, files, entries, problems }。
 */
export function checkPresets(options = {}) {
  const hostRoot = options.hostRoot === undefined ? detectHostRoot() : options.hostRoot;
  const files = collectPresetFiles(options.root ?? PRESET_DIR);
  const resolve = hostRoot ? makeResolver(hostRoot) : null;
  const entries = [];
  const problems = [];
  for (const fp of files) {
    const text = fs.readFileSync(fp, "utf8");
    for (const e of parsePresetEntries(text)) {
      const row = { file: path.relative(REPO, fp), ...e, resolvable: null };
      // 只对宿主包做 resolve 断言：本地脚本（./anchor-gate.mjs）、cordis 内置名
      // （cordis:group）、插件自有子路径（dsh-purge/redteam/tools）都不该由宿主解析。
      if (resolve && e.name.startsWith("@deepseek-ai/")) {
        const r = resolve(e.name);
        row.resolvable = r.ok;
        if (!r.ok && e.disabled !== true) {
          problems.push({
            file: row.file,
            id: e.id,
            name: e.name,
            reason: `unresolvable and not disabled (${r.code})`,
          });
        }
      }
      entries.push(row);
    }
  }
  return { ok: problems.length === 0, hostRoot, files: files.map((f) => path.relative(REPO, f)), entries, problems };
}

function main(argv) {
  const json = argv.includes("--json");
  const hostIdx = argv.indexOf("--host");
  const hostRoot = hostIdx >= 0 ? argv[hostIdx + 1] : undefined;
  const rep = checkPresets({ hostRoot });

  if (json) {
    console.log(JSON.stringify(rep, null, 2));
    process.exitCode = rep.ok ? 0 : 1;
    return;
  }

  const declared = new Set(rep.entries.map((e) => e.name));
  console.log(`预设依赖体检 / preset plugin check`);
  console.log(`  宿主 / host      ${rep.hostRoot || "(未探测到，只做结构断言 / no host)"}`);
  console.log(`  预设文件 / files ${rep.files.length}`);
  console.log(`  包声明 / names   ${declared.size}`);
  if (!rep.hostRoot) {
    console.log(`  · 没有宿主可核对，跳过 resolve 断言（CI 正常情况）`);
    return;
  }
  const unresolvable = rep.entries.filter((e) => e.resolvable === false);
  console.log(`  不可解析 / unresolvable ${unresolvable.length}（其中显式 disabled ${unresolvable.filter((e) => e.disabled === true).length}）`);
  for (const e of unresolvable) {
    const tag = e.disabled === true ? "· disabled" : "✗";
    console.log(`    ${tag} ${e.name}  (${e.file}#${e.id})`);
  }
  for (const p of rep.problems) console.log(`  ✗ ${p.name} @ ${p.file}#${p.id} — ${p.reason}`);
  if (rep.problems.length) {
    console.log("  说明：这些声明会让整份预设判 broken。要么删掉，要么显式 `disabled: true`。");
    process.exitCode = 1;
  } else {
    console.log("  全部 OK / all clear");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
