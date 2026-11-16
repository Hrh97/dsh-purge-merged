// 0.2.2-rc.3 锚点回归。
//
// 背景（2026-11-16 巡检）：宿主升到 0.2.2-rc.3 后，`--doctor` 报 #13 / #18 / #35 / #62
// 四条 drifted。逐条对真机源码核过，四条都是上游改写而不是我们写错：
//   #13  ESCALATION_WIDENING_EXEMPT：三处 throw 从 Error 换成带错误码的
//        SandboxEscalationError，且首行多了一个前导制表符。
//   #18  REPEAT_TOOL_REMINDER_DISABLED：post-execute 里的 downstream.kind === "block"
//        分支被删，只剩一条 return { ...downstream, additionalContexts }。
//   #35  ESCALATION_NEVER_REJECT：cancelled 分支拆成三行（先 throwIfAborted 再 throw）。
//   #62  OFFICIAL_TOOL_ASK_FAILOPEN：deny 分支改走 approvalDenial(reason, APPROVAL_*),
//        reason 不再内联成 kind/reason 对象。
//
// 这些断言全部跑在合成夹具上（逐字节抄 rc.3 原文），不依赖本机宿主：
// CI 里没有 dsh 也能验证「新锚点确实能命中 rc.3 的写法，且不误伤 rc.2 的旧写法」。
import test from "node:test";
import assert from "node:assert/strict";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

const patch = (id) => {
  const p = ALL_PATCHES.find((x) => x.id === id);
  assert.ok(p, `patch #${id} 必须存在`);
  return p;
};

/** rc.3 dsh-sandbox/lib/index.js 里 approveEscalation 的原文（tab 缩进）。 */
const RC3_SANDBOX = [
  "\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;",
  "\tif (mode === effectiveMode) return effectiveMode;",
  '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new SandboxEscalationError(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`, "SANDBOX_ESCALATION_INVALID_ARGUMENT");',
  '\tif (approval.approver === void 0) throw new SandboxEscalationError(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`, "SANDBOX_ESCALATION_UNAVAILABLE");',
  '\tif (approval.agent === void 0) throw new SandboxEscalationError(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`, "SANDBOX_ESCALATION_UNAVAILABLE");',
  "\tconst outcome = approval.approver !== undefined && approval.agent !== undefined ? await approval.approver.request({",
  "\t\tagent: approval.agent,",
  "\t\ttoolName: approval.toolName,",
  "\t\tcallId: approval.callId,",
  "\t\treason: `escalate sandbox to ${mode}: ${justification}`,",
  "\t\tdisplayReason: escalationDisplayReason(mode, justification),",
  "\t\t...approval.signal ? { signal: approval.signal } : {}",
  '\t}) : "allowed-once";',
  "\tswitch (outcome) {",
  '\t\tcase "allowed-once": return mode;',
  '\t\tcase "rejected": throw new SandboxEscalationError(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`, "SANDBOX_ESCALATION_REJECTED");',
  '\t\tcase "cancelled":',
  "\t\t\tapproval.signal?.throwIfAborted();",
  '\t\t\tthrow new SandboxEscalationError(`approval for escalating to "${mode}" was cancelled`, "SANDBOX_ESCALATION_CANCELLED");',
  '\t\tcase "unavailable": throw new SandboxEscalationError(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`, "SANDBOX_ESCALATION_UNAVAILABLE");',
  '\t\tdefault: return assertNever(outcome, "EscalationOutcome");',
  "\t}",
].join("\n");

/** rc.3 dsh-repeat-tool-reminder/lib/index.js 的 apply 尾部（block 分支已删）。 */
const RC3_REPEAT_REMINDER = [
  "\tctx.on(\"tools/post-execute\", async (exec, _result, next) => {",
  "\t\tconst reminder = observe(exec);",
  "\t\tconst downstream = await next();",
  "\t\tif (!reminder) return downstream;",
  "\t\treturn {",
  "\t\t\t...downstream,",
  "\t\t\tadditionalContexts: prependContext(reminder, downstream.additionalContexts)",
  "\t\t};",
  "\t});",
  '\tctx.on("agent/pre-step", ({ agent, messages }, next) => {',
  '\t\tif (messages.some((message) => message.source.kind === "user")) chains.delete(agent);',
  "\t\treturn next();",
  "\t});",
  "}",
].join("\n");

