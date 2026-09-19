' Hidden launcher for the health-check probe (Windows).
'
' Runs health-check.ps1 without any console window. Optional first argument is
' the gateway port (default 8899).

Option Explicit

Dim shell, fso, root, port, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

port = "8899"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass" & _
      " -File """ & root & "\health-check.ps1"" -Port " & port

' 0 = hidden window, True = wait for completion.
shell.Run cmd, 0, True
