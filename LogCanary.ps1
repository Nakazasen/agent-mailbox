# LogCanary.ps1 - 2 phut doc log tho 1 lan, canh den khi user nhan Tat-BaoVe.
# Chay qua Task Scheduler "LogCanary" (moi 2 phut, vo han).
# Chi ghi 1 dong tieng Viet don gian moi lan vao theo-doi-tho.log + popup
# khi: tho dung, co dong loi moi hon lan bao truoc.
# Khong dung tien trinh OMP, chi doc file.

$ErrorActionPreference = "SilentlyContinue"

$sessDir = "C:\Users\Admin\.omp\agent\sessions\--D--Sandbox-AIOS_habbit--"
$logFile = Join-Path $PSScriptRoot "theo-doi-tho.log"
$countFile = Join-Path $PSScriptRoot "canary_count.txt"
$taskName = "LogCanary"
$localCfg = Join-Path $PSScriptRoot "config.local.ps1"
if (Test-Path -LiteralPath $localCfg) { . $localCfg }

function WLog($m) { ("[{0}] {1}" -f (Get-Date).ToString("s"), $m) | Out-File $logFile -Append -Encoding utf8 }
function Popup($t, $m) { (New-Object -ComObject Wscript.Shell).Popup($m, 20, $t, 64) | Out-Null }

$n = 0
if (Test-Path -LiteralPath $countFile) { try { $n = [int](Get-Content -LiteralPath $countFile -Raw) } catch {} }
$n++
Set-Content -LiteralPath $countFile -Value "$n" -Encoding ascii -NoNewline

$sess = Get-ChildItem -LiteralPath $sessDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($sess -eq $null) { WLog ("lan {0}: khong thay file log tho." -f $n); exit 0 }

$ageMin = [math]::Round(((Get-Date) - $sess.LastWriteTime).TotalMinutes, 1)
$ompCount = (Get-Process -Name "omp" -ErrorAction SilentlyContinue | Measure-Object).Count

$errs = @()
try {
    $tail = Get-Content -LiteralPath $sess.FullName -Tail 60 -ErrorAction Stop
    $markPat = '"isError":true|Traceback \(most|ModuleNotFoundError|No module named|exit code [1-9]|ABORT|panic:'
    foreach ($tl in $tail) {
        $jo = $null
        try { $jo = $tl | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $txt = ""
        try {
            foreach ($ci in $jo.message.content) {
                if ($ci.text) { $txt += " " + [string]$ci.text }
            }
        } catch { continue }
        if ($txt -match $markPat) { $errs += $tl }
    }
    $errs = $errs | Select-Object -Last 3
} catch {}

$line = "lan {0}: log moi nhat {1} phut truoc; tien trinh OMP: {2}; dau hieu loi: {3}" -f $n, $ageMin, $ompCount, $(if ($errs.Count -gt 0) { "CO" } else { "khong" })
WLog $line
foreach ($e in $errs) {
    $s = "$e"
    WLog ("  chi tiet: " + $s.Substring(0, [Math]::Min(220, $s.Length)))
}

if ($ompCount -eq 0) {
    Popup "Bao ve mailbox" "Tho dung roi (khong thay tien trinh OMP). Mo chat hoi tiep nhe."
} else {
    if ($errs.Count -gt 0) {
        $sigFile = Join-Path $PSScriptRoot "canary_errsig.txt"
        $maxTs = 0
        foreach ($e in $errs) {
            $m = [regex]::Match("$e", '"timestamp":"?([^",}]+)"?')
            if ($m.Success) {
                $v = $m.Groups[1].Value
                try {
                    if ($v -match '^\d+$') { $ts = [int64]$v }
                    else { $ts = [int64]([DateTimeOffset]([datetime]$v)).ToUnixTimeMilliseconds() }
                    if ($ts -gt $maxTs) { $maxTs = $ts }
                } catch {}
            }
        }
        $old = 0
        if (Test-Path -LiteralPath $sigFile) { try { $old = [int64]((Get-Content -LiteralPath $sigFile -Raw).Trim()) } catch {} }
        if ($maxTs -gt $old) {
            Set-Content -LiteralPath $sigFile -Value "$maxTs" -Encoding ascii -NoNewline
            Popup "Bao ve mailbox" "Thay dau hieu loi MOI trong log tho. Mo file theo-doi-tho.log xem hoac hoi trong chat."
        } else {
            WLog "  (loi cu da bao, khong nhac lai)"
        }
    }
    if (($n % 5) -eq 0) {
        $lastThink = ""; $lastTool = ""
        try {
            $tail2 = Get-Content -LiteralPath $sess.FullName -Tail 30 -ErrorAction Stop
            foreach ($tl in $tail2) {
                try { $jo = $tl | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                try {
                    foreach ($ci in $jo.message.content) {
                        if ($ci.type -eq "thinking" -and $ci.thinking) { $lastThink = [string]$ci.thinking }
                        if ($ci.type -eq "toolCall" -and $ci.name) {
                            $lastTool = [string]$ci.name
                            try {
                                $ab = ($ci.arguments | ConvertTo-Json -Compress -Depth 2)
                                $lastTool += " " + $ab.Substring(0, [Math]::Min(100, $ab.Length))
                            } catch {}
                        }
                    }
                } catch {}
            }
        } catch {}
        if ($lastThink -ne "") { $lastThink = $lastThink.Substring(0, [Math]::Min(150, $lastThink.Length)) }
        $sum = "Tho dang lam (bao 10 phut/lan). Nghi gan nhat: {0}. Viec moi nhat: {1}." -f $lastThink, $lastTool
        WLog ("  tom tat: " + $sum)
        Popup "Tho dang lam gi" $sum
    }
}
