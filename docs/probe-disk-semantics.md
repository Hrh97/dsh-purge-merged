# 运行时探针（--probe）与磁盘级读取的教训

## 探针是什么

吸收自 kingcharleslzy-ai/dsh-purge Community 的 probe 思路：往注入文件
（`prompt-inject.md`）尾部装一个带唯一 token 的小块
（`<!-- dsh-purge:probe-begin -->- probe: DSPROBE-xxxxxxxx<!-- dsh-purge:probe-end -->`），
重启 dsh 后问模型「逐字复述 DSPROBE 开头的那一行」——答得出 =
「写盘 → 模型看到」整条链路通；答不出 = 宿主没吃到注入文件（转 `--doctor`）。

## 真机暴露的 bug 与根因

第一版 arm/clear/status 全走 `core.readPromptInjectFileSync()`。真机上出现：

- 每次 `--probe --status` 都重新 arm 一个新 token（`active` 从未为 true）；
- `--probe --clear` 打「没有探针可摘」，但 state 文件照样被 unlink；
- arm 后裸读磁盘 `DSPROBE` 在，`readPromptInjectFileSync` 读出来没有。

对照实验钉死根因：**`readPromptInjectFileSync` 返回的不是磁盘现状**。
同一文件三个长度：磁盘字节数 25127、`fs.readFileSync` 原文 21193 字符、
`readPromptInjectFileSync` 20968 字符——它经过 `normalizeOverride` /
托管正文路径（CRLF 归一、正文替换），探针块不在托管正文里就被「吃掉」。
arm 写盘成功、下次读被替换回托管正文 → status 认为 token 不在 → 重 arm；
clear 读到的文本本来就没探针 → `cleared:false` →「没有探针可摘」。

## 修法：探针一律直读/直写磁盘

`lib/probe.js` 新增 `readRawInject(dshHome)`（`fs.readFileSync(findOverrideFile(dshHome))`），
`armProbe` / `clearProbe` / `probeStatus` 三处全部改用它；`clearProbe` 落盘
绕过 `saveOverrideContent` 直接 `writeFileSync`（探针本来就是磁盘级验证，
托管写入器的 normalize 语义与之矛盾）。修后真机全链路：
arm → status「探针已在注入文件里」→ clear「✓ 探针已摘除」。

## 教训

1. **任何「磁盘上到底写了什么」的验证，必须直读原始字节**，不能借道
   有 normalize/托管语义的读取函数——否则你验证的是托管正文，不是宿主吃到的文件。
2. 探针块被宿主重写冲掉是**预期内的自愈行为**（正文若仍是出厂默认，下次
   `--apply` 整体回写托管正文，探针随之消失）——但 status/clear 的判定必须
   基于磁盘，才能区分「宿主冲掉了」和「我们读错了」。
3. 对照实验顺序：先裸读磁盘确认写盘成功，再对比封装读取函数的返回——
   两个长度对不上就能立刻锁定是读取路径的问题，而不是写入路径。
