@echo off
rem Run dsh-remote-agent on Windows (foreground).
setlocal EnableExtensions
set "DIR=%~dp0"

set "NODE_CMD="
where node >nul 2>nul && set "NODE_CMD=node"
if not defined NODE_CMD (
  if exist "%ProgramFiles%\DeepSeek Harness\tools\node\node.exe" set "NODE_CMD=%ProgramFiles%\DeepSeek Harness\tools\node\node.exe"
)
if not defined NODE_CMD (
  if exist "%ProgramFiles(x86)%\DeepSeek Harness\tools\node\node.exe" set "NODE_CMD=%ProgramFiles(x86)%\DeepSeek Harness\tools\node\node.exe"
)
if not defined NODE_CMD (
  if exist "%USERPROFILE%\DeepSeek Harness\tools\node\node.exe" set "NODE_CMD=%USERPROFILE%\DeepSeek Harness\tools\node\node.exe"
)
if not defined NODE_CMD (
  if exist "D:\deepseek harness\tools\node\node.exe" set "NODE_CMD=D:\deepseek harness\tools\node\node.exe"
)
if not defined NODE_CMD (
  echo [ERROR] Node.js not found. Install Node 18+, or put node.exe on PATH.
  echo The DeepSeek Harness installer bundles Node under tools\node\node.exe.
  exit /b 1
)

"%NODE_CMD%" "%DIR%dsh-remote-agent.mjs" %*
