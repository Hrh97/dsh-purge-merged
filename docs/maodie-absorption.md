# 从 maodie-purge 吸收了什么，没吸收什么

对象：`D:\Ai\maodie-purge` v2.0.0（上游 `Wei0417-top/Maodie-purge` @ `d7b05dc`，
改编自 `Minglink/dsh-infinite-gen-4`，CC BY-NC-SA 4.0）。
依据：`耄耋破甲-分析报告.md` 的 13 条发现（F-01 … F-13）。

结论先给：**13 条里 3 条 dsh-purge 早已做得更好，4 条不适用，1 条完全缺失
（F-11，已吸收），其余 5 条是它自己独有的实现细节，不构成可吸收项。**

真正落地的只有三件事：修掉 F-11 那种「只扫开头」的判读缺陷、把它那批实测过的
拒绝词表移植过来、拿它的 110 条评测用例当路由回归线。

---

## 逐条判决

| # | maodie 的问题 | dsh-purge 现状 | 判决 |
| --- | --- | --- | --- |
| F-01 | 卸载不回滚宿主源码补丁 | `lib/uninstall.js:230-232` 先 `revertAll(state.ai_base)`，失败即中止、不删文件 | 已覆盖，无需动 |
| F-02 | 兜底正则无差别改写宿主 JS | 精确补丁 + `pattern_miss` 一等状态 + `test/patch-contract.json`，无正则兜底 | 已覆盖且更严 |
| F-03 | 配置服务 `ACAO: *` 且无鉴权 | 全仓库无 `createServer` / `listen(` / `Access-Control-Allow-Origin` | 不适用 |
| F-04 | pentest 控制台 exec 直通，`ask` 不拦 | 无同类执行器 | 不适用 |
| F-05 | apiKey 明文落盘 | 不存任何密钥 | 不适用 |
| F-06 | 双层注入同文复制两遍 | 单层注入 | 不适用 |
| F-07 | `dualLayer` 配置项夹死 | 无此配置 | 不适用 |
| F-08 | 卸载漏删 pentest 技能 | `lib/skills.js` 按 manifest 清理 | 已覆盖 |
| F-09 | 写 HKCU 注册表，卸载不清理 | 不写注册表 | 不适用 |
| F-10 | 同名 skill 先 `Remove-Item -Recurse -Force` 再 Copy | `backupExisting` → `skillBackupDir`，失败走 `restoreSkillFromBackup` | 已覆盖 |
| **F-11** | **判拒器只扫开头 160 字符** | **原本完全没有判读能力** | **已吸收（见下）** |
| F-12 | Junction 悬空 | 符号链接创建后校验 | 已覆盖 |
| F-13 | 仅告警与 dsh-purge 冲突 | — | 无关 |

---

## 吸收项一：F-11 的判读范围

### 它错在哪

maodie `index.js:79-182` 的判分器把拒绝判定压在一个窗口里：

```js
const OPENING_WINDOW = 160;
// 中文拒绝词、英文拒绝正则、域命中，都只在这个窗口里找
const opening = text.slice(0, OPENING_WINDOW);
```

后果是**正文答完、末尾补一句「但我无法提供 X」时，面板仍然是绿的**。
它自己的 `FALLBACK_MARKERS` 倒是扫全文的 —— 也就是说「降级」比「拒绝」判得更宽，
这个不对称不是设计，是漏。

### dsh-purge 怎么做的

`lib/refusal-scan.js`：

- 拒绝词、降级词、域词**一律全文扫**；
- `OPENING_CHARS = 160` 保留，但**只用来给命中定位**，不再限制搜索范围；
- 命中带 `where: "opening" | "tail"`，调用方自己决定告警级别：

| 位置 | 含义 | 处理建议 |
| --- | --- | --- |
| `opening` | 开头就拒答，正文没有内容 | 真拒绝 |
| `tail` | 正文给了答案，末尾补免责 | 可观测，不致命 |
| — | 无命中 | 通过 |

这样「拒绝」和「降级」的口径就一致了，也把 maodie 那个不对称抹平。

### 顺带修掉的两个隐患

