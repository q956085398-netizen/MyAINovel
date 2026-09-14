' 一键在桌面创建「工笔」快捷方式（工单 #34）：指向仓库根的 启动工笔.vbs，
' 双击即无终端启动开发模式。可重复运行，快捷方式覆盖重建。
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")

Set link = shell.CreateShortcut(desktop & "\工笔.lnk")
link.TargetPath = root & "\启动工笔.vbs"
link.WorkingDirectory = root
link.IconLocation = root & "\app\src-tauri\icons\icon.ico"
link.Description = "工笔（开发模式启动，总是最新代码）"
link.Save

MsgBox "已在桌面创建「工笔」快捷方式。", 64, "工笔"
