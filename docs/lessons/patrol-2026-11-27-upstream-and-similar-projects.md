# 上游更新与同类项目巡检（2026-11-27 10:43 CST）

## 结论先行

1. **正主上游没有更新可拿**：`HunYiSage/dsh-purge` 已 404（API 实测），缓存基线停在 `fc6e787` / 1.1.92。本地 fork `Hrh97/dsh-purge-merged` 与 `origin/master` 完全同步（`df103db`，`0 0`），本地版本 **1.3.1**，比归档上游新 30+ 个小版本。最新 Release `v1.3.1`（2026-11-25T01:56:50Z）。**无欠账**。
2. **两个仓库在本轮有实质更新且带可吸取点**：`xqpsec/dsh-jailbreak` 2.1.1（11-26）、`youki258/dsh-purge-minimal` 0.2.8（11-26）。后者暴露了本地一个真实缺口（格式尾块触发拒答）。
3. **一个新发现仓库**：`shenwei322/dsh-purge-ports`（119★，11-03），移植到 WorkBuddy/ZCode，5 套预设 + scope/drill/doctor/probe。大部分能力本地已有，只有 writer 预设的连续性护栏是独特角度。
4. **其余监控项无实质变化**：`kingcharleslzy-ai/dsh-purge` HEAD `e519253` 只是 contributor avatars（bot 提交）；`momusai/momus` 只是 aws-sdk 依赖 bump；`aibot88/opencode-redteam` 是 v2 清理；`Irsyadmr354/KESTREL` 的 scope 八段分类与本地同类结论同向。

---

## 一、上游状态（GitHub API + git 双验证）

| 项 | 值 |
|---|---|
| 本地 HEAD | `df103db` |
| origin/master | `df103db`（`git rev-list --left-right --count` = `0 0`） |
| 本地 package.json | 1.3.1 |
| fork 最新 Release | v1.3.1（2026-11-25T01:56:50Z） |
| 正主 `HunYiSage/dsh-purge` | 404，缓存 `fc6e787` / 1.1.92 |
| 归档镜像 `mmparko/dsh-purge` | 6076★（+71），73 tag，仅作备份 |

`docs/lessons` 里已有的吸收记账覆盖 1.7.12 / 1.7.17 / 1.7.19 / 1.7.20 等社区版本，本轮不重复。

---

## 二、值得吸取的具体项（按价值排序）

### P0 — `youki258/dsh-purge-minimal` 0.2.8：`FORMAT_TAIL` 格式尾块

