$ErrorActionPreference = "Stop"

Write-Host "OmegaClaw Windows installer"
Write-Host "OmegaClaw runs through WSL on Windows. This installer prepares Ubuntu/WSL,"
Write-Host "then runs the same source installer used on Linux/macOS."
Write-Host ""

function Test-Command($Name) {
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command "wsl.exe")) {
    Write-Host "WSL is not installed. Starting WSL Ubuntu install."
    Write-Host "If Windows asks for a reboot, reboot and run this installer again."
    wsl --install -d Ubuntu
    exit 1
}

$distros = (wsl -l -q) -join "`n"
if ($distros -notmatch "Ubuntu") {
    Write-Host "Ubuntu is not installed in WSL. Installing Ubuntu now."
    wsl --install -d Ubuntu
    Write-Host "Open Ubuntu once to create your Linux user, then run this installer again."
    exit 1
}

$repoUrl = "https://github.com/physixCN/OmegaClaw-Core.git"
$script = @'
set -euo pipefail
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip swi-prolog nodejs npm build-essential cmake pkg-config libopenblas-dev libblas-dev liblapack-dev gfortran
mkdir -p "$HOME/OmegaClaw/repos"
if [ ! -d "$HOME/OmegaClaw/repos/OmegaClaw-Core/.git" ]; then
  git clone https://github.com/physixCN/OmegaClaw-Core.git "$HOME/OmegaClaw/repos/OmegaClaw-Core"
else
  git -C "$HOME/OmegaClaw/repos/OmegaClaw-Core" pull --ff-only
fi
python3 "$HOME/OmegaClaw/repos/OmegaClaw-Core/install/installer_common.py" --workspace "$HOME/OmegaClaw"
'@

wsl -d Ubuntu -- bash -lc $script

$desktop = [Environment]::GetFolderPath("Desktop")
$launcher = Join-Path $desktop "Start OmegaClaw.cmd"
@"
@echo off
wsl -d Ubuntu -- bash -lc "cd `$HOME/OmegaClaw && ./start-omegaclaw.sh"
pause
"@ | Set-Content -Encoding ASCII $launcher

Write-Host ""
Write-Host "OmegaClaw installer finished."
Write-Host "A launcher was created on your Desktop: $launcher"
