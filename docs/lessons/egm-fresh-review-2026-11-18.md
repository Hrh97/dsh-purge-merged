# EGM 式 fresh review — dsh-purge v1.2.6 拒答重试与交付审计改动（2026-11-18）

> 独立 Goldfish 审查：起一个看不到发起方对话上下文的 subagent，只读磁盘当前内容与 `git diff`，不依赖任何会话结论。审查对象：v1.2.6（withNudge block 数组 + 交付结果审计标签 + 图像类推脱保守子集）。本报告由 goldfish-review subagent 产出，主 agent 原样落盘，未修改审查结论。

## 整体健康度

`withNudge` 的 block 数组收敛方向正确、调用面只有仓库内一处，回归测试钉住了 `.some()` 契约；`onOutcome`/`stats` 写入与异常隔离也和既有 `onRetry` 一致。主要问题集中在**新加的采样器本身有重复计数 bug**，直接削弱本批改动的核心价值（识别假成功）；其次是指南注释承诺的四分类与实现三分类不符、thin 口径对散文交付误判、两条新 stealth 词误伤短转述，以及测试与文档的数字对不上磁盘。全套 `npm test` 435 pass / 0 fail，两个改动文件 `node --test` 64 pass —— 但有断言覆盖率问题，绿灯不代表关键分支被测到。

## 高

### H1 — `trackChunk` 对缓冲 chunk 二次计数，thin/阈值判定被污染，恰好漏掉本功能要抓的假成功

- 位置：`lib/refusal-retry.js:219`（缓冲阶段 `trackChunk`）、`:233`（正常回答分支再 `trackChunk`）、`:256`（giveup/accept 分支再 `trackChunk`）
- 问题：缓冲循环里每个 chunk 已经 `buffered.push` + `trackChunk` 一次；走到两个提前返回分支时，`for (const chunk of buffered) { trackChunk(chunk); yield chunk; }` 又把同一批 chunk 记进 `sample.text` 一次。`chars` 翻倍、`lines`/`steps` 也翻倍。后果有两端：
  1. 本该 `thin` 的交被误判成不薄 → 本批要抓的「先铺垫再推脱」假成功被记成 `recovered`；
  2. `steps` 从 3 变 5 就能跨过 `steps < 5` 的闸门。
- 实测（inline 流，未改仓库）：
  - 单个 `text-delta`（143 字）+ `finish`，正常分支：`onOutcome.chars = 286`（真实 143），`steps = 6`（真实 3）。
  - `judgeDelivery("1. a\n2. b\n3. c")` → `steps=3, thin=true`；同一文本重复一遍 → `steps=5, thin=false`。
  - giveup 分支同样翻倍：`maxAttempts=1` 二次拒答，`chars=68`（真实 34）。
  - 末级重发分支（`:270`）用的是新 iterator、无 buffered 回灌，不受影响 —— 所以这个 bug 是"部分终态错、部分终态对"，更难在面板上看出规律。
- 建议：`:233` 与 `:256` 改回 `for (const chunk of buffered) yield chunk;`，只对 drain iterator 的 chunk 继续 `trackChunk`（`:236` 保留）。再补一条断言：正常回答分支的 `onOutcome.chars` 必须严格等于流出正文长度。

## 中

### M1 — `refused` 标签永不输出，注释与实现矛盾；重试耗尽仍拒答被记成 `empty_after_retry`

- 位置：`lib/refusal-retry.js:93-101`、`:257`、`:271`
- 问题：`:93` 注释明确承诺「refused 由调用方在缓冲段命中拒绝且重试预算用尽时直接给」，但 `judgeOutcome()` 的返回值只有 `partial_refused` / `empty_after_retry` / `recovered` 三种，没有任何分支产生 `refused`。调用方 `:257` 传 `reportOutcome("refusal")` 只是把本地 `refused` 布尔置真，最终仍落到 `retried ? empty_after_retry : partial_refused`。实测 `maxAttempts=0`（第一发拒答、预算即耗尽）→ `outcome="partial_refused"`，不是注释说的 `refused`；`maxAttempts=1` 二次仍拒答 → `outcome="empty_after_retry"`。最严重的"彻底拒答"被混进"重试后空转"，统计粒度丢失。
- 建议：二选一——(a) 在 `judgeOutcome` 加最高优先级分支 `if (verdict === "refusal" && retried) return { outcome: "refused", ...delivery, retried }`；(b) 删掉 `:93` 的 refused 承诺，统一三分类并同步改 release notes 口径。当前"注释说四种、代码出三种、release notes 列三种"是最糟的状态。

### M2 — thin 口径对散文式交付误判，叠加 `scanReply` 全文扫描会把正常长答复打假失败

- 位置：`lib/refusal-retry.js:71-84`（`judgeDelivery`）、`:97`（`scanReply(text).verdict === "refusal"`）
- 问题：`thin = lines < 10 && steps < 5`，而 `lines` 只数围栏内行和带代码特征的行、`steps` 只数行首编号/列表。用户要一篇分析、报告、小说、协议解读时，模型给 2000 字纯散文 → `lines=0, steps=0 → thin=true`。同时 `refusal-scan.js:16,184-186` 的 `scanReply` 是**全文扫描、verdict 取 refusal 优先**，且 `NON_REFUSAL_TAIL`（`refusal-scan.js:87-89`）只排除「保证/确定/避免/预测/承诺」。于是正文里一句正常的「我无法验证 Node 12 的场景，但下面是完整矩阵…」就会让全文 `verdict=refusal`，与 thin 组合 → 标成 `partial_refused`。`test/refusal-retry.test.mjs:341-358` 只验证了"藏尾的推脱要抓到"，没有验证"长文正常引用不能误抓"。
- 建议：给 `judgeDelivery` 加长文短路（如 `chars >= 600 → thin=false`，或对非代码类交付改用段落数）；`judgeOutcome` 的 refused 判定改用 `scanReply` 返回的 `refusal.opening` / `refusal.tail` 位置信息，而不是全局 `verdict`，避免正文引用被当拒绝。

