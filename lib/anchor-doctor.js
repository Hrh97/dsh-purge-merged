// 锚点漂移诊断 + 本地重锚（吸收自 kingcharleslzy-ai/dsh-purge Community 的 diagnose/reanchor 思路）。
//
// 问题：宿主被官方更新重写后，补丁 pattern 里锚的那几行可能被上游改掉（比如加 ?.
// 可选链、改名），--apply 时 replace 不进去，status 只能给一个含糊的 unmatched。
// 这里做三件事：
//   1. diagnosePatches：逐补丁逐 replacement 判「applied / pending / drifted」，
//      drifted = 原锚点和替换产物都不在 = 上游改版，并给出近似候选行。
//   2. reanchorPatch：把漂移锚点钉成本地覆盖（dsh-purge-anchors.json）——
//      候选行必须在每个目标文件里全文件唯一才收，多宿主候选不一致直接拒。
//   3. applyAnchorOverrides：--apply 前把覆盖套到 ALL_PATCHES 上，fingerprint
//      对不上（上游又改了）自动标 stale 跳过，绝不盲打。
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

export const ANCHOR_STATE_FILE = "dsh-purge-anchors.json";

export function anchorStatePath(dshHome = core.findDshHome()) {
  return path.join(dshHome, ANCHOR_STATE_FILE);
}

/** pattern 的稳定指纹：压空白取前 24 字符，用来识别「上游又改了锚点」。 */
export function fingerprintOf(pattern) {
  return String(pattern ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
}

export function loadAnchorOverrides(dshHome = core.findDshHome()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(anchorStatePath(dshHome), "utf8"));
  } catch {
    /* 首次使用，文件还没有 */
  }
  const overrides =
    raw && typeof raw === "object" && raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {};
  return { overrides, meta: { version: raw.version ?? 1, updatedAt: raw.updatedAt ?? null } };
}

