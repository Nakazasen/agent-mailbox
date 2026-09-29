# Bat-BaoVe-PC0575-Mot-Lan.ps1
# Chay MOT LAN tren may cong ty (KDTVN-PC0575) de bat bao ve mailbox tu dong.
# Lam 5 viec lien tiep:
#   1. Clone (hoac pull) repo Nakazasen/agent-mailbox ve D:\Sandbox\agent-mailbox
#   2. Copy config.PC0575.ps1 -> config.local.ps1
#   3. Cai 3 task chuan (MailboxWatcher / MailboxWatchdog / LogCanary),
#      tro dung mailbox-pc0575
#   4. Tat task thu cong cu AIOS_Mailbox_Watcher_pc0575 (tranh 2 watcher
#      cung poll mot mailbox -> double-launch OMP)
#   5. Chay Bat-BaoVe.ps1 (bat bao ve)
#
# Cach chay: mo PowerShell, paste:
#   powershell -ExecutionPolicy Bypass -File "D:\duong-dan\Bat-BaoVe-PC0575-Mot-Lan.ps1"

$ErrorActionPreference = "Stop"
$mbDir = "D:\Sandbox\agent-mailbox"   # doi cho nay neu muon dat repo cho khac
$mailboxDir = "docs/phieu-viec/mailbox-pc0575"

function Step([string]$msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }

# --- 1. Repo ---
Step "[1/5] Lay repo agent-mailbox"
if (Test-Path (Join-Path $mbDir ".git")) {
    Write-Host "Da co repo, dang pull main..."
    git -C $mbDir pull origin main
} else {
    Write-Host "Chua co repo, dang clone..."
    git clone https://github.com/Nakazasen/agent-mailbox.git $mbDir
    if ($LASTEXITCODE -ne 0) { throw "git clone that bai (kiem tra mang/git)" }
}
$head = (git -C $mbDir rev-parse --short HEAD).Trim()
Write-Host "HEAD hien tai: $head"
$watcher = Get-Content -LiteralPath (Join-Path $mbDir "Watch-Mailbox.ps1") -Raw
if ($watcher -notmatch 'param\(\[string\]\$MailboxDir') {
    Write-Host "CANH BAO: Watch-Mailbox.ps1 khong co param -MailboxDir. Pull lai hoac bao Muse." -ForegroundColor Yellow
} else {
    Write-Host "OK: Watch-Mailbox.ps1 co -MailboxDir."
}

# --- 2. Config ---
Step "[2/5] Copy config may cong ty"
$srcCfg = Join-Path $mbDir "config.PC0575.ps1"
$dstCfg = Join-Path $mbDir "config.local.ps1"
if (-not (Test-Path -LiteralPath $srcCfg)) { throw "Khong thay $srcCfg trong repo" }
Copy-Item -LiteralPath $srcCfg -Destination $dstCfg -Force
Write-Host "Da copy -> $dstCfg"

# --- 3. Cai task ---
Step "[3/5] Cai 3 task chuan (mailbox-pc0575)"
& powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $mbDir "Install-MailboxTasks.ps1") `
    -MailboxDir $mailboxDir
if ($LASTEXITCODE -ne 0) { throw "Install-MailboxTasks.ps1 bao loi" }
Write-Host "Da cai task."

# --- 4. Tat task thu cong cu ---
Step "[4/5] Tat task thu cong cu"
try {
    Disable-ScheduledTask -TaskName "AIOS_Mailbox_Watcher_pc0575" | Out-Null
    Write-Host "Da tat AIOS_Mailbox_Watcher_pc0575"
} catch {
    Write-Host "(khong tim thay task cu, bo qua)"
}

# --- 5. Bat bao ve ---
Step "[5/5] Bat bao ve"
& (Join-Path $mbDir "Bat-BaoVe.ps1")

# --- Kiem tra ---
Step "Kiem tra"
Get-ScheduledTask -TaskName "MailboxWatcher", "MailboxWatchdog", "LogCanary" |
    Select-Object TaskName, State | Format-Table -AutoSize
$old = Get-ScheduledTask -TaskName "AIOS_Mailbox_Watcher_pc0575" -ErrorAction SilentlyContinue
if ($old) { Write-Host ("Task cu: " + $old.State + " (phai la Disabled)") -ForegroundColor Yellow }
Write-Host ""
Write-Host "XONG. Bao ve da bat: watcher poll mailbox-pc0575 moi ~90s," -ForegroundColor Green
Write-Host "watchdog dung lai watcher khi chet, gate chong ket escalate cho-muse." -ForegroundColor Green
