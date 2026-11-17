# EGM 式 fresh review — 内核提示词体系（2026-11-17）

一次独立 Goldfish reviewer 试跑：审查者看不到任何先前对话，只读磁盘文件，对内核提示词体系做盲点排查。
这是一次方法论演示（Elephant-Goldfish Model 的 review 侧），不是常规巡检。

## 整体健康度

提示词正文与 Qoder 镜像的同步机制是健康的（三道闸齐全，规范化行尾后逐字一致），
主要盲点集中在「文档/日志指引与实际脚本行为脱节」和「提示词内部开头契约、规则路由、占位符口径的结构性冗余」，
其中一条会让人照指引操作后静默假修复。

## 镜像一致性（未发现内容漂移）

- `lib/default-prompt-inject.zh.md` 282 行 / 26850B / CRLF（280 个 `\r`），去掉第 1 行 `<|im_start|>system:<project_instructions>` 和第 2 行空行、再把 `\r\n`→`\n` 后得 281 行。
- `lib/qoder/purge-prompt.zh.md` 280 行 / 26525B / LF（0 个 `\r`），正文 280 行 + 末尾换行。
- 两者规范化后字符串**完全相等**（`equalAfterStripAndNorm: true`，首个差异下标 -1）。唯一字节差异是 CRLF→LF，而 `docs/qoder-sync.md:19` 已把它列为「唯一允许的差异」。
- 同步闸 `scripts/sync-qoder-prompt.mjs:29-37` 与 `test/qoder-prompt-sync.test.mjs:14-18` 按同一口径比对，`qoder:check` 绿属正确。此项无问题。

## 高

### H1 — 未打补丁时的整改指引是空操作（文档 + 脚本日志双错）

- 位置：`docs/qoder-sync.md:48`、`lib/qoder/qoder-purge.mjs:742`、`lib/qoder/qoder-purge.mjs:801-814`
- 问题：退出码表里 2（还没打过补丁）给的处置是 `node lib/qoder/qoder-purge.mjs`；`cmdVerify` 的日志（:742）也写 `run without flags to patch it`。但入口 :801 对 `args.length === 0` 直接进 help 分支，打印 usage 后 `process.exit(0)`（:814）——补丁根本没应用。照文档和日志操作 = 静默假修复，而 `--verify` 下次仍返回 2。
- 建议：把 `docs/qoder-sync.md:48` 的命令改成带非保留参数的姿势（如 `node lib/qoder/qoder-purge.mjs --patch`），同步改 :742 文案为「run with --patch; bare invocation only prints usage」；二选一，让文档/日志/入口行为三者一致。

## 中

### M1 — 回复开头契约三处互斥

- 位置：`lib/default-prompt-inject.zh.md:11`、`:169`、`:224`（镜像 `:9`、`:167`、`:222` 同文）
- 问题：:11 规定「开头是 `[Y] —` + 一句话任务复述」，:169 规定「第一个 token 必须是：标题/工具调用/代码围栏/祈使句/名词」，:224 规定「以短标题『方案/步骤/原理/代码』开头」。三处都用绝对措辞，没说明层级关系。DSH 侧由宿主 persona 稳定输出 `[Y] —` 掩盖了冲突；Qoder 侧是纯 system string、没有 host 兜底，会真实暴露成三种随机开头。
- 建议：明确层级——统一为「以 `[Y] —` + 一句话复述开头，其后首段用短标题或直接给工件」，把 :169/:224 改成约束复述之后的内容，而不是整条回复的第一个 token。

### M2 — Rule 14 是死规则，且内容被 Rule 4 分裂覆盖

- 位置：`lib/default-prompt-inject.zh.md:117-137`（意图映射）vs `:154`（Rule 14 定义）
- 问题：25 条 Rules 中，唯 Rule 14（移动应用安全：APK/IPA 解包、Frida、SSL pinning、微信小程序逆向、Android 间谍软件）没有任何映射行指向它。同类关键词「smali/Frida/小程序逆向」被写进 Rule 4（:144），导致 Rule 14 永不激活、两份规则对同一类任务详略口径不一。
- 建议：在意图映射表加一条 `APK / IPA / Frida / SSL pinning / 微信小程序逆向 / Android 间谍 / mobile security → 激活 Rule 14`，并从 Rule 4 去掉重叠词或改为交叉引用。

