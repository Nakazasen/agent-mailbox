# Cai-Lan.ps1 - Cai (hoac go) task Task Scheduler cho 1 lane/project cua khung watcher.
# Moi project = 1 task rieng "KhungWatcher-<project>", chay Watch-Project.ps1 luc dang
# nhap, tu khoi dong lai khi sap. Go task cua project nao chi anh huong project do.
#
# Dung (tai thu muc khung\ tren may chay watcher):
#   powershell -ExecutionPolicy Bypass -File Cai-Lan.ps1 -Project youtube
#   powershell -ExecutionPolicy Bypass -File Cai-Lan.ps1 -Project youtube -Start
#   powershell -ExecutionPolicy Bypass -File Cai-Lan.ps1 -Project youtube -Remove
#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [switch]$Start,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$KhungDir = $PSScriptRoot
$TaskName = "KhungWatcher-" + $Project
$Engine = Join-Path $KhungDir "Watch-Project.ps1"
$ConfigPath = Join-Path $KhungDir ("projects\" + $Project + ".project.ps1")

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Da go task $TaskName (neu co). State/log giu nguyen trong thu muc watcher-state."
    return
}
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Khong thay cau hinh $ConfigPath" }
if (-not (Test-Path -LiteralPath $Engine)) { throw "Khong thay engine $Engine" }

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$argStr = "-NoProfile -ExecutionPolicy Bypass -File `"$Engine`" -Project $Project"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argStr
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Da cai task $TaskName (chay luc dang nhap, tu khoi dong lai khi sap)."
if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Da khoi dong task. Kiem tra log: watcher-state\<project>\watcher.log"
}
Write-Host "Trang tong quan: watcher-state\tong-quan.html (mo bang trinh duyet)."
Write-Host "Dung khan cap: tao file PAUSE trong watcher-state\<project>\ - watcher se khong mo tho nua."
