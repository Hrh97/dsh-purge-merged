# 第 9 面评估：`ctx.fork()` 可逆能力缝

日期：2026-10-29　结论：**采纳，但不抄 fork —— 抄它要解决的问题**

---

## 1. 结论先说

| 问题 | 答案 |
| --- | --- |
| 宿主有 `ctx.fork()` 吗 | **没有**。本机 `@deepseek-ai/cordis` **4.0.5**，`Context` 上只有 `extend` / `isolate` / `intercept` / `effect` / `fiber` |
| 那这块要不要做 | **要**。但它解决的痛点与我们原先以为的不同 |
| 原以为的收益 | 按预设/会话动态挂载能力 |
| 实际最大收益 | **`apply()` 的全或无语义** —— 现在中途失败会留半挂载 |
| 落地物 | `lib/scoped-capability.js`（`createScope` / `mountAll`）+ `test/scoped-capability.test.mjs` 12 条 |

---

## 2. 事实核对

`D:\Program Files\DSH\resources\app\dsh\node_modules\@deepseek-ai\cordis\package.json` → `"version": "4.0.5"`。

`lib/index.js` 里的内部实现（行号为该文件）：

- `:337` `register(label, hooks, callback, options)` → `return this.ctx.fiber.effect(...)`
- `:374` `listener = this.ctx.reflect.bind(listener)`
- `:918` `bind(callback)`
- `:1704` `extend(meta = {})` — 子上下文，`Object.create(getTraceable(this, this))`，父不变
- `:1723` `isolate(name, label)`
- `:1728` `intercept(name, config)`
- `:1169` `effect(execute, label = "anonymous")`

**全文 grep `fork` 无命中** → evo-harness 的 `ctx.fork()` 是它自己封装的，或来自别的 cordis 分支。照抄会直接 `TypeError`。

---

## 3. 我们的真实缺口

`lib/index.js:1644 `export function apply(ctx, config)` 之后是一长串「每项各自 `try {} catch {}`」的挂载：

- `:1653` / `:1666` / `:1696` / `:1706` / `:1775` / `:1795` / `:1968` …
- 每处都独立吞错，**没有任何一处回滚前面已装的东西**。

后果：第 N 项抛错时，第 1..N-1 项的 `agent/pre-step`、`tools/pre-execute` 钩子仍然挂着且活着。宿主看到的是「插件只生效一半」，重启后因为抛错点漂移又可能变好 —— 这是最难复现的一类现场。

这和 evo-harness 想要的能力缝是同一件事的两面：它要**能主动撤回**，我们要**失败时自动撤回**。後者是更硬的约束，所以我们先做后者。

---

## 4. 设计

`createScope(ctx, label)`：

| 语义 | 为什么 |
| --- | --- |
| **LIFO 撤回** | 后装的钩子常引用先装的资源，正序撤会先抽掉依赖 |
| **撤回不中断** | 一个坏 disposer 不能让其余全部泄漏；跑完后抛第一个错误 |
| **幂等 dispose** | 卸载路径会被多处触发（插件卸载 / 配置改 / 错误回滚） |
| **迟到 track 立刻回收** | 已 dispose 后再 `track()` 的东西就地释放，否则是静默泄漏 |
| **mount 全或无** | 只回滚**本次新增**的；之前装好的不归这次调用负责 |
| **回滚失败不覆盖原错误** | 回滚时的错误挂到 `error.rollbackError`，主错误仍是主错误 |

子上下文用 `ctx.extend()` 拿，**但注册仍走同一个 fiber**（`extend` 出来的 ctx 原型上就是父的 `fiber`）。所以：插件卸载时照样级联回收，scope 只是额外给出一层能单独撤回的边界。

`extend` 拿不到时（老宿主 / 测试桩）退化成直接用父 ctx —— 记账逻辑不依赖它。

---

## 5. 已验证行为

`node --test test\scoped-capability.test.mjs` → **12 pass / 0 fail**：

1. LIFO 逆序撤回
2. dispose 幂等（三次调用只撤一次）
3. 单个 disposer 抛错不阻断其余，第一个错误被抛出
4. mount 全或无，只回滚本次新增（上一个 mount 装的不动）
5. 宿主缺 `on()` 时 mount 干净退出
6. 已 dispose 的 scope 收到新 disposer 立刻回收
7. `track()` 返回的 disposer 可提前单独撤回，重复调用返回 `false`
8. 有 `extend` 用子上下文、没有则退回父上下文
9. `effect` 走宿主 `ctx.effect` 并带 `label:name` 前缀
10. `provide` 转发到宿主并随 scope 撤回
11. `mountAll` 成功返回 scope、失败不返回且不留残留监听
12. 回滚失败不覆盖原错误（`error.rollbackError`）

---

## 6. 迁移建议（刻意保守）

**别做的事**：不要为了「架构漂亮」把现有 66 处 `ctx.*` 调用全改写成 scope。现有代码是逐项 `try/catch` 的**降级优先**风格 —— 某一层挂了其余照跑，这是它能在各种残缺 profile 上活下来的原因。全面 scope 化会把「降级」变成「全撤」，反而更脆。

**值得改的三处**，按收益排序：

1. **`lib/index.js` 的 `apply()` 主挂载段** —— 把「同一组语义相关的挂载」各自包成一个 `scope.mount()`。粒度按组（钩子组 / 服务组 / 定时器组），不是按单条。这样某组失败只撤该组，其余组照跑，比现在的「全留半挂」和「全撤」都好。
2. **`lib/redteam/index.js:463 apply()`** —— 演练台是一个天然的作用域：预设被切走时整组能力应该一起消失。现在靠各处 `isRedteamSession()` 分支，属于「装了但空转」。
3. **`lib/request-shape.js:537`** —— 这里已经有正确的可逆模式（`ctx.effect(() => () => { 逐个 handle() })`），可以原样换成 `scope.effect`，纯粹为了让「层被关掉」这条路也只有一份实现。

**不要改的**：`lib/core.js` 的 89 条补丁。那是**文件级**改写，跟 ctx 能力缝完全无关 —— 它们靠 `--revert` 的字节级备份回滚，不靠 fiber。把这两套混起来谈会误判风险面。

---

## 7. 与 evo-harness 的差异（避免误读）

| 维度 | evo-harness | 我们 |
| --- | --- | --- |
| 目标 | 自动搜索更好的脚手架（进化） | 手工积累 + 可逆 |
| 可编辑面 | 8 面（prompt/guardrails/memory/tool guidance/skills/scripts/subagents/plugins） | 提示词内核 5 段 + 请求体整形 + 补丁 |
| 候选评估 | 匿名行为对比，无 ground-truth verifier | `--eval` 双臂配对 + McNemar + 良性代价 |
| 回滚单位 | `ctx.fork()` 子上下文 | `createScope()` 记账（同 fiber，多一层边界） |
| 我们不该抄的 | 自动进化循环 | 我们没有可信的自动判优信号，自动改提示词会漂 |

乘下的可抄项：它的 `CanonicalLesson` 蒸馏格式（把一次获胜的改动压成一条可复用规则）。这个和第 ④ 项的 `--eval` 天然接得上 —— 评测出显著差异后，把差异点蒸馏成一条记录。**留作第 10 面的候选，本次不做。**
