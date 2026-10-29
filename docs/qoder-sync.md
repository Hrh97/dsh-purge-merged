# Qoder CN 同步契约

Qoder 那条线的补丁（`lib/qoder/qoder-purge.mjs`）只搬一样东西：**提示词**。
它把 Qoder CN `app.asar` 里 `out/main/electronMain.js` 的三个系统提示词常量
（`main_coding` / `desktop_instructions` / `persona`）整个换成
`lib/qoder/purge-prompt.zh.md`，再把 `permissionMode` 改 `bypassPermissions`、
把 Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse 关掉。

所以「新内容同步到 qoder」= **那个 md 文件必须跟着内核提示词一起动**。
本轮之前这条只靠人记，现在有三道机械闸。

## 唯一允许的差异

`lib/qoder/purge-prompt.zh.md` 是 **生成的**，来源是 `lib/default-prompt-inject.zh.md`：

| | 内核文件 | Qoder 文件 |
| --- | --- | --- |
| 头两行 | `<|im_start|>system:<project_instructions>` + 空行 | 删掉 |
| 行尾 | CRLF | LF |
| 其余 | — | **逐字节相同** |

内核那份要伪装成对话模板塞进 transcript，所以带假 wrapper；Qoder 吃的是纯
system string，带 wrapper 反而会让模型以为自己在看一段 `system:` 标记。

## 三道闸

```sh
npm run qoder:sync      # 从内核重建 lib/qoder/purge-prompt.zh.md（幂等，无变化不写盘）
npm run qoder:check     # 只比对，漂了就 exit 1（CI / 提交前）
npm run qoder:verify    # 装好的 Qoder CN 里那个 prompt，是不是当前这份
```

`qoder:check` 由 `test/qoder-prompt-sync.test.mjs` 在 `npm test` 里自动跑，
所以内核改了 qoder 没跟 → 测试红，不用靠记。

`qoder:verify` 回答的是另一个问题，`--check` 答不了它：
`qoder-purge.mjs --check` 只会说「already patched」，因为
`/*__QODER_PURGE__*/` 标记一直在。可提示词换代之后，**活着的 asar 里还是旧文本**，
`--check` 会永远绿。

`--verify` 的做法是：拿 `.purge-orig` 原始备份，在内存里用当前提示词重跑一遍
`patchMain()`，再和活着的 asar 逐字节比。

| 退出码 | 含义 | 怎么办 |
| --- | --- | --- |
| 0 | 活的 asar 与当前提示词完全一致 | 没事 |
| 1 | 漂了（活着的是旧一代） | `node lib/qoder/qoder-purge.mjs --force` |
| 2 | 还没打过补丁 | `node lib/qoder/qoder-purge.mjs` |
| 3 | 无法证明（备份缺失 / 备份本身已打补丁） | 先 `--restore` 或重装 Qoder |

> 刻意不用「正则扫出注入的长字符串再比」。压缩后的 `electronMain.js` 里到处是长
> 转义字面量，而按 markdown 形状筛出来的字面量会在 `你不跳出来说\"` 这种转义引号处
> **被切成两半** —— 于是同一个提示词被数成「一个当前 + 一个旧版」，得出假的 stale。
> 逐字节对比重建结果没有这个问题。

## 内核改完之后的标准动作

```sh
# 1. 内核提示词改了（lib/default-prompt-inject.zh.md / .en.md）
npm run qoder:sync               # 重建 qoder 那份
npm test                         # qoder-prompt-sync 会确认没漏

# 2. 让装好的 Qoder 用上（先关 Qoder）
node lib/qoder/qoder-purge.mjs --verify          # 看是不是已经旧了
node lib/qoder/qoder-purge.mjs --force           # 从备份重建，重新打三个站点
node lib/qoder/qoder-purge.mjs --verify          # 应 exit 0
```

`--force` 会先从 `.purge-orig` 还原活着的 asar，再重打一遍 —— 所以连「上次打歪了」
也能一并修好。asar 被占用且不能改名时用 `--force-inplace`（原地流式覆盖）。

## 只管提示词，不管别的

Qoder 那边**没有**以下东西，也不打算搬：

- `lib/leaf-inject.js` 的叶子域词表 —— 那是 DSH 按会话算域路由的表，Qoder 没有 hook 点。
- `skills/redteam/` 24 个技能 —— Qoder 不读这个目录。
- `--eval` / `--lessons` / `scoped-capability` / 会话隔离 —— 全是 DSH 侧的评测与 UI 基础设施。
- `lib/core.js` 的 89 条补丁 —— 文件级改写 DSH 的包，Qoder 是另一套 app。

换句话说：**内核提示词的每一处改动都要过一遍 Qoder；其它层面的改动不用。**
判定口径就是上面那道 `qoder:check` —— 它红了就是提示词漂了，它绿着就说明 Qoder 那份
已经是当前内核的镜像。