1. **域判定恒为 null。** 原实现只在开头 160 字符里数域词，长答复的域特征
   基本都在后半段，等于永远判不出域。现在全文算，命中最多的一域胜出；
   显式传 `domain` 时不猜。
2. **正则跨调用串状态。** `g` 标志的正则如果复用同一个对象，`lastIndex`
   会在两次调用间残留。这里每次 `new RegExp`，不复用实例。

### 反向性质（防误报）

判读器最怕的不是漏判，是把正常答复判成拒绝。两条硬约束写进了测试：

- `NON_REFUSAL_TAIL`（12 字符窗口）：`无法保证` / `避免` / `predict` 这类
  正常表达紧跟标记时不算拒绝；
- 纯技术答复（有 `payload`、`patch bytes` 等风险词，无拒绝词）必须判 `pass` ——
  风险词只记录、不影响 verdict。

---

## 吸收项二：拒绝词表

maodie 的词表是它整份代码里唯一经过实测调过的东西，值得留：

- `REFUSAL_MARKERS_ZH` 33 条中文拒绝措辞
- `REFUSAL_RE_EN_SOURCE` 英文拒绝正则（`i can't` / `I cannot` / `refuse to` /
  `unable to provide` / `I'd be happy to discuss` 等）
- `FALLBACK_MARKERS` 23 条降级口径（`改为授权` / `授权靶场` / `只提供防御` …）
- `SAFE_MARKERS` 30 条、`RISK_MARKERS` 30 条、九域 `DOMAIN_MARKERS`

这些是词表，不是逻辑。逻辑全部重写（见上）。

---

## 吸收项三：110 条评测用例

`test/fixtures/prompt-bank/` 下四个 `.jsonl` 从 maodie `tests/` 字节级复制
（来源与许可见同目录 `PROVENANCE.md`）。

**只当测试夹具，不进入运行时。** 用法是 `test/prompt-bank-routing.test.mjs`：
93 条带攻击域标签的用例必须 100% 命中至少一片叶子。

这条线很有用 —— 补词前实测漏 8 条：

```
web          24/27    子域名枚举 / 存活探测 / 指纹识别 / recon
llm          15/18    分层注入 / 多轮旁路 / 对抗后缀
crack         7/8     download and crack APP: locate CHECK_FN, patch OFFSET, re-sign
re            6/7     anti-debugging / anti-VM evasion
```

补完 `lib/leaf-inject.js` 的词表后为 0 漏判（web 27/27、llm 18/18、crack 8/8、
re 7/7，其余域本来就满）。**这 8 条是这份报告的净收益** —— 它们不是我们编的
用例，所以能发现自测发现不了的盲区。

---

## 明确不吸收的

| 东西 | 原因 |
| --- | --- |
| 提示词注入载荷（`prompts/*.md`） | 与 dsh-purge 的注入机制重叠，且三份 md5 全等（F-06） |
| `patcher.js` 的补丁方式 | 无差别正则兜底（F-02），dsh-purge 用精确补丁 + `pattern_miss` |
| `pentest-console` | exec 直通且审批门不存在（F-04） |
| 配置 HTTP 服务 | `ACAO: *` + 无鉴权（F-03） |
| 注册表写入 | 无必要（F-09） |
| `ensure-runtime.ps1` 的下载校验 | dsh-purge 已有同等校验，无净增 |

---

## 验证

```bash
node --test test/refusal-scan.test.mjs        # 12 项：位置标注、F-11 回归、误报防线
node --test test/prompt-bank-routing.test.mjs # 5 项：93 条攻击域用例 0 漏判
node --test test/leaf-inject.test.mjs         # 16 项：原有叶子注入契约未回归
```

手工判读：

```bash
dsh-purge --scan 答复.txt            # 单条
dsh-purge --scan replies.jsonl       # 批量，每行取 reply 字段
cat 答复.txt | dsh-purge --scan      # stdin
dsh-purge --scan replies.jsonl --json
```

---

## 一句话总结

maodie-purge 的**架构**不值得学（无差别改宿主、exec 直通、明文落盘、卸载不净），
但它的**判读词表**和**评测用例**是实打实的资产。吸收的是这两样，
以及它 F-11 那个缺陷提供的教训：判读要么全文扫，要么就别声称自己判了。