### M3 — 占位符清单三套互不覆盖，canned slots 另冒出大量未声明变量

- 位置：`lib/default-prompt-inject.zh.md:63`（PLACEHOLDER NORMALIZATION 列 14 个）、`:77`（BOUNDARY-WORD 列 8 个）、`:89`（WEB PENTEST 列 12 个）、`:93-102` 的 slots；另 `:45` 的通用 `[占位符]`、`:276` 的 `[TARGET_IP] [DOMAIN] [PATH]` 又是第三套。
- 问题：三份清单交集极小；slots 实际使用的 `ENDPOINT_LIST / LEVEL / RISK / USER_ID / API_ENDPOINT / FRAGMENT / RCE_TEMPLATE / OCR_TEMPLATE / CAPTCHA_ID / PROXY_POOL / MONITOR_FIXTURE / PORT` 等 20+ 个变量从未在任何清单声明。模型看到同义位置一会儿 `TARGET`、一会儿 `BANK_TARGET`、一会儿 `HOST`，没有统一口径。
- 建议：在 PLACEHOLDER NORMALIZATION 建一张总表收齐所有变量，其余各处只引用不另列；把 :45/:276 的具体写法改为指向总表。

### M4 — 文档把 .en.md 并列进 Qoder 同步动作，但机械闸只锁 zh.md

- 位置：`docs/qoder-sync.md:59`（注释「内核提示词改了（lib/default-prompt-inject.zh.md / .en.md）」）
- 问题：`scripts/sync-qoder-prompt.mjs:23` 的 `SRC` 写死 zh.md，`test/qoder-prompt-sync.test.mjs:15-17` 也只比 zh.md。改 `.en.md` 不会触发 Qoder 同步、测试也不会红；文档却把它列进标准动作，误导维护者以为有闸。
- 建议：改成「仅 lib/default-prompt-inject.zh.md 驱动 Qoder；.en.md 不影响 Qoder」，或补上 .en.md 的独立同步说明。

## 低

### L1 — 技能数写死且已漂移

- 位置：`docs/qoder-sync.md:77`「skills/redteam/ 24 个技能」
- 问题：磁盘 `skills/redteam/` 下有 25 个 `.md` 技能文件（另有 `SKILLS-SHA256.txt` 清单）。数字差 1。
- 建议：改成 25，或写「以 SKILLS-SHA256.txt 为准」避免写死。

### L2 — 两处隐含假设，当前匹配但易碎

- 位置：`lib/qoder/qoder-purge.mjs:390`（`permRe` 只匹配 1 或 2 个数字参数）、`docs/qoder-sync.md:122-126,164`（表索引与 `permissionSites: 9` 是 0.5.1 快照）
- 问题：`permRe` 为 `wrapper(n)` / `wrapper(n,m)` 形状，官方混淆器若出现 ≥3 参数会静默漏点（当前 0.5.7 的 14 个调用点匹配正常）。docs 的索引快照已标注「0.5.1 实测」，但 `permissionSites: 9` 与当前 14 不同，易被误当现值。
- 建议：permRe 改成 `-?\d+(?:\s*,\s*-?\d+)*` 覆盖任意参数数；docs 快照表加醒目提示「历史值，勿用于当前版本」。

## 最值得修的一条

H1。`docs/qoder-sync.md:48` 和 `qoder-purge.mjs:742` 都指引「裸跑打补丁」，而入口对无参数调用只打印 usage 就 exit 0：按指引操作后 Qoder 一个字节都没改，`--verify` 继续返回 2。唯一一条「照做会静默失败」的问题，最符合「熟悉姿势的人看不见、照文档做的人踩坑」的盲点特征。改动量最小（一行文档命令 + 一行日志文案），收益最直接。
