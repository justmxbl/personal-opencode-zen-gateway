' Hidden launcher for the OpenCode Zen Gateway (Windows).
'
' wscript.exe has no console, so the scheduled task starts with no cmd or
' powershell window flash. Run(..., 0, True) waits for the gateway to exit so
' the task's restart policy still applies.

Option Explicit

Dim shell, fso, root, nodeExe, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

nodeExe = ResolveNode()
cmd = """" & nodeExe & """ """ & root & "\gateway.js"""

' 0 = hidden window, True = wait for completion.
shell.Run cmd, 0, True

Function ResolveNode()
  Dim candidates, p
  ResolveNode = "node"
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%APPDATA%\npm\node.exe") )
  For Each p In candidates
    If fso.FileExists(p) Then
      ResolveNode = p
      Exit Function
    End If
  Next
End Function
