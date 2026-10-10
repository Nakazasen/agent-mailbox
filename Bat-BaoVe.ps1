# Bat-BaoVe.ps1 - LOI VAO CHINH de goi tho (nhan 2 click).
# Khong tham so -> mo UI Chon-BaoVe.ps1 (4 che do: omp / agy / opencode / phoi hop).
# Co -Mode -> bat thang khong UI (dung cho script/tu dong).
#   powershell -ExecutionPolicy Bypass -File Bat-BaoVe.ps1 -Mode all
#   powershell -ExecutionPolicy Bypass -File Bat-BaoVe.ps1 -Mode agy
param(
    [string]$Mode = "",
    [string]$AgyModel = "",
    [string]$OpenCodeModel = "",
    [string]$OpenCodeVariant = ""
)
$ErrorActionPreference = "SilentlyContinue"
$ui = Join-Path $PSScriptRoot "Chon-BaoVe.ps1"
if (Test-Path -LiteralPath $ui) {
    if ($Mode -ne "") {
        $cargs = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $ui, "-Mode", $Mode)
        if ($AgyModel -ne "") { $cargs += @("-AgyModel", $AgyModel) }
        if ($OpenCodeModel -ne "") { $cargs += @("-OpenCodeModel", $OpenCodeModel) }
        if ($OpenCodeVariant -ne "") { $cargs += @("-OpenCodeVariant", $OpenCodeVariant) }
        & powershell @cargs
    } else {
        & powershell -ExecutionPolicy Bypass -NoProfile -File $ui
    }
    exit 0
}
# Du phong: khong thay UI thi bat kieu cu (omp).
Import-Module ScheduledTasks
Enable-ScheduledTask -TaskName "MailboxWatcher" | Out-Null
Enable-ScheduledTask -TaskName "MailboxWatchdog" | Out-Null
Enable-ScheduledTask -TaskName "LogCanary" | Out-Null
Remove-Item -LiteralPath (Join-Path $PSScriptRoot "canary_count.txt") -Force -ErrorAction SilentlyContinue
try { Start-ScheduledTask -TaskName "MailboxWatcher" } catch {}
try { Start-ScheduledTask -TaskName "LogCanary" } catch {}
(New-Object -ComObject Wscript.Shell).Popup("Da BAT bao ve mailbox. May se tu canh ticket + doc log tho.", 10, "Bao ve mailbox", 64) | Out-Null
