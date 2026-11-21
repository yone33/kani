@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
if not exist "server.py" goto incomplete
if not exist "web\index.html" goto incomplete

set "PORTFOLIO_PY_VERSION=3.13.17"
set "PORTFOLIO_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "PORTFOLIO_ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%PORTFOLIO_ARCH%"=="AMD64" goto x64
if /i "%PORTFOLIO_ARCH%"=="ARM64" goto arm64
echo This launcher requires 64-bit Windows ^(x64 or ARM64^).
goto failed

:x64
set "PORTFOLIO_PY_ARCH=amd64"
set "PORTFOLIO_PY_HASH=9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38"
goto prepare

:arm64
set "PORTFOLIO_PY_ARCH=arm64"
set "PORTFOLIO_PY_HASH=7b58787a047b400edbfcb539aa3cdb4e2ed77bf0f22cae42b7c01cedd7dd6614"

:prepare
set "PORTFOLIO_PY_DIR=%LOCALAPPDATA%\StockPortfolio\python-%PORTFOLIO_PY_VERSION%-%PORTFOLIO_PY_ARCH%"
if exist "%PORTFOLIO_PY_DIR%\python.exe" goto launch
echo First run: downloading Python from python.org...
powershell.exe -NoLogo -NoProfile -NonInteractive -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$target = $env:PORTFOLIO_PY_DIR; $parent = Split-Path -LiteralPath $target;" ^
  "$stage = Join-Path $parent ([Guid]::NewGuid().ToString('N'));" ^
  "New-Item -ItemType Directory -Path $stage -Force | Out-Null;" ^
  "try {" ^
  "  $archive = Join-Path $stage 'python.zip'; $runtime = Join-Path $stage 'runtime';" ^
  "  $version = $env:PORTFOLIO_PY_VERSION; $arch = $env:PORTFOLIO_PY_ARCH;" ^
  "  $url = 'https://www.python.org/ftp/python/{0}/python-{0}-embed-{1}.zip' -f $version, $arch;" ^
  "  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive;" ^
  "  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $env:PORTFOLIO_PY_HASH) { throw 'Python download checksum did not match.' }" ^
  "  Expand-Archive -LiteralPath $archive -DestinationPath $runtime;" ^
  "  if (-not (Test-Path -LiteralPath (Join-Path $runtime 'python.exe'))) { throw 'Python runtime is incomplete.' }" ^
  "  try { [IO.Directory]::Move($runtime, $target) } catch { if (-not (Test-Path -LiteralPath (Join-Path $target 'python.exe'))) { throw } }" ^
  "} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }"
if errorlevel 1 goto failed

:launch
"%PORTFOLIO_PY_DIR%\python.exe" -I "%CD%\server.py" --port 8000 --open
if errorlevel 1 goto failed
popd
exit /b 0

:incomplete
echo Extract the entire ZIP before running Start-Portfolio.cmd.

:failed
echo Startup failed. Read the message above for details.
pause
popd
exit /b 1
