# 2026-11-13：更新通道断链 + 巡检脚本三个 bug

## 一、现象

每日巡检（`D:\hrh\dsh-watch\watch-upstream.mjs`）报「上游 `HunYiSage/dsh-purge` 404」。当时把它当成「上游又跑了」，实际比这严重：

1. 插件的**更新检查整条通道是死的**。`lib/update.js:12` 的 `const REPO = "YuJunZhiXue/dsh-purge"` 和 `lib/redteam/ui.js:362` 的兜底仓库名，指向的两个地址用 `api.github.com` 实测都是 **404**（`YuJunZhiXue`、`HunYiSage` 两个账号公开仓库列表为空，无重定向）。
2. `package.json` 的 `repository` / `homepage` / `bugs` / `dsh.install.{tarball,zip,git}` 和 README 里 11 条 `codeload` 安装命令，同样指向死地址 —— 新用户照 README 装会直接 404。
3. `client.js` 两处 `welcome.repo`（中英各一）也是死链。

**教训**：仓库搬迁/删库时，「更新源」是一组散在 6 个文件里的字面量，没有单一事实源。改一处不够，漏掉任何一处都是静默失效（检查更新只会报网络错误，看起来像网络问题）。

## 二、处置

统一改指 fork `Hrh97/dsh-purge-merged`（实测 `raw` / `codeload` / `api` 均 200，master 上 `package.json` 版本与本地一致）：

| 位置 | 说明 |
| --- | --- |
| `lib/update.js:12` | `REPO` 常量，更新检查/下载的唯一来源 |
| `lib/redteam/ui.js:362` | `githubRepoOf()` 的兜底返回值 |
| `package.json` | repository / homepage / bugs / `dshPurgeFork.of` / `dsh.install` 三行 |
| `client.js` | `welcome.repo` ×2（zh/en），改完跑 `npm run build:client` 重建 drill 片段 |
| `README.md` / `.zh-CN` / `.ja` | 各 11 条 codeload 命令 + `dsh://plugin/install` 的 `repo=` / `downloadUrl=` |
| `test/profile-insert.test.js` | 两个 fixture URL，避免测试里留死链 |

`dshPurgeFork.of` 保留为 `HunYiSage/dsh-purge`：那是血统记录，不是下载地址。

版本随之 `1.1.99 → 1.2.0`（行为变化：更新源换了仓库，不是纯文档修正）。

## 三、巡检脚本三个 bug（都是这次踩出来的）

### bug 1：比对基准写死 `origin/master`

origin 换成 fork 后，`origin/master` 指向我们自己的分支，漂移恒为 0，巡检会永远说「不落后」。
改成可配：`DSH_WATCH_REMOTE`（默认 `upstream-archive`）+ `DSH_WATCH_UPSTREAM_REF`（默认 `upstream-archive/master`）。fetch 也拆成 `fetchRemote(remote)`，上游那条默认不刷（https 连不上会挂满 60s），需要时用 `DSH_WATCH_FETCH_UPSTREAM=1` 打开。

### bug 2：网络整段不可达时没有熔断

本机到 `github.com:443` 会整段不通，每次 connect 卡满 21s。54 个仓逐个试 = 十几分钟空转，而且每个都被记成「网络或代理问题」，报告里 54 行同样的错误。
加 `NET_DOWN` 开关：首个 `Failed to connect / Could not connect / Connection timed out` 之后，`lsRemote` 直接返回 `"unknown"`，`api()` 直接抛 `network` 错，报告汇总成一句「本机到 github.com 不可达（N/M 未检查，不是仓库消失）」。

### bug 3（最伤）：探测失败会把基线抹成 null

`checkRepo` 在 `status === "partial"` 时 `out.head` 是空的，而写回 state 的代码无条件写 `head: r.head ?? null`。一次网络抖动就能把 56 个仓的基线全清空，下一轮所有仓都会被报成「首次记录 HEAD」，同时丢掉「是否真的变了」的判据 —— **报告看起来正常，实际比对能力已经归零**。

修法：
- partial 且无新 head 时只更新 `checkedAt`，保留 `prev` 全部字段；
- `stars` / `pushedAt` / `archived` / `branch` / `head` 一律 `?? prev.x` 兜底；
- `saveState` 写前 `copyFile` 一份 `state.json.bak`。

**当天已被抹掉 50 个基线**，从 `reports/patrol-2026-11-10.json`（带完整 `rows`）反推回填，恢复脚本 `restore-state-20261113.mjs` 留在 dsh-watch 根。恢复后 52/56 有 head，剩下 4 个是真 404。

**教训**：状态文件没有历史版本 = 一次写坏就没有退路。`state.json.bak` 的成本是一个 `copyFile`，收益是把这类事故从「不可恢复」变成「一条命令回滚」。

## 四、附带发现：MSYS 的 `CON` 垃圾文件

https 仓库 fetch 失败时，git 走 askpass 把提示写进 Windows 保留设备名 `CON`，于是在仓库根留下一个 35 字节的垃圾文件（内容就是 `Username for 'https://github.com': `）。两个仓库都中过。

- 已删；
- `.gitignore` 加 `CON` / `con`，避免它进 `git status`；
- 根因是 origin 用 https 且没凭据，换成 SSH 后不再产生。

## 五、复核清单

```bash
node --check lib/update.js && node --check lib/redteam/ui.js && node --check client.js
npm test                       # 378 pass
node --check D:/hrh/dsh-watch/watch-upstream.mjs
node -e "const s=require('D:/hrh/dsh-watch/state.json');console.log(Object.values(s.repos).filter(v=>v.head&&v.head.sha).length)"
```
