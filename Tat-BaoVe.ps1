# Tat-BaoVe.ps1 - TAT che do bao ve mailbox (nhan 2 click khi khong can).
# Dung watcher dang chay + tat 2 task (mo may lai se khong tu chay nua).
# Khong dung tien trinh OMP dang lam viec.
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.CommandLine -like "*Watch-Mailbox.ps1*" -and
    $_.CommandLine -notlike "*-NoLogo*" -and
    $_.CommandLine -notlike "*Watchdog-Mailbox.ps1*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Import-Module ScheduledTasks
Disable-ScheduledTask -TaskName "MailboxWatcher" | Out-Null
Disable-ScheduledTask -TaskName "MailboxWatchdog" | Out-Null
(New-Object -ComObject Wscript.Shell).Popup("Da TAT bao ve mailbox. Mo may lai se khong tu chay.", 10, "Bao ve mailbox", 64) | Out-Null
