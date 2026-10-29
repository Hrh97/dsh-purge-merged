// 词根密度安全段判定（吸收自社区「安全话术段识别」思路，纯函数无依赖）。
//
// 用途：注入正文/提示词里那些整段都在讲 policy/refusal/合规 的段，可以整段摘掉；
// 但只要段里出现工具相关标记（tools/MCP/skills/API…）就整段保护——那多半是
// 工具说明书里顺带提了安全要求，摘了会把工具说明弄残。
// 判定走双阈值：词根命中数 >= minHits 且 命中密度 >= minRatio 才算「纯话术段」，
// 单独一个 "safety" 词绝不触发。中英双语词根（与 refusal-scan 的 ZH 表同思路）。

export const SAFETY_ROOTS = [
  "safety",
  "polic",
  "refus",
  "harm",
  "legal",
  "ethic",
  "censor",
  "restrict",
  "guardrail",
  "abuse",
  "malic",
  "disclaim",
];

// 词根两侧允许 0-4 个小写字母：polic → policy/policies/impolitic 之类都能吃到。
const SAFETY_RE = new RegExp(`\\b(?:${SAFETY_ROOTS.map((r) => `[a-z]{0,4}${r}[a-z]{0,4}`).join("|")})`, "gi");

// 中文词根：直接计数（中文没有词边界，includes 计数即可）。
export const SAFETY_ROOTS_ZH = ["安全", "政策", "合规", "拒绝", "风险", "敏感", "限制", "伦理", "审查"];

// 段里出现任一工具标记 → 整段保护，不摘。
export const TOOL_MARKERS = [/\btools?\b/i, /\bMCP\b/, /\bskills?\b/i, /\bfunction\b/i, /\bschema\b/i, /\bAPI\b/];

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

/** 词数：英文按 [A-Za-z]+ 计，中文按字计（ [\u4e00-\u9fff] 每字一个）。 */
export function countWords(section) {
  return (String(section ?? "").match(/[A-Za-z]+|[\u4e00-\u9fff]/g) ?? []).length;
}

export function countSafetyHits(section) {
  const latin = (String(section ?? "").match(SAFETY_RE) ?? []).length;
  let cjk = 0;
  for (const r of SAFETY_ROOTS_ZH) cjk += countOccurrences(section, r);
  return latin + cjk;
}

/**
 * 单段判定。
 * 返回 { safetyOnly, hits, ratio, words, protectedByToolMarker }。
 * safetyOnly = 无工具标记 && hits >= minHits && ratio >= minRatio。
 */
export function isSafetyOnlySection(section, opts = {}) {
  const minHits = opts.minHits ?? 6;
  const minRatio = opts.minRatio ?? 0.02;
  const words = countWords(section);
  const hits = countSafetyHits(section);
  const ratio = words > 0 ? hits / words : 0;
  const protectedByToolMarker = TOOL_MARKERS.some((re) => re.test(section));
  const safetyOnly = !protectedByToolMarker && hits >= minHits && ratio >= minRatio;
  return { safetyOnly, hits, ratio, words, protectedByToolMarker };
}

/** 按空行切段：偶数下标是段，奇数下标是段间空隙（split 带捕获组）。 */
export function splitSections(text) {
  return String(text ?? "").split(/(\n[ \t]*\n+)/);
}

function firstLine(section) {
  const l = String(section ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return l[0] ?? "";
}

/**
 * 整文试删：返回 { text, dropped, kept }。
 * dropped: [{ index, hits, ratio, preview }]；kept = 保留段数。
 * 不修改原字符串；删除即重组时跳过该段（相邻空隙一并规整）。
 */
export function stripSafetySections(text, opts = {}) {
  const parts = splitSections(text);
  const dropped = [];
  const kept = [];
  let index = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const section = parts[i] ?? "";
    const gap = parts[i + 1] ?? "";
    const v = isSafetyOnlySection(section, opts);
    if (v.safetyOnly && !v.protectedByToolMarker) {
      dropped.push({ index, hits: v.hits, ratio: v.ratio, preview: firstLine(section).slice(0, 80) });
    } else {
      kept.push(section, gap);
    }
    index += 1;
  }
  return { text: kept.join(""), dropped, kept: index - dropped.length };
}
