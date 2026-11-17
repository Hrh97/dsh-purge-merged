Option Explicit
Dim sh, cmd, rc
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\hrh\GithubProgra\dsh-purge"
cmd = """C:\Program Files\nodejs\node.exe"" ""D:\hrh\GithubProgra\dsh-purge\lib\workbuddy\workbuddy-purge.mjs"" --patch"
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
