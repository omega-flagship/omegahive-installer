# Purpose: one double-click on Windows sets up the person's own hive and opens it in their default browser signed in
# as its owner, the Windows twin of install/macos/Install OmegaHive.command. The hive runs in a WSL 2 distro of its
# own, named OmegaHive, imported from a pinned Ubuntu image, with the Mac installer's own setup steps run inside it
# (OMEGAHIVE_FRONT=windows); Windows keeps it running under a hidden wsl.exe and opens its one-time sign-in link.
# Run again from the same release it only starts the hive and opens it; from another release it refreshes the code in
# place, keeping the hive's data, settings and port. With -Open (the Start menu's OmegaHive) it starts and opens the
# installed hive and sets nothing up.
#
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has. Native arguments never carry a double quote
# (5.1 passes them unescaped); Windows paths reach WSL through WSLENV's /p translation instead.
param([switch]$Open)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$ProgressPreference = 'SilentlyContinue'

$Distro = 'OmegaHive'
$LinuxUser = 'omega'
$LinuxUid = '1999'
# Everything on the Windows side: the distro's disk (wsl\), the image while it downloads, this launcher and its logs.
$Home_ = Join-Path $env:LOCALAPPDATA 'OmegaHive'
$Here = $PSScriptRoot
$Release = Join-Path $Here 'omegahive.tar.gz'
$Setup = Join-Path $Here 'omegahive-wsl.sh'
# The Ubuntu image the distro is made from, pinned by address and sha256 as WSL's own distribution manifest lists it
# (DistributionInfo.json in microsoft/WSL). Canonical drops older point releases from its servers (24.04.1's image is
# gone from all three of its addresses), so when this address fails the manifest's current Ubuntu-26.04 entry is used.
# That image is not pinned: it is checked only against the sha256 the manifest gives at that moment, the window says
# so, and its address must be an Ubuntu 26.04 WSL image on Canonical's release server (Fallback), so the manifest can
# choose a newer point release but not another source.
$Image = @{
    Url = 'https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-wsl-amd64.wsl'
    Sha256 = '48d56724b5c8e60f24893e83e73bbb58c60b3ca22fba3da977075420acd54104'
    MB = 400
    Manifest = 'https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json'
    ManifestName = 'Ubuntu-26.04'
    Fallback = '^https://releases\.ubuntu\.com/[0-9a-z.]+/ubuntu-26\.04(\.[0-9]+)?-wsl-amd64\.wsl$'
}
$Launcher = '/home/' + $LinuxUser + '/OmegaHive/app/install/macos/omegahive.sh'

# wsl.exe writes UTF-16 unless told otherwise; the setup inside it writes UTF-8.
$env:WSL_UTF8 = '1'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Say([string]$Text) { Write-Host $Text }

# Every stop is one exception, which the entry point at the end turns into the message and exit status 1, so a test
# can run the whole flow (test-Install-OmegaHive.ps1).
$StopTag = 'OMEGAHIVE-STOP: '
function Stop-Setup([string]$Text) { throw (New-Object System.Exception ($StopTag + $Text)) }

# wsl.exe with its output on the console (or its stdout returned when -Capture; stderr always reaches the console, so a
# failure says why), its exit status in $LASTEXITCODE. With -Quiet its whole output, stderr included, is shown only
# when it fails. Under Windows PowerShell 5.1 a native program's stderr would become a terminating error under 'Stop',
# so it runs under 'Continue'.
function Invoke-Wsl {
    param([string[]]$Arguments, [switch]$Capture, [switch]$Quiet)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Capture) { return (& wsl.exe @Arguments) }
        if ($Quiet) {
            $out = @(& wsl.exe @Arguments 2>&1)
            if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Say ([string]$_) } }
            return
        }
        & wsl.exe @Arguments
    } finally {
        $ErrorActionPreference = $saved
    }
}

# A command in the hive's distro as its user, with no shell between Windows and the program.
function Invoke-Hive {
    param([string[]]$Arguments, [switch]$Capture)
    Invoke-Wsl -Arguments (@('-d', $Distro, '-u', $LinuxUser, '--cd', '~', '--exec') + $Arguments) -Capture:$Capture
}

function Test-RebootPending {
    Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
}

# What this Windows has: 'Ready' (WSL from the Store, which knows --version), 'Off' (only Windows' built-in stub, or
# nothing), and whether a restart is still owed for features already turned on.
function Get-WslState {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return 'Off' }
    Invoke-Wsl -Arguments @('--version') -Capture | Out-Null
    if ($LASTEXITCODE -ne 0) { return 'Off' }
    return 'Ready'
}