/** rc.3 dsh-tools/lib/pipeline.js 的 serviceAsk 片段（tab 缩进）。 */
const RC3_PIPELINE = [
  "\tasync serviceAsk(exec, ask) {",
  '\t\tconst approval = this.ctx.get("approval");',
  "\t\tif (approval === void 0) return {",
  "\t\t\tdecision: approvalDenial(ask.reason ?? `tool \"${exec.name}\" requires approval (not yet supported)`, APPROVAL_UNAVAILABLE),",
  "\t\t\tapprovalCancelled: false",
  "\t\t};",
  "\t\tif (exec.agent === void 0) return {",
  '\t\t\tdecision: approvalDenial(`tool "${exec.name}" requires approval, but the call has no agent to route it through`, APPROVAL_UNAVAILABLE),',
  "\t\t\tapprovalCancelled: false",
  "\t\t};",
  "\t\tconst outcome = await approval.request({",
  "\t\t\tagent: exec.agent,",
  "\t\t\ttoolName: exec.name,",
  "\t\t\tcallId: exec.callId,",
  "\t\t\t...ask.reason !== void 0 ? { reason: ask.reason } : {},",
  "\t\t\t...ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {},",
  "\t\t\tsignal: exec.signal",
  "\t\t});",
  "\t\tswitch (outcome) {",
  '\t\t\tcase "allowed-once": return {',
  '\t\t\t\tdecision: { kind: "allow" },',
  "\t\t\t\tapprovalCancelled: false",
  "\t\t\t};",
  '\t\t\tcase "rejected": return {',
  '\t\t\t\tdecision: approvalDenial(`the user rejected tool "${exec.name}"`, APPROVAL_REJECTED),',
  "\t\t\t\tapprovalCancelled: false",
  "\t\t\t};",
  '\t\t\tcase "cancelled": return {',
  '\t\t\t\tdecision: approvalDenial(`approval for tool "${exec.name}" was cancelled`, APPROVAL_CANCELLED),',
  "\t\t\t\tapprovalCancelled: true",
  "\t\t\t};",
  '\t\t\tcase "unavailable": return {',
  '\t\t\t\tdecision: approvalDenial(`tool "${exec.name}" requires approval, but no approval channel is available`, APPROVAL_UNAVAILABLE),',
  "\t\t\t\tapprovalCancelled: false",
  "\t\t\t};",
  '\t\t\tdefault: return assertNever(outcome, "ApprovalOutcome");',
  "\t\t}",
  "\t}",
].join("\n");

/** rc.3 dsh-tools/lib/types/pipeline.js 的同段（4 空格 + 单引号）。 */
const RC3_PIPELINE_TYPES = [
  "    async serviceAsk(exec, ask) {",
  "        const approval = this.ctx.get('approval');",
  "        if (approval === undefined) {",
  "            return {",
  "                decision: approvalDenial(ask.reason ?? `tool \"${exec.name}\" requires approval (not yet supported)`, APPROVAL_UNAVAILABLE),",
  "                approvalCancelled: false,",
  "            };",
  "        }",
  "        if (exec.agent === undefined) {",
  "            return {",
  "                decision: approvalDenial(`tool \"${exec.name}\" requires approval, but the call has no agent to route it through`, APPROVAL_UNAVAILABLE),",
  "                approvalCancelled: false,",
  "            };",
  "        }",
  "        switch (outcome) {",
  "            case 'unavailable':",
  "                return {",
  "                    decision: approvalDenial(`tool \"${exec.name}\" requires approval, but no approval channel is available`, APPROVAL_UNAVAILABLE),",
  "                    approvalCancelled: false,",
  "                };",
  "        }",
  "    }",
].join("\n");

test("#13 rc.3：SandboxEscalationError 三连 throw 被整段豁免", () => {
  const p = patch(13);
  const r = applyReplacementsToText(RC3_SANDBOX, p, "dsh-sandbox/lib/index.js");
  assert.equal(r.changed, true, "rc.3 原文必须命中新锚点");
  assert.ok(r.text.includes("[dsh-purge] escalation bypass"), "必须留下 marker");
  assert.ok(!r.text.includes("SANDBOX_ESCALATION_INVALID_ARGUMENT"), "严格升级阶梯必须消失");
  // 只断言这三条 throw 本体消失：SANDBOX_ESCALATION_UNAVAILABLE 这个错误码在 switch 的
  // case "unavailable" 里还有一处（属 #35 的靶），不能整串 grep。
  assert.ok(!r.text.includes("no approval service is composed"), "审批服务要求必须消失");
  assert.ok(!r.text.includes("no agent to route it through"), "agent 路由要求必须消失");
  assert.ok(!r.text.includes("is not strictly wider than this call"), "严格更宽判定必须消失");
});

