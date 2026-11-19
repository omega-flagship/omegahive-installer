# Purpose: checks Install-OmegaHive.ps1's decisions without touching WSL, the network or the browser: it dot-sources
# the installer, replaces wsl.exe, curl.exe, Start-Process, the reboot check and the reachability probe with stand-ins
# that record every call, and runs the whole flow from each state a Windows can be in (WSL off, off and needing a
# restart, declined permission, no distro, distro present, a damaged or missing release, a failed setup, the
# Start menu's -Open with and without a hive). Run it on Windows: powershell -NoProfile -File test-Install-OmegaHive.ps1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$Installer = Join-Path $PSScriptRoot 'Install-OmegaHive.ps1'
$Work = Join-Path ([IO.Path]::GetTempPath()) ('omegahive-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$Failures = 0
$Url = 'http://127.0.0.1:8700/local-signin#' + ('a' * 43)

function Check([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Host ('ok    ' + $What) } else { Write-Host ('FAIL  ' + $What) -ForegroundColor Red; $script:Failures++ }
}

# One case: a fresh copy of the installer's functions, the stand-ins over them, the state, then the flow.
function Invoke-Case {
    param([hashtable]$State, [switch]$OpenMode, [switch]$Damaged, [switch]$NoRelease)
    $sim = @{ Wsl = 'Ready'; Distros = @(); Reboot = $false; RebootAfterEnable = $false; DeclineAdmin = $false
              SetupExit = 0; Running = $false; Unreachable = $false; ImportExit = 0; PinnedFails = $false; RootExit = 0; Listening = @()
              DownloadDrops = 0; DownloadAlwaysFails = $false; SeedPartial = ''; SeedDigest = ''
              ManifestUrl = 'https://releases.ubuntu.com/26.04.2/ubuntu-26.04.2-wsl-amd64.wsl' }
    foreach ($k in $State.Keys) { $sim[$k] = $State[$k] }
    $calls = New-Object System.Collections.ArrayList
    $dir = Join-Path $Work ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $env:LOCALAPPDATA = $dir
    $result = & {
        . $Installer
        $Home_ = Join-Path $dir 'OmegaHive'
        $Open = [bool]$OpenMode
        $Release = Join-Path $dir 'omegahive.tar.gz'
        $Setup = Join-Path $dir 'omegahive-wsl.sh'
        if (-not $NoRelease) {
            Set-Content -Path $Release -Value 'release' -NoNewline
            Set-Content -Path $Setup -Value 'setup' -NoNewline
            $sum = (Get-FileHash -Algorithm SHA256 $Release).Hash.ToLower()
            if ($Damaged) { $sum = '0' * 64 }
            Set-Content -Path ($Release + '.sha256') -Value ($sum + '  omegahive.tar.gz')
        }
        $Image.Sha256 = (Get-FileHash -Algorithm SHA256 -InputStream ([IO.MemoryStream]::new([Text.Encoding]::ASCII.GetBytes('image')))).Hash.ToLower()
        if ($sim.SeedPartial) {
            $downloads = Join-Path $Home_ 'downloads'
            New-Item -ItemType Directory -Force -Path $downloads | Out-Null
            [IO.File]::WriteAllText((Join-Path $downloads 'ubuntu-wsl-amd64.wsl.part'), $sim.SeedPartial)
            $digest = $Image.Sha256
            if ($sim.SeedDigest) { $digest = $sim.SeedDigest }
            [IO.File]::WriteAllText((Join-Path $downloads 'ubuntu-wsl-amd64.wsl.part.sha256'), $digest)
        }

        function wsl.exe {
            $a = @($args)
            [void]$calls.Add('wsl ' + ($a -join ' '))
            $global:LASTEXITCODE = 0
            if ($a[0] -eq '--version') { if ($sim.Wsl -ne 'Ready') { $global:LASTEXITCODE = 1 }; return 'WSL version: 2.7.3.0' }
            if ($a[0] -eq '--list') { return $sim.Distros }
            if ($a[0] -eq '--import') { $global:LASTEXITCODE = $sim.ImportExit; if ($sim.ImportExit -eq 0) { $sim.Distros += 'OmegaHive' }; return }
            if ($a[0] -eq '--manage') { return }
            $line = $a -join ' '
            # As on a Windows where another distro's root session is running: WSL warns on stderr, the command succeeds.
            if ($line -like '*-u root*') {
                Write-Error "wsl: Failed to start the systemd user session for 'root'. See journalctl for more details."
                $global:LASTEXITCODE = $sim.RootExit
                return
            }
            if ($line -like '*OMEGAHIVE_SETUP*') { [void]$calls.Add('ports ' + $env:OMEGAHIVE_WINDOWS_PORTS); $global:LASTEXITCODE = $sim.SetupExit; return }
            if ($line -like '*omegahive.sh status') { if ($sim.Running) { return 'running on http://127.0.0.1:8700 (pid 7)' } else { return 'not running' } }
            if ($line -like '*omegahive.sh signin-url') { return $Url }
            throw ('unexpected wsl.exe call: ' + $line)
        }
        function curl.exe {
            $a = @($args)
            [void]$calls.Add('curl ' + $a[-1])
            [void]$calls.Add('curl-args ' + ($a -join ' '))
            $out = $a[[array]::IndexOf($a, '--output') + 1]
            if ($sim.PinnedFails -and $a[-1] -eq $Image.Url) { $global:LASTEXITCODE = 22; return }
            $offset = 0
            if (($a -contains '--continue-at' -or $a -contains '-C') -and (Test-Path $out)) {
                $offset = (Get-Item $out).Length
            }
            [void]$calls.Add('resume-at ' + $offset)
            if ($sim.DownloadAlwaysFails -or $sim.DownloadDrops -gt 0) {
                $sim.DownloadDrops--
                [IO.File]::WriteAllText($out, 'im')
                $global:LASTEXITCODE = 18
                return
            }
            if ($offset -gt 0) { [IO.File]::AppendAllText($out, 'image'.Substring($offset)) }
            else { [IO.File]::WriteAllText($out, 'image') }
            $global:LASTEXITCODE = 0
        }
        function Invoke-RestMethod {
            [void]$calls.Add('manifest')
            return @{ ModernDistributions = @{ Ubuntu = @(@{ Name = 'Ubuntu-26.04'; Amd64Url = @{ Url = $sim.ManifestUrl; Sha256 = $Image.Sha256 } }) } }
        }
        function Start-Process {
            param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle)
            if ($Verb -eq 'RunAs') {
                [void]$calls.Add('admin ' + ($ArgumentList -join ' '))
                if ($sim.DeclineAdmin) { throw 'The operation was canceled by the user.' }
                $sim.Wsl = 'Ready'; $sim.Reboot = $sim.RebootAfterEnable
                return [pscustomobject]@{ ExitCode = 0 }
            }
            if ($WindowStyle -eq 'Hidden') { [void]$calls.Add('serve ' + ($ArgumentList -join ' ')); $sim.Running = $true; return }
            [void]$calls.Add('browser ' + $FilePath)
        }
        function Test-RebootPending { return [bool]$sim.Reboot }
        function Invoke-WebRequest { if ($sim.Unreachable) { throw 'refused' }; return 'ok' }
        function Start-Sleep { }
        function Install-Launcher { [void]$calls.Add('launcher') }
        function Remove-WslShortcuts { [void]$calls.Add('unshortcut') }
        function Get-CimInstance { throw 'no CIM in tests' }
        function Get-NetTCPConnection { $sim.Listening | ForEach-Object { [pscustomobject]@{ LocalPort = $_ } } }
        function Write-Host { param([Parameter(ValueFromRemainingArguments = $true)]$Rest) [void]$calls.Add('say ' + ($Rest -join ' ')) }

        try { Invoke-Main; 'completed' } catch { $_.Exception.Message }
    } 2>&1
    # What reached the console's error stream (a stand-in's stderr the installer let through) is kept apart.
    $errors = @($result | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $result = @($result | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    return [pscustomobject]@{ Outcome = [string]($result | Select-Object -Last 1); Calls = @($calls); Errors = $errors; Sim = $sim; Dir = $dir }
}

function Has($case, [string]$prefix) { @($case.Calls | Where-Object { $_ -like ($prefix + '*') }).Count -gt 0 }
function Count($case, [string]$prefix) { @($case.Calls | Where-Object { $_ -like ($prefix + '*') }).Count }

$c = Invoke-Case -State @{ Wsl = 'Off'; RebootAfterEnable = $true }
Check ($c.Outcome -like '*restart*') 'WSL off, turning it on needs a restart: says restart'
Check ((Count $c 'admin --install --no-distribution') -eq 1) 'WSL off: asks for the administrator once, to turn WSL on'
Check (-not (Has $c 'wsl --import')) 'WSL off and a restart owed: makes no distro'

$c = Invoke-Case -State @{ Wsl = 'Off'; DeclineAdmin = $true }
Check ($c.Outcome -like '*did not get permission*') 'permission declined: says to run again and click Yes'

$c = Invoke-Case -State @{ Wsl = 'Off' }
Check ($c.Outcome -eq 'completed') 'WSL off, turned on without a restart: carries on to the end'
Check ((Has $c 'wsl --import OmegaHive') -and (Has $c 'browser http://127.0.0.1:8700/local-signin#')) 'WSL off, turned on: makes the distro and opens the hive'

$c = Invoke-Case -State @{ Distros = @('Ubuntu') }
Check ($c.Outcome -eq 'completed') 'no hive distro: completes'
Check ((Has $c 'curl https://releases.ubuntu.com/26.04.1/') -and (Has $c 'wsl --import OmegaHive')) 'no hive distro: downloads the pinned Ubuntu image and imports it'
Check (Has $c 'wsl -d OmegaHive -u root') 'no hive distro: makes the hive user as root'
Check (Has $c 'unshortcut') 'no hive distro: removes the shell shortcut and profile WSL made for the distro'
Check (@($c.Calls | Where-Object { $_ -like '*useradd*--uid 1999*enable-linger omega*' }).Count -eq 1) 'no hive distro: the hive user gets UID 1999 and lingering'
Check (-not (Test-Path (Join-Path $c.Dir 'OmegaHive\downloads\ubuntu-wsl-amd64.wsl'))) 'no hive distro: deletes the image once imported'
Check (-not (Has $c 'say wsl: Failed to start the systemd user session') -and -not ($c.Errors -match 'systemd user session')) 'no hive distro: WSL''s root-session warning stays out of the window when the user is made'
Check ((Has $c 'serve') -and (Has $c 'launcher') -and (Has $c 'browser')) 'no hive distro: starts the hive hidden, adds the Start menu entry and opens the browser'

$c = Invoke-Case -State @{ Distros = @(); RootExit = 1 }
Check ($c.Outcome -like '*could not make its user*') 'making the hive user fails: says so'
Check (Has $c 'say wsl: Failed to start the systemd user session') 'making the hive user fails: shows what WSL said'

$c = Invoke-Case -State @{ Distros = @(); PinnedFails = $true }
Check ((Has $c 'manifest') -and (Has $c 'curl https://releases.ubuntu.com/26.04.2/ubuntu-26.04.2-wsl-amd64.wsl') -and ($c.Outcome -eq 'completed')) 'pinned image gone: takes the newer Canonical image WSL''s manifest gives'
Check (Has $c 'say Using https://releases.ubuntu.com/26.04.2/ubuntu-26.04.2-wsl-amd64.wsl instead. This image is not the one this installer pins') 'pinned image gone: says the image it takes is not pinned'

$c = Invoke-Case -State @{ Distros = @(); PinnedFails = $true; ManifestUrl = 'https://example.invalid/ubuntu-26.04.2-wsl-amd64.wsl' }
Check (($c.Outcome -like '*not an Ubuntu 26.04 image on Canonical*') -and -not (Has $c 'curl https://example.invalid') -and -not (Has $c 'wsl --import')) 'pinned image gone, manifest names another server: refuses it before downloading or importing'

$c = Invoke-Case -State @{ DownloadDrops = 2 }
Check ($c.Outcome -eq 'completed' -and (Count $c 'curl https://releases.ubuntu.com/26.04.1/') -eq 3) 'two dropped transfers: resumes the pinned image and completes'
Check ((Count $c 'resume-at 2') -eq 2 -and -not (Has $c 'manifest')) 'two dropped transfers: keeps saved bytes and does not switch images'
Check (Has $c 'curl-args --fail --location --continue-at - --speed-limit 1 --speed-time 60') 'image transfer detects a stall without imposing a whole-download deadline'

$c = Invoke-Case -State @{ SeedPartial = 'im' }
Check ($c.Outcome -eq 'completed' -and (Has $c 'resume-at 2')) 'a later installer run continues its existing partial image'

$c = Invoke-Case -State @{ SeedPartial = 'other'; SeedDigest = ('0' * 64) }
Check ($c.Outcome -eq 'completed' -and -not (Has $c 'resume-at 5')) 'an image checksum change discards bytes belonging to the previous image'

$c = Invoke-Case -State @{ DownloadAlwaysFails = $true }
Check ($c.Outcome -like '*could not be downloaded*' -and -not (Has $c 'wsl --import')) 'exhausted transfers stop setup and import nothing'
Check ((Count $c 'curl https://releases.ubuntu.com/26.04.1/') -eq 4) 'an interrupted image gets four attempts before fallback'

$c = Invoke-Case -State @{ Distros = @('OmegaHive') }
Check ($c.Outcome -eq 'completed') 'hive distro present: completes'
Check (-not (Has $c 'curl') -and -not (Has $c 'wsl --import') -and -not (Has $c 'unshortcut')) 'hive distro present: downloads, imports and removes nothing'
Check ((Count $c 'wsl -d OmegaHive -u omega --cd ~ --exec /bin/bash -c set -f') -eq 1) 'hive distro present: runs the shared setup once'

$c = Invoke-Case -State @{ Distros = @('OmegaHive'); Listening = @(8914, 8700, 445, 8700) }
Check (Has $c 'ports 445 8700 8914') 'Windows listening: every port it listens on reaches the setup once, a Code port above 8890 included'

$c = Invoke-Case -State @{ Distros = @('OmegaHive'); Running = $true }
Check (-not (Has $c 'serve') -and (Has $c 'browser')) 'hive already running: starts no second one and opens it'

$c = Invoke-Case -State @{ Distros = @('OmegaHive'); SetupExit = 1 }
Check ($c.Outcome -like '*Setup stopped*') 'setup fails: says setup stopped'
Check (-not (Has $c 'browser') -and -not (Has $c 'serve')) 'setup fails: neither starts nor opens the hive'

$c = Invoke-Case -State @{ Distros = @('OmegaHive') } -Damaged
Check ($c.Outcome -like '*damaged*') 'damaged download: says so'
Check (-not (Has $c 'wsl')) 'damaged download: touches no WSL'

$c = Invoke-Case -State @{ Distros = @('OmegaHive') } -NoRelease
Check ($c.Outcome -like '*Extract All*') 'run from inside the zip: says to unzip first'

$c = Invoke-Case -State @{ Distros = @('OmegaHive'); Unreachable = $true }
Check ($c.Outcome -like '*cannot reach*') 'hive unreachable from Windows: says so'
Check (-not (Has $c 'browser')) 'hive unreachable from Windows: spends no sign-in link on a browser'

$c = Invoke-Case -State @{ Distros = @(); ImportExit = 1; Reboot = $true }
Check ($c.Outcome -like '*restart*') 'import fails with a restart owed: says restart'

$c = Invoke-Case -State @{ Distros = @() } -OpenMode
Check ($c.Outcome -like '*not set up*') 'Start menu with no hive: says to run the installer'

$c = Invoke-Case -State @{ Distros = @('OmegaHive') } -OpenMode
Check ($c.Outcome -eq 'completed' -and (Has $c 'serve') -and (Has $c 'browser') -and -not (Has $c 'wsl -d OmegaHive -u omega --cd ~ --exec /bin/bash -c set -f')) 'Start menu: starts and opens the hive, sets nothing up'

Remove-Item -Recurse -Force $Work
Write-Host ''
if ($Failures -eq 0) { Write-Host 'all checks passed'; exit 0 } else { Write-Host ($Failures.ToString() + ' checks failed') -ForegroundColor Red; exit 1 }