function Get-Distros {
    $names = Invoke-Wsl -Arguments @('--list', '--quiet') -Capture
    if ($LASTEXITCODE -ne 0 -or $null -eq $names) { return @() }
    return @($names | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

# Turning WSL on is the one step that needs an administrator: Windows asks, and may want a restart after it.
function Enable-Wsl {
    Say ''
    Say 'Your hive runs in WSL (the Windows Subsystem for Linux), which is not on yet on this computer.'
    Say 'Windows will now ask for permission to turn it on (an administrator prompt). Click Yes.'
    try {
        $p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru
    } catch {
        Stop-Setup 'Windows did not get permission to turn WSL on. Double-click Install Omega again and click Yes.'
    }
    if ((Test-RebootPending) -or (Get-WslState) -ne 'Ready') {
        Stop-Setup ('WSL is turned on, and Windows needs a restart to finish it (exit ' + $p.ExitCode + ').' +
            [Environment]::NewLine + 'Restart Windows, then double-click Install Omega again: setup carries on from here.')
    }
}

# The distro: the pinned Ubuntu image, imported, since wsl --install would first make the person choose a Linux user
# name and password; then one ordinary user, named after the person for the hive's greeting, as its default.
function New-HiveDistro {
    New-Item -ItemType Directory -Force -Path (Join-Path $Home_ 'downloads') | Out-Null
    $file = Join-Path $Home_ 'downloads\ubuntu-wsl-amd64.wsl'
    $url = $Image.Url
    $sha = $Image.Sha256
    if (-not (Test-Path $file) -or (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() -ne $sha) {
        Say ''
        Say ('Downloading Ubuntu for your hive, about ' + $Image.MB + ' MB...')
        & curl.exe --fail --location --retry 3 --output ($file + '.part') $url
        if ($LASTEXITCODE -ne 0) {
            Say 'That address did not answer; asking WSL''s list of distributions for the current Ubuntu 26.04 image.'
            $entry = (Invoke-RestMethod -UseBasicParsing $Image.Manifest).ModernDistributions.Ubuntu |
                Where-Object { $_.Name -eq $Image.ManifestName } | Select-Object -First 1
            if ($null -eq $entry) { Stop-Setup 'Ubuntu could not be downloaded: check the internet connection and run Install Omega again.' }
            $url = $entry.Amd64Url.Url
            $sha = $entry.Amd64Url.Sha256.ToLower()
            if ($url -notmatch $Image.Fallback) {
                Stop-Setup ('WSL''s list names an Ubuntu image at ' + $url + ', which is not an Ubuntu 26.04 image on ' +
                    'Canonical''s release server, so it is not used. Download the newest Install Omega and run it.')
            }
            Say ('Using ' + $url + ' instead. This image is not the one this installer pins: it is checked against ' +
                'the sha256 WSL''s list gives for it.')
            & curl.exe --fail --location --retry 3 --output ($file + '.part') $url
            if ($LASTEXITCODE -ne 0) { Stop-Setup 'Ubuntu could not be downloaded: check the internet connection and run Install Omega again.' }
        }
        if ((Get-FileHash -Algorithm SHA256 ($file + '.part')).Hash.ToLower() -ne $sha) {
            Remove-Item -Force ($file + '.part')
            Stop-Setup 'The Ubuntu download was damaged. Run Install Omega again to download it again.'
        }
        Move-Item -Force ($file + '.part') $file
    }
    Say 'Making the OmegaHive Linux system (a minute)...'
    $disk = Join-Path $Home_ 'wsl'
    New-Item -ItemType Directory -Force -Path $disk | Out-Null
    Invoke-Wsl -Arguments @('--import', $Distro, $disk, $file, '--version', '2')
    if ($LASTEXITCODE -ne 0) {
        if (Test-RebootPending) {
            Stop-Setup ('Windows needs a restart to finish turning WSL on.' + [Environment]::NewLine +
                'Restart Windows, then double-click Install Omega again: setup carries on from here.')
        }
        Stop-Setup ('WSL could not start a Linux system (exit ' + $LASTEXITCODE + '). Virtualization may be off in this' +
            ' computer''s firmware settings, or WSL may need an update: run "wsl --update", then Install Omega again.')
    }
    # The person's name greets them in the hive (hive/core/localowner.py reads the account's full name).
    $name = ''
    try { $name = (Get-CimInstance Win32_UserAccount -Filter ("Name='" + $env:USERNAME + "' AND LocalAccount=True") -ErrorAction Stop).FullName } catch { }
    if (-not $name) { $name = $env:USERNAME }
    $name = ($name -replace '[^\p{L}\p{N} .\-]', '').Trim()
    if (-not $name) { $name = 'Owner' }
    $env:OMEGAHIVE_OWNER_NAME = $name
    $env:WSLENV = 'OMEGAHIVE_OWNER_NAME'
    # IFS empty: the name's spaces do not split it, and the line needs no quotes. The user's UID is 1999, not the usual
    # first 1000: WSL shares one cgroup tree between its distros, and while another distro's UID 1000 user runs, a
    # second UID 1000 systemd user manager fails to start (Device or resource busy; microsoft/WSL issue 13186), which
    # Create's systemd user unit needs. Lingering starts that manager with the distro. Root has no such choice of UID:
    # WSL asks systemd for a login session for every command it runs, root's user manager cannot start while another
    # distro's root session holds the same cgroup (user@0.service: Device or resource busy), and WSL then prints a
    # warning in the Windows display language though the command itself succeeds. So this command's output is shown
    # only when it fails.
    Invoke-Wsl -Quiet -Arguments @('-d', $Distro, '-u', 'root', '--exec', '/bin/bash', '-c',
        ('set -f; IFS=; id ' + $LinuxUser + ' >/dev/null 2>&1 || useradd --create-home --uid ' + $LinuxUid +
         ' --shell /bin/bash --comment $OMEGAHIVE_OWNER_NAME ' + $LinuxUser + '; loginctl enable-linger ' + $LinuxUser))
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'The OmegaHive Linux system could not make its user.' }
    Invoke-Wsl -Arguments @('--manage', $Distro, '--set-default-user', $LinuxUser) | Out-Null
    Remove-Item -Force $file -ErrorAction SilentlyContinue
    Remove-WslShortcuts
}

# Importing a modern Ubuntu image makes WSL add a Start menu shortcut and a Windows Terminal profile, both named
# OmegaHive, that open a Linux shell in the distro. The Start menu's OmegaHive should open the hive, so those two go.
# WSL's own registry entry for the distro names their exact files.
function Remove-WslShortcuts {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | ForEach-Object {
        $entry = Get-ItemProperty $_.PSPath
        if ($entry.PSObject.Properties['DistributionName'] -and $entry.DistributionName -eq $Distro) {
            foreach ($name in 'ShortcutPath', 'TerminalProfilePath') {
                if ($entry.PSObject.Properties[$name] -and $entry.$name -and (Test-Path -LiteralPath $entry.$name)) {
                    Remove-Item -Force -LiteralPath $entry.$name
                }
            }
        }
    }
}

function Get-HiveStatus { (Invoke-Hive -Arguments @('/bin/bash', $Launcher, 'status') -Capture) -join ' ' }

# The hive runs in the foreground of a hidden wsl.exe for as long as it runs: under WSL's defaults a distro stops
# about 15 seconds after its last wsl.exe ends, systemd services or not ([general] instanceIdleTimeout). It ends with
# Windows sign-out, as the Mac's hive ends with log-out.
function Start-Hive {
    if ((Get-HiveStatus) -like 'running*') { return }
    Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -ArgumentList @('-d', $Distro, '-u', $LinuxUser, '--cd', '~',
        '--exec', '/bin/bash', $Launcher, 'serve') | Out-Null
}

# Windows reaches the hive at 127.0.0.1 through WSL's localhost forwarding; a port Windows itself already uses, or a
# relay that stopped, shows here rather than as a browser error.
function Test-HiveReachable([string]$Port) {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 ('http://127.0.0.1:' + $Port + '/') | Out-Null
            return $true
        } catch [System.Net.WebException] {
            if ($null -ne $_.Exception.Response) { return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Open-Hive {
    Say 'Starting your hive...'
    Start-Hive
    # signin-url waits for the hive to answer (its first start checks the sandbox, up to three minutes); the link goes
    # straight to the browser and is never printed.
    $url = (Invoke-Hive -Arguments @('/bin/bash', $Launcher, 'signin-url') -Capture | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or $url -notmatch '^http://127\.0\.0\.1:(\d+)/local-signin#[A-Za-z0-9_-]{43}$') {
        Stop-Setup ('Your hive did not start. Its log is ~/OmegaHive/logs/hive.log in the OmegaHive Linux system' +
            ' (in File Explorer: Linux, OmegaHive, home, ' + $LinuxUser + ', OmegaHive, logs).')
    }
    $port = $Matches[1]
    if (-not (Test-HiveReachable $port)) {
        Stop-Setup ('Your hive is running, but Windows cannot reach it at http://127.0.0.1:' + $port + '.' +
            [Environment]::NewLine + 'Run "wsl --shutdown" in a terminal, then double-click Install Omega again.')
    }
    Start-Process $url
    Say ('Your hive is open in your browser, signed in as its owner (http://127.0.0.1:' + $port + ').')
}

# The Start menu's OmegaHive: this script, kept beside the distro's disk, run with -Open.
function Install-Launcher {
    New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
    $kept = Join-Path $Home_ 'Install-OmegaHive.ps1'
    if ($PSCommandPath -ne $kept) { Copy-Item -Force $PSCommandPath $kept }
    $programs = [Environment]::GetFolderPath('Programs')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $programs 'OmegaHive.lnk'))
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $kept + '" -Open'
    $link.WorkingDirectory = $Home_
    $link.Description = 'Open your own Omega hive'
    $link.Save()
}

# ---- the run ----

function Invoke-Main {
    $name = ''
    $nameFile = Join-Path $Here 'RELEASE_NAME'
    if (Test-Path $nameFile) { $name = ' ' + (Get-Content -TotalCount 1 $nameFile) }
    Say ('Omega hive for Windows' + $name)

    if ($Open) {
        if ((Get-WslState) -ne 'Ready' -or (Get-Distros) -notcontains $Distro) {
            Stop-Setup 'Your hive is not set up on this computer. Double-click Install Omega in the download to set it up.'
        }
        Open-Hive
        return
    }

    if (-not (Test-Path $Release) -or -not (Test-Path $Setup)) {
        Stop-Setup ('This copy of Install Omega has no hive beside it. Unzip the download first: right-click it,' +
            ' choose Extract All, then double-click Install Omega in the folder that makes.')
    }
    if ([Environment]::OSVersion.Version.Build -lt 19041) {
        Stop-Setup 'This Windows is too old for WSL 2. Windows 10 version 2004 or newer, or Windows 11, is needed.'
    }
    $want = ((Get-Content -TotalCount 1 ($Release + '.sha256')) -split '\s+')[0].ToLower()
    if ((Get-FileHash -Algorithm SHA256 $Release).Hash.ToLower() -ne $want) {
        Stop-Setup 'This download is damaged or incomplete. Download it again and unzip it.'
    }

    if ((Get-WslState) -ne 'Ready') { Enable-Wsl }
    if ((Get-Distros) -notcontains $Distro) { New-HiveDistro }

    # The shared setup, inside the distro: the release unpacked there, then install/macos/Install OmegaHive.command.
    # The hive's port, and the Code service's port the setup takes above it (pins.sh's CODE_PORT_OFFSET), must be free
    # on Windows too, where WSL's relay listens for them: every port Windows already listens on goes along, and the
    # setup skips those, so this side needs no copy of the setup's port rule.
    $busy = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
    $env:OMEGAHIVE_WINDOWS_PORTS = ($busy -join ' ')
    $env:OMEGAHIVE_RELEASE = $Release
    $env:OMEGAHIVE_SETUP = $Setup
    $env:WSLENV = 'OMEGAHIVE_RELEASE/p:OMEGAHIVE_SETUP/p:OMEGAHIVE_WINDOWS_PORTS'
    Invoke-Hive -Arguments @('/bin/bash', '-c', 'set -f; IFS=; exec /bin/bash -- $OMEGAHIVE_SETUP $OMEGAHIVE_RELEASE')
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Setup stopped (see above). Double-click Install Omega again once it is fixed: finished steps are kept.' }

    Install-Launcher
    Open-Hive
    Say ''
    Say 'Done. Your hive keeps running after you close this window, until you sign out of Windows or restart.'
    Say 'To open it again: Start menu, OmegaHive (or double-click Install Omega again).'
    Say 'To use real minds, add your AI key in the hive: You & your keys.'
}

# Run unless dot-sourced by the tests. What this window says is kept for whoever reads a failure afterwards (the setup
# inside WSL keeps its own, ~/OmegaHive/logs/install.log); no secret is ever written to it.
if ($MyInvocation.InvocationName -ne '.') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Home_ 'logs') | Out-Null
    try { Start-Transcript -Append -Path (Join-Path $Home_ ('logs\windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')) | Out-Null } catch { }
    $code = 0
    try {
        Invoke-Main
    } catch {
        $code = 1
        $text = $_.Exception.Message
        Write-Host ''
        if ($text.StartsWith($StopTag)) {
            Write-Host $text.Substring($StopTag.Length) -ForegroundColor Yellow
        } else {
            Write-Host ('Setup stopped on something unexpected: ' + $text) -ForegroundColor Yellow
            Write-Host ('Its log: ' + (Join-Path $Home_ 'logs')) -ForegroundColor Yellow
        }
        if ($Open) { Read-Host 'Press Enter to close this window' | Out-Null }
    }
    try { Stop-Transcript | Out-Null } catch { }
    exit $code
}
