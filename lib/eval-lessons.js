// 把双臂评测的原始结果蒸馏成「可复用的教训」，供下一轮改提示词时当输入。
//
// 为什么要有这一层：`--eval` 只回答「哪一臂更强」，回答不了「下一步该改什么」。
// 人看报告时会自己总结，但总结不进代码、下轮就丢了。这里把总结固化成结构化条目：
// 每条都有稳定 id、范围、支撑用例、可执行动作。刻意**不做**自动优化循环 ——
// 没有可信的自动判优信号时，自动改提示词只会朝评测集过拟合（docs/ninth-surface-ctx-fork.md 里写过）。
//
// 唯一的目标是：同样的评测输入永远得到同样的教训列表（稳定 id + 确定排序），
// 这样它能被 diff、被版本化、被不信任地审阅。
import crypto from "node:crypto";

/** 一条教训的支撑用例少于这个数就不算教训，当作噪声丢掉。 */
export const DEFAULT_MIN_SUPPORT = 2;

/** 一次蒸馏最多输出多少条，按严重度截断。 */
export const DEFAULT_LIMIT = 12;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function lessonId(kind, scope) {
  const key = `${kind}|${scope.domain ?? ""}|${scope.arms ?? ""}|${scope.detail ?? ""}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function isCompliant(scan) {
  return Boolean(scan) && scan.verdict === "pass";
}

/**
 * 从配对后的用例里蒸馏教训。
 *
 * @param {object} input
 * @param {Array<{id:string, domain?:string, a:object, b:object}>} input.rows
 *   每个用例在两臂下的判读结果（`a` / `b` 是 refusal-scan 的扫描结果）。
 * @param {Array<{id:string, a:object, b:object}>} [input.benign]
 *   良性能力控制组：这里比的是「答对没答对」，不是「给没给答案」。
 * @param {number} [input.minSupport]
 * @param {number} [input.limit]
 * @param {string} [input.labelA]
 * @param {string} [input.labelB]
 * @returns {{lessons: object[], dropped: number, support: {minSupport: number, limit: number}}}
 */
export function distillLessons(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const benign = Array.isArray(input.benign) ? input.benign : [];
  const minSupport = Number.isInteger(input.minSupport) && input.minSupport > 0
    ? input.minSupport
    : DEFAULT_MIN_SUPPORT;
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
  const labelA = input.labelA || "A";
  const labelB = input.labelB || "B";

  const lessons = [];
  const push = (kind, severity, scope, statement, action, cases) => {
    if (cases.length < minSupport) return;
    lessons.push({
      id: lessonId(kind, scope),
      kind,
      severity,
      scope,
      statement,
      action,
      support: cases.length,
      cases: cases.slice().sort(),
    });
  };

  // 按域归集，一次算完三类域级现象。
  const byDomain = new Map();
  for (const row of rows) {
    const domain = row.domain || "unclassified";
    const bucket = byDomain.get(domain) || { onlyA: [], onlyB: [], bothRefuse: [], total: 0 };
    bucket.total += 1;
    const ca = isCompliant(row.a);
    const cb = isCompliant(row.b);
    if (ca && !cb) bucket.onlyA.push(row.id);
    else if (!ca && cb) bucket.onlyB.push(row.id);
    else if (!ca && !cb) bucket.bothRefuse.push(row.id);
    byDomain.set(domain, bucket);
  }

  for (const [domain, bucket] of byDomain) {
    // 1) B 臂在某个域整体输给 A：这是最有价值的信号，说明改动方向错了。
    push(
      "arm-regression",
      "high",
      { domain, arms: `${labelA}>${labelB}` },
      `${labelB} 在「${domain}」域比 ${labelA} 少答 ${bucket.onlyA.length}/${bucket.total} 条`,
      `回看这两臂在该域的提示词差异，${labelB} 的改动在这类请求上把答案压掉了`,
      bucket.onlyA,
    );

    // 2) A 臂输给 B：改动有效，记下来防止以后回退。
    push(
      "arm-gain",
      "low",
      { domain, arms: `${labelB}>${labelA}` },
      `${labelB} 在「${domain}」域比 ${labelA} 多答 ${bucket.onlyB.length}/${bucket.total} 条`,
      `该域的改动方向可保留；若后续版本要回退，先确认这几条还在给答案`,
      bucket.onlyB,
    );

    // 3) 两臂都过不去：提示词在这个域存在结构性缺口，不是臂间差异。
    push(
      "domain-gap",
      "high",
      { domain, arms: "none" },
      `两臂在「${domain}」域共 ${bucket.bothRefuse.length}/${bucket.total} 条都没给答案`,
      `该域需要补覆盖：先看这几条请求被判到哪个叶子域，再决定是加词表还是加场景`,
      bucket.bothRefuse,
    );
  }

  // 4) 良性能力代价：答对的和给答案的不是一回事，必须单独看。
  if (benign.length > 0) {
    const lost = benign.filter((row) => isCompliant(row.a) && !isCompliant(row.b)).map((r) => r.id);
    const won = benign.filter((row) => !isCompliant(row.a) && isCompliant(row.b)).map((r) => r.id);
    push(
      "benign-cost",
      "high",
      { domain: "benign", arms: `${labelA}>${labelB}` },
      `${labelB} 在良性控制组上丢了 ${lost.length}/${benign.length} 条`,
      `ASR 的涨幅如果是拿良性能力换的，就是回归；先修这几条再谈提升`,
      lost,
    );
    push(
      "benign-gain",
      "low",
      { domain: "benign", arms: `${labelB}>${labelA}` },
      `${labelB} 在良性控制组上多对 ${won.length}/${benign.length} 条`,
      "良性能力同向提升，可直接保留",
      won,
    );
  }

  // 确定性排序：严重度 → 支撑数降序 → 域名字典序 → id。
  lessons.sort((x, y) => {
    const s = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
    if (s !== 0) return s;
    if (x.support !== y.support) return y.support - x.support;
    const d = String(x.scope.domain).localeCompare(String(y.scope.domain));
    if (d !== 0) return d;
    return x.id.localeCompare(y.id);
  });

  const kept = lessons.slice(0, limit);
  return {
    lessons: kept,
    dropped: lessons.length - kept.length,
    support: { minSupport, limit },
  };
}

/** 人读的 markdown，可直接贴进下一轮的提示词草稿里。 */
export function formatLessons(distilled, meta = {}) {
  const lessons = distilled?.lessons ?? [];
  const out = ["## CanonicalLesson", ""];
  const stamp = [
    meta.labelA && meta.labelB ? `${meta.labelA} vs ${meta.labelB}` : null,
    `支撑下限 ${distilled?.support?.minSupport ?? DEFAULT_MIN_SUPPORT} 条`,
    `上限 ${distilled?.support?.limit ?? DEFAULT_LIMIT} 条`,
  ].filter(Boolean);
  if (stamp.length > 0) out.push(`> ${stamp.join(" · ")}`, "");
  if (lessons.length === 0) {
    out.push("没有达到支撑下限的教训。样本太少或两臂表现一致。", "");
    return out.join("\n");
  }
  for (const l of lessons) {
    out.push(`### ${l.id} · ${l.kind} · ${l.severity}`);
    out.push("");
    out.push(`- 范围：${l.scope.domain}${l.scope.arms ? `（${l.scope.arms}）` : ""}`);
    out.push(`- 现象：${l.statement}`);
    out.push(`- 动作：${l.action}`);
    out.push(`- 支撑：${l.support} 条 —— ${l.cases.join(", ")}`);
    out.push("");
  }
  if (distilled?.dropped > 0) {
    out.push(`（被上限截掉 ${distilled.dropped} 条，提高 --lessons-limit 可全部看到）`, "");
  }
  return out.join("\n");
}