### M3 — 两条新 stealth 词在 head8 窗口误伤正常答复与短转述；测试用长前缀制造假阳性

- 位置：`lib/request-shape.js:185-191`、`test/request-shape.test.mjs:63-71`（尤其 `:70`）
- 问题：`head8.includes(h)` 是子串命中，不要求后接标点或句末。"这张我跳过颜色，直接换成红色。""这条我不接手，继续接下一条。"都是正常工作开场，实测 `classifyRefusal` 均返回 `true`。转述防线也只在你挑的长前缀下成立：测试 `:70` 用「它刚才说「这张我跳过」」（"这张"从 idx5 起，5+5>8，够不着），但更短的「它说「这张我跳过」，我们换个说法。」实测返回 `true`。这些会经 `reshapeMessages` 的 `shadowRefusal`（`lib/request-shape.js:340-352`）把正常 assistant 历史擦成「（已跳过）」。注意重试判定走的是 `scanReply`、不吃这两词，影响面限于历史擦除/面板，故定中不定高。
- 建议：改成锚定形态（如 `/^(?:这张我跳过|这条我不接)(?:[。，,；;]|$)/` 作用在 `head8` 对应的前缀片段上），或至少补两个反向断言：`"它说「这张我跳过」，我们换个说法。" → false`、`"这条我不接手，继续接下一条。" → false`。

### M4 — `OUTCOME_SAMPLE_CHARS` 测试是假阳性断言，截断行为零覆盖

- 位置：`test/refusal-retry.test.mjs:380-382`
- 问题：整条测试只断言 `Number.isInteger(OUTCOME_SAMPLE_CHARS) && > 0`。它完全没碰到 `trackChunk` 的 `sample.full` 截断逻辑，也没验证「超 8000 字后判定基于哪一段」。配合 H1，目前连 `sample.text` 长度是否等于流出正文都没人测。
- 建议：补一条流式用例：先吐 8000+ 字正常正文、末尾放拒绝句，断言 `onOutcome` 的 `chars` 恰为 8000 且 outcome 不因末尾拒绝句翻转；另断言短流的 `chars` 严格等于正文长度（这条能同时钉死 H1）。

## 低

### L1 — 文档里的测试条数与磁盘对不上

- 位置：`release-notes.md:10`、`:20`；`docs/lessons/patrol-2026-11-18.md:124`
- 问题：git 计数 `refusal-retry.test.mjs` 21→27（**+6**）、`request-shape.test.mjs` 36→37（+1），合计新增 **7** 条；实测两文件 `node --test` = 64 tests（27+37）。release notes 写「新增回归测试 9 条（content 形状 1、审计标签 5、图像规则 1，其余为断言更新）」——分解自身也只有 7，9 无来源；patrol `:124` 写「refusal-retry +5 条（27 pass）」也与 21+5≠27 矛盾。
- 建议：统一改成「新增 7 条（content 形状 1、交付判定 5、图像规则 1）+ 2 处断言更新」，并让 patrol 的 `+6` 与 27 pass 对齐。

### L2 — 巡检文档仍把本地版本写成 1.2.5

- 位置：`docs/lessons/patrol-2026-11-18.md:4`、`:26`
- 问题：表格写「本地 `package.json` version `1.2.5`」、正文写「本地 1.2.5 吸收的是…」，但同文件 `:118-125` 的落地记录和磁盘 `package.json:3` 都是 1.2.6。属发版前快照没回填。
- 建议：表格行改为 1.2.6，或标注「巡检开始时为 1.2.5，本轮落地后为 1.2.6」。

### L3 — `judgeDelivery` 的两个边界启发式偏松

- 位置：`lib/refusal-retry.js:78-81`
- 问题：`/;\s*$/` 会把散文里以英文分号结尾的行算成代码行；围栏切换只认 `^```` ，模型输出被截断、结尾围栏缺失时，之后全部非空行都计进 `lines`。
- 建议：分号特征限定在非 CJK 上下文（如要求行内同时有 `=`/`(`）；未闭合围栏时按 `inFence = false` 收尾或单独记 `fenceUnclosed` 字段供审计。

### L4 — `withNudge` 在 system content 数组首块非 text 时 directive 静默丢失

- 位置：`lib/refusal-retry.js:117-118`
- 问题：数组分支只给 `block.type === "text"` 的块追加 nudge。若 system content 首块是 image/其他类型，加固指令不进任何块，重发等于原样重发。这是旧实现沿用下来的形状，本次 block 数组化没有引入但也没修；测试 `:196-199` 只验证"非文本块不改写"，没验证"nudge 确实落在某个 text 块上"。
- 建议：数组分支找不到 text 块时显式 `unshift({ type:"text", text })`，或至少在 `onRetry` 里记 `nudgeApplied:false` 便于观测。

## 最值得修的一条

**H1。** `lib/refusal-retry.js:233` 和 `:256` 把缓冲阶段已采样过的 chunk 又采样一遍，让 `chars` 翻倍、`steps` 从 3 变 5，正好把 thin 闸门跨过去 —— 这批改动存在的理由就是抓「先铺垫再推脱」和「重试后空转」，而重复计数会让这两类假成功重新变回 `recovered`。改法只有两行（去掉那两处 `trackChunk(chunk)`，保留 drain 的采样），配一条「`onOutcome.chars === 流出正文长度`」的断言即可钉死；全绿测试目前盖不到它，因为现有用例的正文都短到翻倍也不影响 outcome。
