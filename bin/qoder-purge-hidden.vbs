' qoder-purge-hidden.vbs — 无窗口运行 Qoder purge 补丁（原登录任务 qoder-purge.cmd --auto）。
' 等价原 cmd：node "<root>\lib\qoder\qoder-purge.mjs" --auto %*
' sh.Run 第二参数 0 = SW_HIDE；True = 等待退出以记录 LastTaskResult。
Option Explicit
Dim sh, cmd, rc
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\hrh\GithubProgra\dsh-purge"
cmd = """C:\Program Files\nodejs\node.exe"" ""D:\hrh\GithubProgra\dsh-purge\lib\qoder\qoder-purge.mjs"" --auto"
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
