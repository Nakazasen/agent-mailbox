# Install-MailboxTasks.ps1 - dang ky Task Scheduler cho vong lap giao viec (chay 1 lan, co the chay lai).
#
# Tao/cap nhat 2 task:
#   MailboxWatcher  - chay Watch-Mailbox.ps1 khi user logon, an, tu restart moi 1 phut khi loi.
#   MailboxWatchdog - chay Watchdog-Mailbox.ps1 khi logon + moi 10 phut; mo lai watcher neu thay mat.
# Yeu cau: Windows PowerShell 5.1, quyen dang ky task cho chinh user hien tai.
# Cach dung: mo PowerShell, chay: powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1

$ErrorActionPreference = "Stop"

$repoDir = $PSScriptRoot
$watcher = Join-Path $repoDir "Watch-Mailbox.ps1"
$watchdog = Join-Path $repoDir "Watchdog-Mailbox.ps1"

if (-not (Test-Path -LiteralPath $watcher)) { throw "Khong tim thay $watcher" }
if (-not (Test-Path -LiteralPath $watchdog)) { throw "Khong tim thay $watchdog" }

Import-Module ScheduledTasks -ErrorAction Stop
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
"USER=$user"

# --- Task 1: MailboxWatcher ---
$a1 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}"' -f $watcher)
$t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
$s1 = New-ScheduledTaskSettingsSet -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit 0
$p1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "MailboxWatcher" -Action $a1 -Trigger $t1 `
    -Settings $s1 -Principal $p1 `
    -Description "Poll mailbox + giam sat OMP (Watch-Mailbox.ps1). Tu restart moi 1 phut khi loi." -Force | Out-Null

# --- Task 2: MailboxWatchdog ---
$a2 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}"' -f $watchdog)
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$tRep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$s2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$p2 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "MailboxWatchdog" -Action @($a2) -Trigger @($tLogon, $tRep) `
    -Settings $s2 -Principal $p2 `
    -Description "Moi 10 phut kiem tra Watch-Mailbox.ps1, khong thay thi mo lai + ghi log." -Force | Out-Null

Get-ScheduledTask -TaskName "MailboxWatcher", "MailboxWatchdog" |
    Select-Object TaskName, State | Format-Table -AutoSize | Out-String -Width 200
"DONE"
