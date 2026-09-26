# Bat-BaoVe.ps1 - BAT che do bao ve mailbox (nhan 2 click khi can dung).
# Mo 3 task, chay watcher + chim canh log ngay. Cong tac giu nguyen qua
# cac lan mo may cho den khi ban chay Tat-BaoVe.ps1.
$ErrorActionPreference = "SilentlyContinue"
Import-Module ScheduledTasks
Enable-ScheduledTask -TaskName "MailboxWatcher" | Out-Null
Enable-ScheduledTask -TaskName "MailboxWatchdog" | Out-Null
Enable-ScheduledTask -TaskName "LogCanary" | Out-Null
Remove-Item -LiteralPath (Join-Path $PSScriptRoot "canary_count.txt") -Force -ErrorAction SilentlyContinue
try { Start-ScheduledTask -TaskName "MailboxWatcher" } catch {}
try { Start-ScheduledTask -TaskName "LogCanary" } catch {}
(New-Object -ComObject Wscript.Shell).Popup("Da BAT bao ve mailbox. May se tu canh ticket + doc log tho.", 10, "Bao ve mailbox", 64) | Out-Null
