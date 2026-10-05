# Install-RemoteAccess.ps1 - dung server opencode dieu khien tu xa qua Tailscale.
#
# Lam idempotent: chay lai bat cu luc nao cung cho 1 instance sach (khong
# chong doi server cu/moi giu port nhu loi restart-999 da gap).
#   powershell -ExecutionPolicy Bypass -File Install-RemoteAccess.ps1
#   powershell -ExecutionPolicy Bypass -File Install-RemoteAccess.ps1 -Port 4100 -Password "doi-toi"
#
# Yeu cau: da cai + login Tailscale (co IP 100.x). Khong can admin.
# Khong dung cham task/tho mailbox. Mat khau nam local, khong commit.

param(
    [int]$Port = 4100,
    [string]$Password = ""
)

$ErrorActionPreference = "Stop"

$serveDir = Join-Path $env:USERPROFILE ".opencode-serve"
$pwFile = Join-Path $serveDir "password.txt"
$ipFile = Join-Path $serveDir "tailscale-ip.txt"
$starter = Join-Path $serveDir "Start-OpencodeServe.ps1"
$logFile = Join-Path $serveDir "serve.log"
$taskName = "OpencodeServe"

# --- 1. Tim IP Tailscale (bat buoc login truoc) ---
$tip = ""
$tsPath = ""
try { $tsPath = (Get-Command tailscale.exe -ErrorAction Stop).Source } catch {}
foreach ($c in @($tsPath, "C:\Program Files\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) {
    if ($c -ne "" -and (Test-Path -LiteralPath $c)) {
        try { $tip = (& $c ip -4 2>$null | Select-Object -First 1).Trim() } catch {}
        if ($tip -ne "") { break }
    }
}
if ($tip -eq "" -or $tip -notlike "100.*") { throw "Chua co IP Tailscale (100.x). Cai + login Tailscale truoc." }
"TAILSCALE IP=$tip"

# --- 2. Tim shim opencode ---
$shim = ""
foreach ($c in @("$env:APPDATA\npm\opencode.ps1", "C:\Users\Admin\AppData\Roaming\npm\opencode.ps1")) {
    if (Test-Path -LiteralPath $c) { $shim = $c; break }
}
if ($shim -eq "") {
    $oc = Get-Command opencode -ErrorAction SilentlyContinue
    if ($oc) { $shim = $oc.Source }
}
if ($shim -eq "") { throw "Khong tim thay opencode (npm). Cai opencode-ai truoc." }
"SHIM=$shim"

# --- 3. Mat khau: uu tien -Password > file cu > sinh moi ---
New-Item -ItemType Directory -Path $serveDir -Force | Out-Null
if ($Password -ne "") { $pw = $Password }
elseif (Test-Path -LiteralPath $pwFile) { $pw = (Get-Content -LiteralPath $pwFile -Raw -Encoding ascii).Trim() }
else {
    Add-Type -AssemblyName System.Web | Out-Null
    $pw = [System.Web.Security.Membership]::GeneratePassword(24, 6)
}
if ($pw -eq "") { throw "Mat khau rong." }
Set-Content -LiteralPath $pwFile -Value $pw -Encoding ascii -NoNewline
Set-Content -LiteralPath $ipFile -Value $tip -Encoding ascii -NoNewline

# --- 4. Viet starter (single-instance: port co server that cua minh thi thoi) ---
$starterContent = @'
# Start-OpencodeServe.ps1 (tu sinh boi Install-RemoteAccess.ps1 - khong sua tay).
$ErrorActionPreference = "SilentlyContinue"
$dir = Split-Path $MyInvocation.MyCommand.Definition -Parent
$pwFile = Join-Path $dir "password.txt"
$ipFile = Join-Path $dir "tailscale-ip.txt"
$logFile = Join-Path $dir "serve.log"
$pw = (Get-Content -LiteralPath $pwFile -Raw -Encoding ascii).Trim()
$tip = (Get-Content -LiteralPath $ipFile -Raw -Encoding ascii).Trim()
$port = __PORT__
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$pw"))
try {
    $r = Invoke-WebRequest -Uri ("http://{0}:{1}/session" -f $tip, $port) `
        -Headers @{"Authorization" = "Basic $basic"} -TimeoutSec 10
    if ($r.StatusCode -eq 200) {
        "[$(Get-Date -Format s)] server that dang chay, khong mo them." | Out-File $logFile -Append -Encoding utf8
        exit 0
    }
} catch {}
$env:OPENCODE_SERVER_PASSWORD = $pw
$shim = "__SHIM__"
"[$(Get-Date -Format s)] serve ${tip}:${port}" | Out-File $logFile -Append -Encoding utf8
& powershell -NoProfile -ExecutionPolicy Bypass -File $shim serve --hostname $tip --port $port --print-logs 2>&1 |
    Out-File $logFile -Append -Encoding utf8
'@
$starterContent = $starterContent.Replace("__PORT__", "$Port").Replace("__SHIM__", $shim)
Set-Content -LiteralPath $starter -Value $starterContent -Encoding utf8

# --- 5. Don stack cu TRUOC (tat task chong hoi sinh + kill wrapper/serve) ---
# Chi dung process serve (khong dung worker `run` cua mailbox).
try { Disable-ScheduledTask -TaskName $taskName | Out-Null } catch {}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.CommandLine -like "*Start-OpencodeServe*") -or
    ($_.CommandLine -like "*opencode*serve*")
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 5

# --- 6. Dang ky task (giong ho task mailbox: logon + tu restart khi loi) ---
Import-Module ScheduledTasks -ErrorAction Stop
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$a = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}"' -f $starter)
$t = New-ScheduledTaskTrigger -AtLogOn -User $user
$s = New-ScheduledTaskSettingsSet -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit 0
$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $t `
    -Settings $s -Principal $p `
    -Description "Server opencode dieu khien tu xa qua Tailscale (chi lang nghe IP tailnet)." -Force | Out-Null
Enable-ScheduledTask -TaskName $taskName | Out-Null
Start-ScheduledTask -TaskName $taskName | Out-Null
Start-Sleep -Seconds 18

# --- 7. Kiem chung: khong pass -> 401, dung pass -> 200, dung 1 instance ---
try { Invoke-WebRequest -Uri ("http://{0}:{1}/session" -f $tip, $Port) -TimeoutSec 15 | Out-Null; throw "MAT: khong pass ma van vao duoc!" } catch [System.Net.WebException] { "OK: khong pass -> 401 (co auth)." }
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$pw"))
$r = Invoke-WebRequest -Uri ("http://{0}:{1}/session" -f $tip, $Port) -Headers @{"Authorization" = "Basic $basic"} -TimeoutSec 20
"OK: dung pass -> HTTP " + $r.StatusCode
$n = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*opencode*serve*" }).Count
"Serve process dem duoc: $n (du kien 1 wrapper + 1 server)"
"URL dien thoai: http://${tip}:${Port}"
"MAT KHAU (luu vao dien thoai): $pw"
"DONE"
