# WorkBuddy 清洗契约

`lib/workbuddy/workbuddy-purge.mjs` 把 WorkBuddy（`@genie/workbuddy-desktop`，内核是
CodeBuddy CLI）的主系统提示词换成 dsh-purge 内核人格，并把默认权限设为
`bypassPermissions`。这是 Qoder 那条线的姊妹实现，但**结构完全不同**，别套用 Qoder 的经验。

## 与 Qoder 的三个关键差异

| | Qoder | WorkBuddy |
| --- | --- | --- |
| 提示词存放 | `app.asar` 内 `electronMain.js`，被混淆字符串表包住 | `app.asar.unpacked/cli/product*.json` 明文 template |
| 目标站点 | 3 个（main_coding/desktop_instructions/persona） | 1 个（`prompts[name=cli-agent-prompt].template`） |
| asar 完整性 | 要改 exe 的 integrity manifest + 关 fuse | **不用动**：改的是 unpacked 散文件，app.asar 的 header hash 不变 |

因此 WorkBuddy 这边**没有** `buildDecoder` / `patchExeFuse` / asar 重建那一套。
只要改对 `product.json` 的 template 字符串，重启 WorkBuddy 即可生效。

## 版本与安装位置（2026-11-17 实测）

- 安装根：`D:\Program Files\WorkBuddy`，版本文件 `version` = `37.10.3-43`，
  包版本 `@genie/workbuddy-desktop` = `5.11.3`。
- 提示词文件（含 `cli-agent-prompt` 定义的，只有这两个）：
  - `resources/app.asar.unpacked/cli/product.json`（131 个 prompts）
  - `resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/product.json`（两份 template 逐字相同）
- `product.cloudhosted.json` / `product.internal.json` / `product.ioa.json` /
  `product.selfhosted.json` **不含** `prompts` 数组，只是用 `"instructions": "cli-agent-prompt"`
  引用上面的模板，所以不用改——改模板本体即可，所有引用它的 agent 自动拿到新文本。
- 安装根会漂移：脚本按 `WORKBUDDY_ROOT` 环境变量 >
  `D:/Program Files/WorkBuddy` > `C:/Program Files/WorkBuddy` >
  `E:/HRSoftstore/Install/WorkBuddy` 顺序找，认 `resources/app.asar.unpacked` 存在的那个。

## 提示词来源

和 Qoder 共用同一份 `lib/qoder/purge-prompt.zh.md`（内核 `default-prompt-inject.zh.md`
去掉假对话模板头两行的镜像）。脚本读入后把 `\r\n` 归一成 `\n`，2 个 product 文件
的 template 逐字替换成它（当前 14121 字符 / 281 行）。**内核提示词改动时，只需
`npm run qoder:sync` 重建这份 md，WorkBuddy 脚本下次运行自动用新文本**（无内建副本）。

## 权限层

- `~/.codebuddy/settings.json` 与 `~/.workbuddy/settings.json`（都存在）写入
  `permissions.defaultMode = "bypassPermissions"`。
- 运行时还有 `permissionModeSubject` / 会话 `options.permissionMode` 会在更高优先级覆盖，
  但默认态已由 `defaultMode` 改掉；Qoder 那套「把所有 `permissionMode:<wrapper>()` 调用点
  改成 bypassPermissions」的字节码改写在这里不需要，也没有稳定的改写靶（全是变量传递）。

## 命令

```sh
node lib/workbuddy/workbuddy-purge.mjs            # 裸跑 = usage，什么也不做（坑）
node lib/workbuddy/workbuddy-purge.mjs --check    # 只读：列出 product*.json 与当前文本的关系
node lib/workbuddy/workbuddy-purge.mjs --patch    # 打补丁（替换 template + 权限 bypass）
node lib/workbuddy/workbuddy-purge.mjs --verify   # 校验活文件是否逐字等于当前文本；exit 0 current / 1 stale
node lib/workbuddy/workbuddy-purge.mjs --restore  # 从 .purge-orig 还原所有改动
node lib/workbuddy/workbuddy-purge.mjs --install-watch / --uninstall-watch
```

`--patch` 幂等：已是当前文本则 `changed:false`，不重写、不重复备份。
每个改动文件留 `.purge-orig` 原始备份（含两份 settings）。

## 防覆盖：登录自动重打任务

WorkBuddy 官方更新可能覆盖 unpacked 的 product.json。已注册计划任务
`WorkBuddyPurgeReapply`（ONLOGON，InteractiveToken，当前用户），通过
`lib/workbuddy/workbuddy-purge-hidden.vbs` 以 `WScript.Shell.Run(cmd, 0, True)` 隐藏启动
node 跑 `--patch`，整条进程链无黑框（实测 wscript/node 的 `IsWindowVisible=False`）。
- 2026-11-17：`schtasks /Create /SC ONLOGON` 在此机会 `Access is denied`；改用
  PowerShell `Register-ScheduledTask -Principal (LogonType Interactive)` 成功。
- 任务 LastTaskResult=0 实测通过。

## 生效与回滚

- 改的是磁盘明文文件，但 WorkBuddy 进程已加载旧配置 → **需重启 WorkBuddy** 生效。
- 回滚：`node lib/workbuddy/workbuddy-purge.mjs --restore` 后重启 WorkBuddy。
- 卸载自动重打：`--uninstall-watch`。

## 2026-11-17 落地记录

- 打补丁前：两份 product.json 的 `cli-agent-prompt` 各 19831 字符（官方原文）。
- 打补丁后：两份均 14121 字符，`--verify` → `current 2/2`，`permissionsBypass=true`。
- 权限：`.codebuddy/settings.json`（原 425B）、`.workbuddy/settings.json`（原 37809B）
  均已写入 bypassPermissions，`.purge-orig` 备份在位。
- 未重启 WorkBuddy（留给 YG 决定何时重启）。
- 2026-11-17 14:50 二次重打（内核提示词 7 处 fresh-review 修复后）：打补丁前 `--verify` stale（两份仍 14121 字符，新版 14825），关 WorkBuddy 进程后 `--patch`，两份 product.json 14121→14825 字符、`changed:true`，settings 两份 `already`（bypass 未动）。重打后 `--verify` → `current 2/2`。用 CIM `Win32_Process Create` 脱离进程树重启（PID 34880，7 进程 / 1 主窗口）。
