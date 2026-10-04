# Watchdog-Mailbox.ps1 - canh Watch-Mailbox.ps1, chay moi 10 phut qua Task Scheduler.
#
# Nhiem vu duy nhat: neu khong thay powershell nao dang chay Watch-Mailbox.ps1
# thi mo lai (an, WindowStyle Hidden) va ghi log. Khong popup, khong lam phien OMP.
# Task "MailboxWatchdog" goi file nay. Xem HUONG-DAN-WATCHER.md.
# $AUTO_LAUNCH trong Watch-Mailbox.ps1 giu $false mac dinh (chi popup, khong tu mo OMP).
# -MailboxDir phai khop voi task MailboxWatcher (mặc định "docs/phieu-viec/mailbox").

param(
    [string]$MailboxDir = "docs/phieu-viec/mailbox",
    [string]$Worker = "omp",
    [string]$AgyModel = "gemini-3.8-flash-high",
    [string]$OpenCodeModel = "opencode/muse-spark-1.3-contributor-free"
)

$ErrorActionPreference = "SilentlyContinue"

$watcherPath = Join-Path $PSScriptRoot "Watch-Mailbox.ps1"
$w = $Worker.ToLower()
if ($w -ne "omp" -and $w -ne "agy" -and $w -ne "opencode") { $w = "omp" }
$mailboxTag = Split-Path $MailboxDir -Leaf
if ($mailboxTag -eq "mailbox") { $mailboxTag = "" } else { $mailboxTag = "-" + $mailboxTag }
if ($w -ne "omp") { $mailboxTag = "$mailboxTag-$w" }
$logFile     = Join-Path $PSScriptRoot ("watchdog{0}.log" -f $mailboxTag)

function Write-Log($msg) {
    ("[{0}] {1}" -f (Get-Date).ToString("s"), $msg) | Out-File $logFile -Append -Encoding utf8
}

if (-not (Test-Path -LiteralPath $watcherPath)) {
    Write-Log ("LOI: khong tim thay {0}, bo qua." -f $watcherPath)
    exit 1
}

$running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -like "*Watch-Mailbox.ps1*" -and $_.CommandLine -notlike "*Watchdog-Mailbox.ps1*" -and $_.CommandLine -like ("*" + $MailboxDir + "*") }

if ($running) {
    $pids = ($running | Select-Object -ExpandProperty ProcessId) -join ","
    Write-Log ("OK: watcher dang chay (PID {0})." -f $pids)
    exit 0
}

Write-Log "MISS: khong thay watcher, dang mo lai."
$argList = @("-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $watcherPath, "-MailboxDir", $MailboxDir, "-Worker", $w)
if ($w -eq "agy") { $argList += @("-AgyModel", $AgyModel) }
if ($w -eq "opencode") { $argList += @("-OpenCodeModel", $OpenCodeModel) }
Start-Process -FilePath "powershell.exe" `
    -ArgumentList $argList `
    -WorkingDirectory $PSScriptRoot
Write-Log "RESTART: da go lenh mo lai watcher."
