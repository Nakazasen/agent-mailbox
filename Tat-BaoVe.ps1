# Tat-BaoVe.ps1 - TAT che do bao ve mailbox (nhan 2 click khi khong can).
# Dung MOI watcher dang chay (omp/agy/opencode) + tat HET task (mo may lai se khong tu chay nua).
# Khong dung tien trinh tho dang lam viec (omp/agy/opencode/node).
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*Watch-Mailbox.ps1*" -and
    $_.CommandLine -notlike "*-NoLogo*" -and
    $_.CommandLine -notlike "*Watchdog-Mailbox.ps1*"
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Import-Module ScheduledTasks
foreach ($n in @("MailboxWatcher", "MailboxWatcher-agy", "MailboxWatcher-opencode",
                 "MailboxWatchdog", "MailboxWatchdog-agy", "MailboxWatchdog-opencode",
                 "LogCanary")) {
    try { Disable-ScheduledTask -TaskName $n | Out-Null } catch {}
}
(New-Object -ComObject Wscript.Shell).Popup("Da TAT bao ve mailbox. Mo may lai se khong tu chay.", 10, "Bao ve mailbox", 64) | Out-Null
