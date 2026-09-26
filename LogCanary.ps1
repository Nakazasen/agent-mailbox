# LogCanary.ps1 - 2 phut doc log tho 1 lan, du 1 tieng thi goi user quay lai.
# Chay qua Task Scheduler "LogCanary" (moi 2 phut, tu dung sau 1 tieng).
# Chi ghi 1 dong tieng Viet don gian moi lan vao theo-doi-tho.log + popup
# khi: tho dung, co dong loi moi, ticket doi trang thai, het 1 tieng.
# Khong dung tien trinh OMP, chi doc file.

$ErrorActionPreference = "SilentlyContinue"

$sessDir = "C:\Users\Admin\.omp\agent\sessions\--D--Sandbox-AIOS_habbit--"
$logFile = Join-Path $PSScriptRoot "theo-doi-tho.log"
$countFile = Join-Path $PSScriptRoot "canary_count.txt"
$taskName = "LogCanary"
$maxRuns = 30

function WLog($m) { ("[{0}] {1}" -f (Get-Date).ToString("s"), $m) | Out-File $logFile -Append -Encoding utf8 }
function Popup($t, $m) { (New-Object -ComObject Wscript.Shell).Popup($m, 20, $t, 64) | Out-Null }

$n = 0
if (Test-Path -LiteralPath $countFile) { try { $n = [int](Get-Content -LiteralPath $countFile -Raw) } catch {} }
$n++
Set-Content -LiteralPath $countFile -Value "$n" -Encoding ascii -NoNewline

if ($n -ge $maxRuns) {
    WLog "HET 1 TIENG (30 lan canh). Dung canary. Ban mo chat hoi tiep nhe."
    Popup "Bao ve mailbox" "Het 1 tieng canh tho. Mo chat hoi tiep nhe."
    try { Disable-ScheduledTask -TaskName $taskName | Out-Null } catch {}
    exit 0
}

$sess = Get-ChildItem -LiteralPath $sessDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($sess -eq $null) { WLog ("lan {0}: khong thay file log tho." -f $n); exit 0 }

$ageMin = [math]::Round(((Get-Date) - $sess.LastWriteTime).TotalMinutes, 1)
$ompCount = (Get-Process -Name "omp" -ErrorAction SilentlyContinue | Measure-Object).Count

$errs = @()
try {
    $tail = Get-Content -LiteralPath $sess.FullName -Tail 60 -ErrorAction Stop
    $errs = $tail | Where-Object {
        $_ -match '"isError":true|Traceback \(most|ModuleNotFoundError|No module named|exit code [1-9]|command .* failed|ABORT|panic:'
    } | Select-Object -Last 3
} catch {}

$line = "lan {0}: log moi nhat {1} phut truoc; tien trinh OMP: {2}; dau hieu loi: {3}" -f $n, $ageMin, $ompCount, $(if ($errs.Count -gt 0) { "CO" } else { "khong" })
WLog $line
foreach ($e in $errs) {
    $s = "$e"
    WLog ("  chi tiet: " + $s.Substring(0, [Math]::Min(220, $s.Length)))
}

if ($ompCount -eq 0) {
    Popup "Bao ve mailbox" "Tho dung roi (khong thay tien trinh OMP). Mo chat hoi tiep nhe."
} elseif ($errs.Count -gt 0) {
    Popup "Bao ve mailbox" "Thay dau hieu loi trong log tho. Mo file theo-doi-tho.log xem hoac hoi trong chat."
}
