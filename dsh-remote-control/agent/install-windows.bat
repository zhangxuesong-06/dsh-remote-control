@echo off
rem Install dsh-remote-agent on Windows:
rem   copy agent -> %USERPROFILE%\dsh-remote-agent
rem   create start-agent.bat (auto node detection)
rem   create scheduled task "DSH Remote Agent" (run at logon) and start it now
rem Optional args are forwarded to the agent (e.g. install-windows.bat --port 5200 --token xxx)
setlocal EnableExtensions EnableDelayedExpansion

set "DIR=%~dp0"
set "INSTALL_DIR=%USERPROFILE%\dsh-remote-agent"
set "PORT=5188"
set "FORWARD_ARGS="

rem Parse --port from forwarded args (rest passed through verbatim).
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="--port" (
  set "PORT=%~2"
  shift
  shift
  goto parse
)
set "FORWARD_ARGS=!FORWARD_ARGS! %~1"
shift
goto parse
:parsed

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
  echo [ERROR] Node.js not found. Install Node 18+, or run the DeepSeek Harness installer first.
  echo The DeepSeek Harness installer bundles Node under tools\node\node.exe.
  exit /b 1
)

echo [1/4] Installing agent files to %INSTALL_DIR% ...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%DIR%dsh-remote-agent.mjs" "%INSTALL_DIR%\dsh-remote-agent.mjs" >nul
copy /Y "%DIR%run-windows.bat" "%INSTALL_DIR%\run-windows.bat" >nul

echo [2/4] Writing start-agent.bat ...
> "%INSTALL_DIR%\start-agent.bat" echo @echo off
>> "%INSTALL_DIR%\start-agent.bat" echo "%NODE_CMD%" "%INSTALL_DIR%\dsh-remote-agent.mjs" --port %PORT%%FORWARD_ARGS%

echo [3/4] Creating scheduled task "DSH Remote Agent" (run at logon) ...
schtasks /Create /F /TN "DSH Remote Agent" /TR "\"%INSTALL_DIR%\start-agent.bat\"" /SC ONLOGON /RL LIMITED >nul
if errorlevel 1 (
  echo [WARN] Could not create scheduled task. Run this script as the current user,
  echo        or start manually with: "%INSTALL_DIR%\run-windows.bat"
) else (
  echo        Task created. Starting it now ...
  schtasks /Run /TN "DSH Remote Agent" >nul
)

echo [4/4] Firewall rule for TCP port %PORT% ...
net session >nul 2>&1
if not errorlevel 1 (
  netsh advfirewall firewall delete rule name="DSH Remote Agent" >nul 2>&1
  netsh advfirewall firewall add rule name="DSH Remote Agent" dir=in action=allow protocol=TCP localport=%PORT% >nul
  echo        Firewall rule added (admin mode).
) else (
  echo [WARN] Not running as administrator; firewall rule skipped.
  echo        On another PC you must allow inbound TCP %PORT% manually, or use a VPN.
)

echo.
echo Done. Agent files: %INSTALL_DIR%
echo If no token was passed, the agent generated one on first start and saved it to:
echo   %INSTALL_DIR%\agent-token.txt
echo Use that token when adding this machine in the harness plugin (remote_machine_add).
endlocal