export function saveAnchorOverrides(overrides, dshHome = core.findDshHome(), note = "") {
  const fp = anchorStatePath(dshHome);
  fs.mkdirSync(dshHome, { recursive: true });
  const doc = { version: 1, updatedAt: new Date().toISOString(), note: note || undefined, overrides };
  fs.writeFileSync(fp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return fp;
}

/**
 * 把本地覆盖套到补丁数组上。
 * 覆盖记录：overrides[id][pi] = { from: 原pattern, to: 新pattern, note? }。
 * from 和当前 pattern 对不上 → stale（上游又改了），保持原样让诊断去看。
 */
export function applyAnchorOverrides(patches, overrides) {
  const applied = [];
  const stale = [];
  if (!overrides || typeof overrides !== "object" || Object.keys(overrides).length === 0) {
    return { patches, applied, stale };
  }
  const out = patches.map((p) => {
    const ov = overrides[String(p.id)];
    if (!ov || typeof ov !== "object") return p;
    let touched = false;
    const replacements = (p.replacements ?? []).map((r, i) => {
      const o = ov[String(i)];
      if (!o || typeof o.from !== "string" || typeof o.to !== "string") return r;
      if (r.pattern instanceof RegExp || r.pattern !== o.from) {
        if (!(r.pattern instanceof RegExp) && r.pattern !== o.from) stale.push({ id: p.id, pi: i });
        return r;
      }
      if (o.to === o.from) return r;
      touched = true;
      applied.push({ id: p.id, pi: i });
      return { ...r, pattern: o.to };
    });
    return touched ? { ...p, replacements } : p;
  });
  return { patches: out, applied, stale };
}

/** 段里最长的一行（trim 后），作为定位探针。 */
function longestLine(s) {
  const lines = String(s ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.reduce((a, b) => (b.length > a.length ? b : a), "");
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

/**
 * 在 text 里找 pattern 的下落。
 * - 原样还在 → { exact: true }（没漂移）。
 * - 漂了：拿 pattern 最长行当探针精确搜，搜不到就头尾各截 8 字符渐进缩，
 *   命中行返回 { exact:false, fragment, line, candidateLine }（候选行=整行 trim）。
 * - 完全找不到 → null（改动太大，人工看）。
 */
export function locateCandidate(text, pattern, options = {}) {
  const minLen = options.minLen ?? 16;
  const step = options.step ?? 8;
  if (typeof text !== "string" || typeof pattern !== "string" || !pattern) return null;
  if (text.includes(pattern)) return { exact: true, fragment: pattern };
  const lines = text.split(/\r?\n/);
  const probe0 = longestLine(pattern);
  if (!probe0 || probe0.length < 4) return null;
  const hit = (needle) => {
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return { line: i + 1, text: lines[i] };
    return null;
  };
  const hitOut = (h, fragment) => {
    const candidateLine = h.text.trim();
    return candidateLine ? { exact: false, fragment, line: h.line, candidateLine } : null;
  };
  let probe = probe0;
  for (;;) {
    const h = hit(probe);
    if (h) return hitOut(h, probe);
    if (probe.length <= minLen + step) {
      if (probe.length > minLen) {
        probe = probe.slice(0, minLen);
        const h2 = hit(probe);
        if (h2) return hitOut(h2, probe);
      }
      return null;
    }
    probe = probe.slice(step, probe.length - step);
  }
}

/** patch.file 可能是单键；统一成数组。 */
function fileKeysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

function trimmedLineSet(text) {
  return new Set(text.split(/\r?\n/).map((l) => l.trim()));
}

/**
 * 替换产物是否真的落进文件了。
 *
 * doctor 原来只认「整行完全相等」。但官方产物常在行尾多一个分号
 * （`const X = "...";` vs 补丁 replace 写出的 `const X = "..."`），
 * 整行相等就判不中 → 明明已经写进宿主却报 drifted，和 --status 口径打架。
 * 这里改成：整行相等、或文件里存在「产物去掉尾分号 / 补尾分号」的形态，
 * 都算已落地。
 *
 * 前缀兜底只在产物够长（≥120 字符）时才启用：太短的产物前缀会到处命中
 * （比如 "x" 这种），会把没落地的也判成已落地。
 */
export function replacementResultPresent(text, lineSet, repLine) {
  if (!repLine) return false;
  // 太短的产物行没有判别力（"x" 这种会到处命中），一律不算已落地。
  if (repLine.length < 12) return false;
  if (lineSet.has(repLine)) return true;
  if (lineSet.has(repLine.replace(/\/\//g, "#"))) return true;
  // 行尾分号差异：官方产物是 `...;`，补丁 replace 写的是 `...`（或反之）。
  const variants = new Set();
  if (repLine.endsWith(";")) variants.add(repLine.slice(0, -1).trimEnd());
  else variants.add(`${repLine};`);
  for (const v of variants) {
    if (!v) continue;
    if (lineSet.has(v)) return true;
    if (lineSet.has(v.replace(/\/\//g, "#"))) return true;
  }
  // 产物是多行块时，最长行可能在文件里被官方改写过首尾；退回前缀匹配兜底。
  // 金鱼审查 L2：前缀匹配按「行首」锚定（逐行 startsWith），不做全文 includes ——
  // 全文 includes 会被文件里任意位置的同前缀片段误命中（比如另一个字符串
  // 常量的子串），假 applied 比假 drifted 更危险。
  const head = repLine.slice(0, 120);
  if (head.length < 120) return false;
  for (const line of lineSet) {
    if (line.startsWith(head) || line.startsWith(head.replace(/\\\\/g, "#"))) return true;
  }
  return false;
}

/**
 * 逐补丁诊断。与 patchStatus 的区别：给出「哪条 replacement 漂了、漂去哪」。
 * state: applied（有锚或有产物）/ pending（锚在、产物不在，--apply 即可）/
 *        drifted（都不在，上游改版）/ missing_file / read_error / na。
 * options.files 可注入假映射供测试；options.surface 传给 patchAppliesHere。
 */
export async function diagnosePatches(aiBase = core.findAiBase(), patches = core.ALL_PATCHES, options = {}) {
  const dshHome = options.dshHome ?? core.findDshHome();
  const files = options.files ?? core.targetFiles(aiBase, dshHome);
  const patchList = options.patches ?? patches;
  // 判区按「这份宿主在哪一区」，不是按当前进程 —— CLI 在普通 node 下跑时
  // detectSurface() 恒判 web，桌面宿主上的 11 条 desktop-only 补丁会被全判 na。
  const surface = options.surface ?? core.surfaceForAiBase(aiBase);
  const textCache = new Map();
  const load = (fp) => {
    if (!textCache.has(fp)) {
      try {
        textCache.set(fp, fs.readFileSync(fp, "utf8"));
      } catch {
        textCache.set(fp, null);
      }
    }
    return textCache.get(fp);
  };
  const counts = { applied: 0, pending: 0, drifted: 0, missing_file: 0, read_error: 0, skipped: 0, na: 0 };
  const details = { drifted: [], pending: [], missing_file: [], read_error: [], na: [] };
  for (const p of patchList) {
    if (!core.patchAppliesHere(p, surface)) {
      counts.na += 1;
      continue;
    }
    const perFile = [];
    // 与 patchStatus 的 rollup 口径一致：只要有一个文件真的打上了就算 applied，
    // 不能因为「另一个可选目标文件在这份宿主里根本不存在」（比如嵌套副本
    // system-prompt-nested、宿主没装的可选包）就把整条补丁判成 missing_file。
    let appliedFiles = 0;
    let pendingFiles = 0;
    let driftedFiles = 0;
    let readErrorFiles = 0;
    let missingFiles = 0;
    let skippedFiles = 0;
    let totalFiles = 0;
    for (const key of fileKeysOf(p)) {
      const raw = files instanceof Map ? files.get(key) : files?.[key];
      const fps = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (fps.length === 0) {
        perFile.push({ file: key, state: "missing_file" });
        missingFiles += 1;
        totalFiles += 1;
        continue;
      }
      for (const fp of fps) {
        totalFiles += 1;
        const text = load(fp);
        if (text == null) {
          perFile.push({ file: key, fp, state: "read_error" });
          readErrorFiles += 1;
          continue;
        }
        const lineSet = trimmedLineSet(text);
        const reps = [];
        let fileWorst = "applied";
        // 权威判据 = core.filePatchOutcome（与 patchStatus 完全同一套逻辑）。
        //   applied → 这条补丁已经写进宿主（marker 在）
        //   pending → pattern 还在、产物不在（--apply 即可）
        //   drifted → pattern 与产物都不在（官方原文被改写）
        //   skipped → 撤销型补丁（pattern 本身就是本插件写下的痕迹），本来就没加过
        // doctor 原来只逐 replacement 比「整行完全相等」，官方产物常在行尾多一个分号
        // → 明明写进宿主却报 drifted（实测 39 条假 drifted），和 --status 打架。
        let settled = null;
        try {
          settled = core.filePatchOutcome(text, p, fp);
        } catch {
          settled = null;
        }
        if (settled === "skipped") {
          // 撤销型补丁（pattern 本身就是本插件写下的痕迹）：「没打上」是它的正常态。
          // 金鱼审查 M2：不能冒充 appliedFiles —— --status 对同一状态记 skipped，
          // doctor 记独立桶，两边各说各的实话，同一语义不再两套名字。
          fileWorst = "skipped";
          skippedFiles += 1;
        } else if (settled === "applied") {
          // marker 在：整体已落地。逐 replacement 只补明细，不参与状态判定 ——
          // 否则 #89→#107 这类链式改写（后一条补丁改写前一条的产物行）会被误判 drifted。
          fileWorst = "applied";
          appliedFiles += 1;
        } else {
          let hasPending = false;
          let hasDrifted = false;
          let hasLanded = false;
          let judged = 0;
          (p.replacements ?? []).forEach((r, pi) => {
            if (r.pattern instanceof RegExp) return; // 自匹配型，判不了，跳过不计
            judged += 1;
            const hasPattern = text.includes(r.pattern);
            const repLine = longestLine(r.replace);
            const hasResult = repLine.length >= 12 && replacementResultPresent(text, lineSet, repLine);
            const st = hasPattern && hasResult
              ? "ok"
              : !hasPattern && hasResult
                ? "applied"
                : hasPattern && !hasResult
                  ? "pending"
                  : "drifted";
            if (st === "drifted") {
              hasDrifted = true;
              const cand = locateCandidate(text, r.pattern);
              reps.push({
                pi,
                state: st,
                fragment: cand?.fragment,
                candidateLine: cand?.candidateLine,
                line: cand?.line,
              });
            } else if (st === "pending") {
              hasPending = true;
              reps.push({ pi, state: st });
            } else {
              hasLanded = true;
            }
          });
          if (judged === 0) {
            // 没有 replacements 可判（全是 RegExp / 缺失）：退回 filePatchOutcome。
            fileWorst = settled === "pending" ? "pending" : settled === "drifted" ? "drifted" : "applied";
            if (fileWorst === "applied") appliedFiles += 1;
            else if (fileWorst === "pending") pendingFiles += 1;
            else driftedFiles += 1;
          } else if (hasPending) {
            fileWorst = "pending";
            pendingFiles += 1;
          } else if (hasDrifted) {
            fileWorst = "drifted";
            driftedFiles += 1;
          } else {
            // 至少一条 replacement 落地（产物行在文件里）。此时 settled 若报 pending，
            // 是 patchApplied 对「只有 replacements、没有顶层 replace/marker」的补丁
            // 的已知误报（它 fallback 只看 patch.replace 首行，不认 replacements）。
            fileWorst = "applied";
            appliedFiles += 1;
          }
        }
        perFile.push({ file: key, fp, state: fileWorst, reps });
        if (fileWorst === "applied" || fileWorst === "ok") appliedFiles += 1;
        else if (fileWorst === "pending") pendingFiles += 1;
        else if (fileWorst === "drifted") driftedFiles += 1;
        else if (fileWorst === "read_error") readErrorFiles += 1;
        else if (fileWorst === "missing_file") missingFiles += 1;
      }
    }
    // rollup 口径与 patchStatus / rollupPatchStatus 对齐（金鱼审查 M2 后再对齐一处）：
    // read_error > pending > drifted > applied > skipped > missing_file。
    // 「这份宿主里根本没有这个可选文件」（嵌套副本 / 没装的可选包）不压过 applied。
    // skipped（撤销型补丁全文件没打上）只压过 missing_file —— 它是正常态，
    // 不该被 missing_file 抢走，也不冒充 applied（与 --status 的 skipped 计数同语义）。
    let state;
    if (readErrorFiles > 0) state = "read_error";
    else if (pendingFiles > 0) state = "pending";
    else if (driftedFiles > 0) state = "drifted";
    else if (appliedFiles > 0) state = "applied";
    else if (skippedFiles > 0) state = "skipped";
    else if (missingFiles === totalFiles && totalFiles > 0) state = p.optional ? "na" : "missing_file";
    else state = "applied";
    counts[state] += 1;
    if (details[state] && state !== "applied") details[state].push({ id: p.id, name: p.name, perFile });
  }
  return { aiBase, counts, ...details };
}

export function formatDiagnosis(report) {
  const c = report.counts;
  const lines = [];
  lines.push(`锚点诊断 @ ${report.aiBase}`);
  const head = [`✓ applied ${c.applied}`, `· pending ${c.pending}`, `✗ drifted ${c.drifted}`, `⚠ missing_file ${c.missing_file}`];
  if (c.read_error) head.push(`？read_error ${c.read_error}`);
  if (c.skipped) head.push(`· skipped ${c.skipped}`);
  if (c.na) head.push(`(na ${c.na})`);
  lines.push(`  ${head.join("   ")}`);
  for (const d of report.drifted) {
    lines.push(`  ✗ #${d.id} ${d.name ?? ""}`);
    for (const f of d.perFile) {
      if (f.state !== "drifted") continue;
      lines.push(`      ${f.fp ?? f.file}`);
      for (const r of f.reps ?? []) {
        if (r.state !== "drifted") continue;
        const at = r.line ? ` @L${r.line}` : "";
        const cand = r.candidateLine ? ` 候选行: ${String(r.candidateLine).slice(0, 100)}` : "（找不到近似锚点，改动太大需人工）";
        lines.push(`      rep#${r.pi} 漂移${at}${cand}`);
      }
    }
  }
  for (const d of report.pending) {
    const fps = d.perFile.filter((f) => f.state === "pending").map((f) => f.fp ?? f.file);
    const n = d.perFile.reduce((n2, f) => n2 + (f.reps ?? []).filter((r) => r.state === "pending").length, 0);
    lines.push(`  · #${d.id} ${d.name ?? ""} — ${n} 处未应用（锚点还在，--apply 即可）${fps.length ? ` ${fps[0]}` : ""}`);
  }
  if (report.drifted.length > 0) {
    lines.push("  提示：drifted 用 `--reanchor <补丁id> <rep#> [--dry]` 钉本地覆盖，下次 --apply 生效");
  }
  return lines.join("\n");
}

/**
 * 把 #id[pi] 的漂移锚点钉成本地覆盖。
 * 收下条件（全部满足才写）：
 *   - replace 产物不在文件里（已应用/未漂移直接拒绝，没得钉）；
 *   - 每个目标文件都能定位到候选行；
 *   - 所有宿主的候选行 trim 后一致；
 *   - 候选行在每个文件里全文件唯一（出现 1 次）。
 * dryRun: 只报告不写盘。
 */
export async function reanchorPatch(id, pi, options = {}) {
  const dshHome = options.dshHome ?? core.findDshHome();
  const aiBase = options.aiBase ?? core.findAiBase();
  const patchList = options.patches ?? core.ALL_PATCHES;
  const patch = patchList.find((p) => String(p.id) === String(id));
  if (!patch) throw new Error(`patch #${id} 不存在（--doctor 看列表）`);
  const rep = (patch.replacements ?? [])[Number(pi)];
  if (!rep) throw new Error(`patch #${id} 没有 replacement #${pi}`);
  if (rep.pattern instanceof RegExp) throw new Error(`#${id}[${pi}] 是 RegExp pattern，不支持重锚`);
  const files = options.files ?? core.targetFiles(aiBase, dshHome);
  const raw = files instanceof Map ? files.get(patch.file) : files?.[patch.file];
  const fps = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (fps.length === 0) throw new Error(`#${id} 目标文件缺失（file=${patch.file}）`);
  const cands = [];
  for (const fp of fps) {
    let text;
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch (e) {
      throw new Error(`读不了 ${fp}: ${e.message}`);
    }
    const repLine = longestLine(rep.replace);
    if (repLine && trimmedLineSet(text).has(repLine)) {
      return { needed: false, id: patch.id, pi: Number(pi), reason: "replace 产物已在文件里（已应用），无需重锚" };
    }
    const cand = locateCandidate(text, rep.pattern);
    if (!cand) throw new Error(`#${id}[${pi}] 在 ${fp} 里既找不到原锚点也找不到近似行——上游改动太大，人工看`);
    if (cand.exact) return { needed: false, id: patch.id, pi: Number(pi), reason: "原锚点仍在（未漂移），无需重锚" };
    cands.push({ fp, ...cand });
  }
  const uniq = new Set(cands.map((c) => c.candidateLine));
  if (uniq.size !== 1) {
    throw new Error(`多宿主候选行不一致（${uniq.size} 种），拒绝盲钉：${[...uniq].map((s) => String(s).slice(0, 60)).join(" | ")}`);
  }
  const candidateLine = cands[0].candidateLine;
  for (const { fp } of cands) {
    const text = fs.readFileSync(fp, "utf8");
    const n = countOccurrences(text, candidateLine);
    if (n !== 1) throw new Error(`候选行在 ${fp} 出现 ${n} 次，不唯一，拒绝盲钉`);
  }
  // 新 pattern = 原 pattern 里最长的那个探针行替换成候选行（保留原缩进）。
  const lines = String(rep.pattern).split(/\r?\n/);
  let bestIdx = -1;
  let bestLen = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.length > bestLen) {
      bestLen = t.length;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || bestLen === 0) throw new Error(`#${id}[${pi}] pattern 里没有可定位的行`);
  const indent = lines[bestIdx].match(/^[ \t]*/)[0];
  lines[bestIdx] = indent + candidateLine;
  const newPattern = lines.join("\n");
  if (options.dryRun) {
    return { needed: true, dryRun: true, id: patch.id, pi: Number(pi), from: rep.pattern, to: newPattern, candidateLine, line: cands[0].line };
  }
  const { overrides } = loadAnchorOverrides(dshHome);
  const key = String(patch.id);
  overrides[key] = overrides[key] ?? {};
  overrides[key][String(Number(pi))] = {
    from: rep.pattern,
    to: newPattern,
    note: `reanchor ${new Date().toISOString()} @ ${cands[0].fp}#L${cands[0].line}`,
  };
  saveAnchorOverrides(overrides, dshHome, `reanchor #${key}[${pi}]`);
  return {
    needed: true,
    id: patch.id,
    pi: Number(pi),
    from: rep.pattern,
    to: newPattern,
    candidateLine,
    saved: anchorStatePath(dshHome),
  };
}
