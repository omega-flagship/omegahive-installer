@echo off
rem Purpose: the file a person double-clicks on Windows: runs Install-OmegaHive.ps1 from the omegahive folder beside it
rem (the release zip's layout) or from this folder (the repository's), then keeps the window open to read.
setlocal
set "PS1=%~dp0omegahive\Install-OmegaHive.ps1"
if not exist "%PS1%" set "PS1=%~dp0Install-OmegaHive.ps1"
if not exist "%PS1%" (
  echo This copy of Install Omega has nothing beside it. Unzip the download first: right-click it, choose
  echo Extract All, then double-click Install Omega in the folder that makes.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
pause
