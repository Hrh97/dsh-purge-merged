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

const WORST_RANK = { applied: 0, pending: 1, drifted: 2, missing_file: 3, read_error: 4 };
function worstOf(a, b) {
  return (WORST_RANK[b] ?? -1) > (WORST_RANK[a] ?? -1) ? b : a;
}

function trimmedLineSet(text) {
  return new Set(text.split(/\r?\n/).map((l) => l.trim()));
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
  const surface = options.surface;
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
  const counts = { applied: 0, pending: 0, drifted: 0, missing_file: 0, read_error: 0, na: 0 };
  const details = { drifted: [], pending: [], missing_file: [], read_error: [] };
  for (const p of patchList) {
    if (!core.patchAppliesHere(p, surface)) {
      counts.na += 1;
      continue;
    }
    let worst = "applied";
    const perFile = [];
    for (const key of fileKeysOf(p)) {
      const raw = files instanceof Map ? files.get(key) : files?.[key];
      const fps = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (fps.length === 0) {
        perFile.push({ file: key, state: "missing_file" });
        worst = worstOf(worst, "missing_file");
        continue;
      }
      for (const fp of fps) {
        const text = load(fp);
        if (text == null) {
          perFile.push({ file: key, fp, state: "read_error" });
          worst = worstOf(worst, "read_error");
          continue;
        }
        const lineSet = trimmedLineSet(text);
        const reps = [];
        let fileWorst = "applied";
        (p.replacements ?? []).forEach((r, pi) => {
          if (r.pattern instanceof RegExp) return; // 自匹配型，判不了，跳过不计
          const hasPattern = text.includes(r.pattern);
          const repLine = longestLine(r.replace);
          const hasResult =
            repLine.length >= 12 && (lineSet.has(repLine) || lineSet.has(repLine.replace(/\/\//g, "#")));
          const st = hasPattern && hasResult ? "ok" : !hasPattern && hasResult ? "applied" : hasPattern && !hasResult ? "pending" : "drifted";
          if (st === "drifted") {
            const cand = locateCandidate(text, r.pattern);
            reps.push({
              pi,
              state: st,
              fragment: cand?.fragment,
              candidateLine: cand?.candidateLine,
              line: cand?.line,
            });
          } else if (st === "pending") {
            reps.push({ pi, state: st });
          }
          if (st === "pending" || st === "drifted") fileWorst = worstOf(fileWorst, st);
        });
        perFile.push({ file: key, fp, state: fileWorst, reps });
        worst = worstOf(worst, fileWorst);
      }
    }
    counts[worst] += 1;
    if (details[worst] && worst !== "applied") details[worst].push({ id: p.id, name: p.name, perFile });
  }
  return { aiBase, counts, ...details };
}

export function formatDiagnosis(report) {
  const c = report.counts;
  const lines = [];
  lines.push(`锚点诊断 @ ${report.aiBase}`);
  const head = [`✓ applied ${c.applied}`, `· pending ${c.pending}`, `✗ drifted ${c.drifted}`, `⚠ missing_file ${c.missing_file}`];
  if (c.read_error) head.push(`？read_error ${c.read_error}`);
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