test("#13 幂等：同一段 rc.3 原文连打两次不再变化", () => {
  const p = patch(13);
  const once = applyReplacementsToText(RC3_SANDBOX, p, "dsh-sandbox/lib/index.js");
  const twice = applyReplacementsToText(once.text, p, "dsh-sandbox/lib/index.js");
  assert.equal(twice.changed, false, "第二次必须判定已应用");
  assert.equal(twice.text, once.text);
});

test("#13 不误伤 rc.2：旧 Error 写法仍然走老锚点", () => {
  const rc2 = [
    'if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);',
    '\tif (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);',
    '\tif (approval.agent === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);',
  ].join("\n");
  const r = applyReplacementsToText(rc2, patch(13), "dsh-sandbox/lib/index.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] escalation bypass"));
});

test("#35 rc.3：SandboxEscalationError + 三行 cancelled 分支被收成无条件授信", () => {
  const r = applyReplacementsToText(RC3_SANDBOX, patch(35), "dsh-sandbox/lib/index.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] escalation never rejected"));
  assert.ok(!r.text.includes("SANDBOX_ESCALATION_REJECTED"), "rejected 分支必须消失");
  assert.ok(!r.text.includes("SANDBOX_ESCALATION_CANCELLED"), "cancelled 分支必须消失");
});

test("#18 rc.3：block 分支已删的 post-execute 被整段停用", () => {
  const r = applyReplacementsToText(RC3_REPEAT_REMINDER, patch(18), "dsh-repeat-tool-reminder/lib/index.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] repeat-tool-reminder disabled"));
  assert.ok(!r.text.includes("tools/post-execute"), "post-execute 监听必须整段消失");
  assert.ok(!r.text.includes("agent/pre-step"), "pre-step 链清理必须整段消失");
});

test("#18 不误伤 rc.2：带 block 分支的旧写法仍命中", () => {
  const rc2 = [
    '\tctx.on("tools/post-execute", async (exec, _result, next) => {',
    "\t\tconst reminder = observe(exec);",
    "\t\tconst downstream = await next();",
    "\t\tif (!reminder) return downstream;",
    '\t\tif (downstream.kind === "block") return {',
    '\t\t\tkind: "block",',
    "\t\t\tfeedback: downstream.feedback,",
    "\t\t\tadditionalContexts: prependContext(reminder, downstream.additionalContexts)",
    "\t\t};",
    "\t\treturn {",
    "\t\t\t...downstream,",
    "\t\t\tadditionalContexts: prependContext(reminder, downstream.additionalContexts)",
    "\t\t};",
    "\t});",
    '\tctx.on("agent/pre-step", ({ agent, messages }, next) => {',
    '\t\tif (messages.some((message) => message.source.kind === "user")) chains.delete(agent);',
    "\t\treturn next();",
    "\t});",
  ].join("\n");
  const r = applyReplacementsToText(rc2, patch(18), "dsh-repeat-tool-reminder/lib/index.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] repeat-tool-reminder disabled"));
});

test("#62 rc.3 pipeline.js：approvalDenial 三条 deny 分支全部放行", () => {
  const r = applyReplacementsToText(RC3_PIPELINE, patch(62), "dsh-tools/lib/pipeline.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] no approval service → allow"));
  assert.ok(r.text.includes("[dsh-purge] no agent → allow"));
  assert.ok(r.text.includes("[dsh-purge] unavailable channel → allow"));
  // 用户主动点拒绝的分支必须原样留着 —— 只放行「没有通道」，不改写人工拒绝。
  assert.ok(r.text.includes("APPROVAL_REJECTED"), "用户拒绝分支不能被吞");
  assert.ok(r.text.includes("APPROVAL_CANCELLED"), "用户取消分支不能被吞");
});

test("#62 rc.3 types/pipeline.js：4 空格 + 单引号副本同样命中", () => {
  const r = applyReplacementsToText(RC3_PIPELINE_TYPES, patch(62), "dsh-tools/lib/types/pipeline.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("[dsh-purge] no approval service → allow"));
  assert.ok(r.text.includes("[dsh-purge] unavailable channel → allow"));
});

test("#62 不误伤 rc.2：kind/reason 对象写法仍命中", () => {
  const rc2 = [
    "\t\tif (approval === void 0) return {",
    "\t\t\tdecision: {",
    '\t\t\t\tkind: "deny",',
    '\t\t\t\treason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`',
    "\t\t\t},",
    "\t\t\tapprovalCancelled: false",
    "\t\t};",
  ].join("\n");
  const r = applyReplacementsToText(rc2, patch(62), "dsh-tools/lib/pipeline.js");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('decision: { kind: "allow" }'));
});
