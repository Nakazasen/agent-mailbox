# Install-MailboxTasks.ps1 - dang ky Task Scheduler cho vong lap giao viec (chay 1 lan, co the chay lai).
#
# Che do B (3 tho song song, khong ghi de viec nhau - moi tho 1 mailbox):
#   omp      -> MailboxWatcher / MailboxWatchdog            -> docs/phieu-viec/mailbox
#   agy      -> MailboxWatcher-agy / MailboxWatchdog-agy    -> docs/phieu-viec/mailbox-agy
#   opencode -> MailboxWatcher-opencode / MailboxWatchdog-opencode -> docs/phieu-viec/mailbox-opencode
#   LogCanary (chung, 1 task) - doc log tho moi 2 phut.
# Yeu cau: Windows PowerShell 5.1, quyen dang ky task cho chinh user hien tai.
# Cach dung:
#   powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1
#   powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1 -Workers omp,agy,opencode
#   powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1 -Workers agy -AgyModel claude-sonnet-5-5-medium
# May cong ty: ... -File Install-MailboxTasks.ps1 -MailboxDir "docs/phieu-viec/mailbox-pc0575"
#   (MailboxDir chi ap dung cho tho omp; agy/opencode tu them hau to -agy/-opencode.)

param(
    [string]$MailboxDir = "docs/phieu-viec/mailbox",
    [string[]]$Workers = @("omp"),
    [string]$AgyModel = "gemini-3.8-flash-high",
    [string]$OpenCodeModel = "opencode/muse-spark-1.3-contributor-free",
    [string]$OpenCodeVariant = "xhigh"
)

$ErrorActionPreference = "Stop"

$repoDir = $PSScriptRoot
$watcher = Join-Path $repoDir "Watch-Mailbox.ps1"
$watchdog = Join-Path $repoDir "Watchdog-Mailbox.ps1"

$canary = Join-Path $repoDir "LogCanary.ps1"

if (-not (Test-Path -LiteralPath $watcher)) { throw "Khong tim thay $watcher" }
if (-not (Test-Path -LiteralPath $watchdog)) { throw "Khong tim thay $watchdog" }
if (-not (Test-Path -LiteralPath $canary)) { throw "Khong tim thay $canary" }

Import-Module ScheduledTasks -ErrorAction Stop
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
"USER=$user"

function Get-MailboxForWorker([string]$w, [string]$base) {
    if ($w -eq "omp") { return $base }
    if ($base -match "-pc0575$") { return ($base + "-" + $w) }
    return ($base -replace "/mailbox$", ("/mailbox-" + $w))
}
function Get-TaskSuffix([string]$w) {
    if ($w -eq "omp") { return "" } else { return "-" + $w }
}

$installedWatcher = @()
$installedWatchdog = @()
# Chuan hoa danh sach tho: chiu ca "omp,agy,opencode" (1 chuoi, khi goi qua powershell -File)
# lan array that @("omp","agy","opencode".
$WorkerList = @()
foreach ($x in $Workers) { foreach ($y in ([string]$x -split '[,\s;]+')) { if ($y -ne "") { $WorkerList += $y } } }
if ($WorkerList.Count -eq 0) { $WorkerList = @("omp") }
foreach ($raw in $WorkerList) {
    $w = $raw.ToLower()
    if ($w -ne "omp" -and $w -ne "agy" -and $w -ne "opencode") { Write-Warning "Bo qua tho la: $raw"; continue }
    $sfx = Get-TaskSuffix $w
    $mbx = Get-MailboxForWorker $w $MailboxDir
    $watcherName = "MailboxWatcher$sfx"
    $dogName = "MailboxWatchdog$sfx"

    $wArgs = '-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}" -MailboxDir "{1}" -Worker {2}' -f $watcher, $mbx, $w
    if ($w -eq "agy") { $wArgs += (' -AgyModel "{0}"' -f $AgyModel) }
    if ($w -eq "opencode") { $wArgs += (' -OpenCodeModel "{0}"' -f $OpenCodeModel); if ($OpenCodeVariant) { $wArgs += (' -OpenCodeVariant "{0}"' -f $OpenCodeVariant) } }
    $dArgs = '-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}" -MailboxDir "{1}" -Worker {2}' -f $watchdog, $mbx, $w
    if ($w -eq "agy") { $dArgs += (' -AgyModel "{0}"' -f $AgyModel) }
    if ($w -eq "opencode") { $dArgs += (' -OpenCodeModel "{0}"' -f $OpenCodeModel); if ($OpenCodeVariant) { $dArgs += (' -OpenCodeVariant "{0}"' -f $OpenCodeVariant) } }

    # --- Watcher ---
    $a1 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $wArgs
    $t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
    $s1 = New-ScheduledTaskSettingsSet -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit 0
    $p1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $watcherName -Action $a1 -Trigger $t1 `
        -Settings $s1 -Principal $p1 `
        -Description ("Poll mailbox + giam sat tho {0} ({1}). Tu restart moi 1 phut khi loi." -f $w, $mbx) -Force | Out-Null

    # --- Watchdog ---
    $a2 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $dArgs
    $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
    $tRep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $s2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $p2 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $dogName -Action @($a2) -Trigger @($tLogon, $tRep) `
        -Settings $s2 -Principal $p2 `
        -Description ("Moi 10 phut kiem tra Watch-Mailbox {0}, khong thay thi mo lai." -f $w) -Force | Out-Null

    "OK: $watcherName + $dogName -> $mbx"
    $installedWatcher += $watcherName
    $installedWatchdog += $dogName
}

# --- LogCanary (chung 1 task) ---
$a3 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File "{0}"' -f $canary)
$t3 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$s3 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$p3 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "LogCanary" -Action $a3 -Trigger $t3 `
    -Settings $s3 -Principal $p3 `
    -Description "2 phut doc log tho 1 lan, den khi nhan Tat." -Force | Out-Null

$allNames = @() + $installedWatcher + $installedWatchdog + @("LogCanary")
$existing = Get-ScheduledTask | Where-Object { $allNames -contains $_.TaskName } | Select-Object TaskName, State
if ($existing) { $existing | Format-Table -AutoSize | Out-String -Width 200 }
# Mac dinh de TAT: mo may khong tu chay. Can dung thi chay Bat-BaoVe.ps1 / Chon-BaoVe.ps1.
foreach ($n in $allNames) { try { Disable-ScheduledTask -TaskName $n | Out-Null } catch {} }
"DONE (mac dinh: TAT - dung Bat-BaoVe.ps1 / Chon-BaoVe.ps1 khi can dung)"