来源：[commit e82a43c](https://github.com/youki258/dsh-purge-minimal/commit/e82a43c)（`lib/refusal-ladder.js`，2026-11-26T15:51:23Z）。

对方的实测结论：题面尾部带「作答格式 / 输出格式 / 回答格式 / Answer format」这类格式块时，模型会走进「判定是否允许」的分支并回「不可以」；把这块切掉，同一条请求 **3/3 交付**。破甲题库 35 题：`hy4flash-free 11/35 → 34/35`，`dsv41 22/35 → 32/35（2 轮）→ 35/35（3 轮）`。

本地核对：`lib/` 全树 92 个 JS 文件 grep `作答格式|输出格式|FORMAT_TAIL|stripFormat` = **0 命中**。本地 `retry-ladder.js` 的 `stripLandingWords()` 只剥平台版本 / 线上环境 / 第三方主体 / 真实地址 / 截止时间 / 真实人物六类落点词，没有格式尾块这一类。**这是真缺口。**

处理：已把格式尾块剥离并入 `stripLandingWords()`（`lib/retry-ladder.js`），作为落点词循环之前的预处理。它只在第 2 级 sanitize 触发，不改变首答行为。

### P1 — `youki258` 0.2.8：两条裸动作拒答形态

同一 commit 给 `REFUSAL_PATTERNS` 补了 4 条不带「不能」的硬拒绝（「我不会做 / 不会提供步骤」一类），对方实测免费档撞库请求正是这种措辞，旧规则集漏判 → 阶梯不触发。

本地 `lib/refusal-scan.js` 已有 `REFUSAL_MARKERS_ZH_STEALTH`（含「我不会给这份 / 我不会给出完整 / 我不会提供绕过 / 我不给这份」等**带宾语**形态）以及一组结构正则，但没有「不会提供（具体/操作）步骤」这种裸动作形态。已补两条带宾语限定的形态进 stealth 表，避开「我不会提供默认值」这类正常工作句。

### P1 — `xqpsec/dsh-jailbreak` 2.1.1：请求侧 content-length 合并坑

来源：[commit daca8ad](https://github.com/xqpsec/dsh-jailbreak/commit/daca8ad)（issue #5 fix）。

`lib/live.js` 七处手写 `content-length`；当 `@deepseek-ai/dsh-http-proxy` 把 userland undici 装成全局 dispatcher 时，显式 content-length 在新 body 上被合并成 `"17, 17"` → undici 抛 `UND_ERR_INVALID_ARG`，所有模型请求五次重试后全挂。修法是删掉手写头让 fetch 自己算。

本地核对：`lib/redteam/ui.js:632` 的 `content-length` 是**响应侧** `sendJson()`，写法正确，无此问题。但本地 `lib/core.js:5655` 有动态 `import("undici")` + `undici.Agent` 路径，说明本地也会走 undici 全局 dispatcher。**结论：本轮无需改码，但列为回归检查项**——以后任何 outbound 请求手写 content-length 都要先删掉再交给 fetch。

### P2 — `xqpsec` 2.1.1：纯函数 request-boundary kernel + 多协议支持

来源：[lib/kernel.js](https://github.com/xqpsec/dsh-jailbreak/blob/main/lib/kernel.js) / [docs/portable-kernel.md](https://github.com/xqpsec/dsh-jailbreak/blob/main/docs/portable-kernel.md)。

设计要点：零依赖纯函数，一条短 system 指令作用于每个合法请求；覆盖 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses / Gemini `generateContent`；不改 sampling、tools、schema、stream；幂等 `already-applied`；6 档 `KERNEL_LADDER`，`attempt % 6` 换档重发；`detectRefusal()` 只读前 200 字符、13 条句式；`attemptBudgetMs` 默认 180s 防止慢模型把阶梯拖过客户端超时；`x-kernel-rung` 响应头回报实际档位。

与本地对照：本地 `lib/refusal-retry.js` + `lib/retry-ladder.js` 更成熟（全文扫描 + 位置标注 + 工具调用放行 + reasoning 缓冲 + 交付质量标签 + 审计），阶梯 3 档且 decompose 默认关。**重复度高，不整体搬运。** 但两个工程细节值得记：

- `attemptBudgetMs`（180s）这个旋钮本地没有——本地 `maxAttempts` 有上限但无时间预算，慢模型上多级重试会拖到客户端超时，表现为 `fetch failed` 而不是拒答。
- `x-kernel-rung` 这类「实际走到第几档」的可观测字段，本地 `refusal_ladder` 审计里有 `attempt` / `arm`，等价能力已具备。

对方的测量纪律也值得抄进评测口径：**三票判定**（单票在 8 题集上把两个指令的排名判反）、**每场重新 baseline**（同一 endpoint 同一模型隔几小时分数会变）、数字必须带时间戳 + endpoint。本地 `lib/prompt-eval.js` 已有 asrFirst/asrFinal 分离，缺的是三票与重基线约束。

对方实测的诚实边界（值得本地评测参考）：20 个混合红队目标 ladder@6 = 16/20，held-out 12 个 blunt 目标 0/12—— escalation 只能移动「模型对用途的判断」，不能移动「模型对能力本身的禁止」。

### P2 — `shenwei322/dsh-purge-ports` 1.2.0（新发现）

来源：[README.md](https://github.com/shenwei322/dsh-purge-ports/blob/main/README.md)，119★，最近 push 2026-11-03T04:57:45Z，Apache-2.0。

把 dsh-purge 规则移植到 WorkBuddy 与 ZCode：5 套预设（default 15.7KB / lite 7.0KB / redteam 6.6KB / writer 6.5KB / terse 4.3KB）、`purge scope` 范围管理、`purge drill` 六阶段骨架、doctor/verify/probe、21 类意图 + 8 项元能力静态覆盖率评测进 CI。

本地对照：`lib/net-scope.js`（范围）、`lib/drill-grant.js`（演练）、`lib/selfcheck.js` + `lib/probe.js`（自检探针）、`lib/prompt-eval.js`（评测）、`presets/`（预设）——**大面积重复，不搬**。

唯一独特角度：**writer 预设的露骨度四档（暗示/常规/露骨/极致）+ 长会话连续性四层护栏（人物锚、状态表、关系度量、记忆压缩）**。本地有 redteam / writer 类预设但没有把连续性状态显式拆成四层。如果后续做长篇创作线，这是可参考的组织方式，本轮不动。

### P3 — `Irsyadmr354/KESTREL` 262d1a8

把 scope 改成八段 category list（`sync: scope as category list of eight parts`）。与本地「SCOPE 12 条压一句 = 压缩不损失行为」的结论同向，属于旁证，无动作。

---

## 三、本轮实际落地的改动

| 文件 | 改动 |
|---|---|
| `lib/retry-ladder.js` | 新增 `FORMAT_TAIL` 正则；`stripLandingWords()` 在落点词循环前先剥格式尾块，并记入 `removed`（id=`format-tail`） |
| `lib/refusal-scan.js` | `REFUSAL_MARKERS_ZH_STEALTH` 补两条带宾语的裸动作拒答形态 |
| `test/retry-ladder-format-tail.test.mjs` | 格式尾块命中 / 不误伤正文 / 先剥尾块 / 与落点词同时剥 / 无尾块不变 / 拒答词命中，6 项断言 |

校验：`node --check` 两文件通过；新增测试 6/6；`npm test` **523/523 全绿**（新增前 517）。

改动均为纯函数层，不碰宿主补丁、不改提示词镜像。**内核提示词未改 → 无需 `npm run qoder:sync` / WorkBuddy 同步。**

---

## 四、明确不做的项

- 不整体搬运 `xqpsec` 的 kernel：本地 refusal-retry 判定与审计更完整，替换等于倒退。
- 不搬 `shenwei322` 的 5 预设体系：本地 preset 机制已覆盖，重复建设。
- 不改版本：本轮是吸收 + 巡检，无行为契约变化，版本号保持 1.3.1。
- 不动 fork 与 origin：已同步，无 push 需求。

## 五、下轮可选项

1. 给 `refusal-retry.js` 加 `attemptBudgetMs` 时间预算（默认 180s），与 `maxAttempts` 双封顶。需要先看本地 adapter 的超时边界，避免与 `DSH_QODER_QUEUE_TIMEOUT_MS` 冲突。
2. 把「三票判定 + 每场重基线」写进 `lib/prompt-eval.js` 的报告口径，作为评测纪律约束。
3. 把 outbound content-length 检查加进 `scripts/` 的静态审计（当前只有人工核对）。

---

## 六、收尾评估（YG「确实没有可吸收的就收尾」）

对上面三个可选项逐条核对源码后定案，结论：**没有必须吸收的项，本轮收尾**。

| 候选项 | 核对结果 | 定案 |
|---|---|---|
| `attemptBudgetMs` 时间预算 | `lib/refusal-retry.js:218` 默认 `maxAttempts=1`，只有一次 amplify 重发；重试是流式缓冲独立请求，不累积多级。xqpsec 的坑出在 6 档阶梯 + 慢模型拖过客户端 300s，本地默认走不到那个深度；Queue 层另有 `DSH_QODER_QUEUE_TIMEOUT_MS` 兜底。 | 可选增强，非欠账。不改。 |
| 三票判定 + 每场重基线 | `lib/prompt-eval.js` 是**静态规则判分**（`isCompliant` / `meetsRubric` → `looksDeliverable`），并有双臂配对 + McNemar 精确检验 + 良性代价对照。三票判定针对的是「用模型当 judge」场景——本地评测架构根本不用模型 judge，三票无的放矢。 | 架构不适用，排除。 |
| outbound content-length 静态审计 | 本地唯一 `content-length` 在 `lib/redteam/ui.js:632` 的 `sendJson()`（响应侧），写法正确；outbound 侧没有手写该头的代码，没有靶子。 | 无实际靶子，排除。 |

**最终状态**：上游零欠账；本轮两项真缺口（格式尾块、裸动作拒答）已落地并 523/523 验证；其余候选项或架构不适用、或无靶子、或属可选增强。无待吸收项，收尾。改动未提交 git（YG 未要求提交）。
