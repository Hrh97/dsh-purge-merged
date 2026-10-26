// 从 lib/core.js 的 ALL_PATCHES 生成补丁契约表（断言表）。
//
// 为什么需要它：87 条补丁里有 48 条是 optional（宿主结构变了就静默降级成 skipped），
// 而 skipIfMarked / markersAny / markers / marker 四种判定语义混用。没有一张离线表，
// 「这条补丁到底该在什么宿主上命中」只能靠人肉读代码，改一次宿主就得重新验一遍。
//
// 用法：
//   node scripts/gen-patch-contract.mjs           # 重新生成 test/patch-contract.json
//   node scripts/gen-patch-contract.mjs --check   # 只校验，不写文件（CI 用）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "test", "patch-contract.json");

const core = await import(new URL("../lib/core.js", import.meta.url).href);

function replacementsOf(patch) {
  if (Array.isArray(patch.replacements)) return patch.replacements;
  if (Array.isArray(patch.patterns)) return patch.patterns.map((pattern) => ({ pattern, replace: patch.replace }));
  return [];
}

function markersOf(patch) {
  if (Array.isArray(patch.markers) && patch.markers.length > 0) return { list: patch.markers, any: Boolean(patch.markersAny) };
  if (typeof patch.marker === "string" && patch.marker.length > 0) return { list: [patch.marker], any: false };
  return { list: [], any: false };
}

function describeReplacement(replacement) {
  const pattern = replacement?.pattern;
  if (pattern instanceof RegExp) {
    return { kind: "regexp", source: pattern.source, flags: [...new Set(pattern.flags)].sort().join("") };
  }
  if (typeof pattern === "string") {
    return { kind: "string", chars: [...pattern].length, lines: pattern.split("\n").length };
  }
  return { kind: "invalid" };
}

export function buildContract() {
  return core.ALL_PATCHES.map((patch) => {
    const replacements = replacementsOf(patch);
    const markers = markersOf(patch);
    const files = Array.isArray(patch.file) ? patch.file : patch.file === undefined ? [] : [patch.file];
    return {
      id: patch.id,
      name: patch.name,
      layer: patch.layer,
      layerEn: patch.layer_en,
      files,
      surfaces: Array.isArray(patch.surfaces) ? patch.surfaces : [],
      optional: patch.optional === true,
      softSettle: patch.softSettle === true,
      skipIfMarked: patch.skipIfMarked === true,
      strictFiles: patch.strictFiles === true,
      markers: markers.list,
      markersAny: markers.any,
      replacements: replacements.map(describeReplacement),
    };
  });
}

export function renderContract() {
  return `${JSON.stringify(buildContract(), null, 2)}\n`;
}

function main() {
  const contract = buildContract();
  const text = `${JSON.stringify(contract, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    if (!existsSync(OUT)) {
      console.error(`patch contract missing: ${OUT}`);
      process.exit(1);
    }
    if (readFileSync(OUT, "utf8") !== text) {
      console.error("patch contract is stale: run `node scripts/gen-patch-contract.mjs`");
      process.exit(1);
    }
    console.log(`patch contract ok (${contract.length} patches)`);
    return;
  }

  writeFileSync(OUT, text, "utf8");
  const withMarkers = contract.filter((entry) => entry.markers.length > 0).length;
  const optional = contract.filter((entry) => entry.optional).length;
  const regex = contract.reduce((sum, entry) => sum + entry.replacements.filter((item) => item.kind === "regexp").length, 0);
  console.log(`wrote ${OUT}`);
  console.log(`patches=${contract.length} withMarkers=${withMarkers} optional=${optional} regexReplacements=${regex}`);
}

// 只在「被当成脚本跑」时执行，被 import 时不写盘。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
