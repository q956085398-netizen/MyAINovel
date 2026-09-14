' 启动工笔（工单 #34，docs/spec/启动与分发.md）：无终端窗口跑开发模式
' （npm run tauri dev）——代码总是最新，代价是冷启动要等增量编译
' （数秒~数十秒，首次更久），窗口没出来不是卡死。
' 提示窗会在最长 20 秒后自动消失；应用窗口照常在编译完成后出现。
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root & "\app"

' 0 = 隐藏控制台窗口；False = 不等它结束（应用窗口独立出现）
shell.Run "cmd.exe /c npm run tauri dev", 0, False

shell.Popup _
  "正在启动工笔（开发模式，总是最新代码）。" & vbCrLf & _
  "冷启动需等增量编译：数秒到数十秒，首次更久。" & vbCrLf & _
  "本提示会自动消失，应用窗口稍后出现。", _
  20, "工笔 · 正在启动", 64
