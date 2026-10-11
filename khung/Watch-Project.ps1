# Watch-Project.ps1 - ENGINE WATCHER CHUNG cho khung da project (agent-mailbox/khung).
# Mot tien trinh chay cho MOT project (doc cau hinh projects\<Project>.project.ps1).
# Che do "auto": thay trang thai "moi" + tho ranh -> tu mo tho theo cau hinh.
# Che do "monitor": chi doc trang thai + viet snapshot cho trang tong quan, KHONG mo tho.
#
# LUAT CUNG (bai hoc 2026-10-05/10-10, khong duoc pha):
#  - Watcher KHONG BAO GIO ghi sua file trang-thai.md / prompt.md cua tho.
#  - Khong leo thang, khong doi trang thai thay tho/dieu phoi.
#  - State/khoa/log cua watcher nam NGOAI cay git (StateRoot trong cau hinh).
#  - Loi phu (pull loi, CIM loi...) khong duoc chan viec chinh; ghi log va di tiep.
#  - Moi lan chi chay toi da so tho theo MaxConcurrent cua tung lane (mac dinh 1).
#
# Dung:
#   powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project youtube-omp
#   powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project youtube-omp -Once -DryRun
#     (-Once: chay 1 vong roi thoat; -DryRun: chi ghi log quyet dinh, khong mo tho that)
#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = "Continue"
$KhungDir = $PSScriptRoot
$ConfigPath = Join-Path $KhungDir ("projects\" + $Project + ".project.ps1")
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host "Khong thay cau hinh: $ConfigPath"
    exit 1
}
. $ConfigPath
if (-not $ProjectCfg) { Write-Host "File cau hinh khong dat `$ProjectCfg."; exit 1 }
$Cfg = $ProjectCfg

$StateRoot = $Cfg.StateRoot
if (-not $StateRoot) { $StateRoot = "D:\Sandbox\watcher-state" }
$StateDir = Join-Path $StateRoot $Cfg.Name
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$PollSeconds = 90
if ($Cfg.PollSeconds) { $PollSeconds = [int]$Cfg.PollSeconds }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}
function Add-Log([string]$Msg) {
    $line = "{0} | {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
    try { [System.IO.File]::AppendAllText((Join-Path $StateDir "watcher.log"), $line + "`r`n", $Utf8NoBom) } catch {}
    Write-Host $line
}
function Html-Enc([string]$s) {
    if (-not $s) { return "" }
    return [System.Net.WebUtility]::HtmlEncode($s)
}

# ---- Khoa 1 tien trinh cho moi project (giu suot vong doi) ----
$LockPath = Join-Path $StateDir "watcher.lock"
$LockStream = $null
try {
    $LockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    Write-Host "Project $($Cfg.Name): da co tien trinh watcher dang chay (khoa $LockPath). Thoat."
    exit 0
}

# ---- Doc trang thai 1 lane ----
function Read-LaneStatus([hashtable]$Lane) {
    $result = @{ Status = "khong-thay-file"; Ticket = ""; LastNote = ""; LatestTs = "" }
    $file = $Lane.StatusFile
    if (-not [System.IO.Path]::IsPathRooted($file)) { $file = Join-Path $Cfg.RepoDir $file }
    if (-not (Test-Path -LiteralPath $file)) { return $result }
    $text = ""
    try { $text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) } catch { return $result }

    $statusMatches = [regex]::Matches($text, '(?im)^\s*[-*]?\s*(Tr\u1EA1ng th\u00E1i|Trang thai|trang_thai)\s*:\s*`?\s*([a-zA-Z\-]+)\s*`?')
    if ($statusMatches.Count -eq 0) { $result.Status = "khong-doc-duoc"; return $result }

    $mode = "newest"
    if ($Lane.StatusMode) { $mode = [string]$Lane.StatusMode }
    $chosen = $null
    if ($mode -eq "first") { $chosen = $statusMatches[0] }
    elseif ($mode -eq "last") { $chosen = $statusMatches[$statusMatches.Count - 1] }
    else {
        # newest: trang thai gan nhat voi moc thoi gian moi nhat trong file thang.
        $tsMatches = [regex]::Matches($text, '20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}')
        if ($tsMatches.Count -eq 0) { $chosen = $statusMatches[$statusMatches.Count - 1] }
        else {
            $bestVal = $null; $bestPos = 0
            foreach ($m in $tsMatches) {
                $v = $m.Value -replace 'T', ' '
                if ($null -eq $bestVal -or $v -gt $bestVal) { $bestVal = $v; $bestPos = $m.Index }
            }
            $result.LatestTs = $bestVal
            $bestDist = $null
            foreach ($sm in $statusMatches) {
                $d = [Math]::Abs($sm.Index - $bestPos)
                if ($null -eq $bestDist -or $d -le $bestDist) { $bestDist = $d; $chosen = $sm }
            }
        }
    }
    $result.Status = $chosen.Groups[2].Value.Trim().ToLower()

    $tm = [regex]::Match($text, '(?im)^\s*[-*]?\s*V\u00E9 \u0111ang ch\u1EA1y\s*:\s*(.+?)\s*$')
    if ($tm.Success) { $result.Ticket = $tm.Groups[1].Value.Trim() }
    else {
        $fm = [regex]::Match($text, '(?i)file\s+(ve-[^)\s]+\.md)')
        if ($fm.Success) { $result.Ticket = $fm.Groups[1].Value }
    }
    # Ghi chu moi nhat = dong ghi_chu chua moc thoi gian lon nhat; khong co thi dong ghi_chu dau tien.
    $noteLines = @()
    foreach ($ln in ($text -split "`r?`n")) { if ($ln -match '(?i)ghi_chu|ghi chu') { $noteLines += $ln.Trim() } }
    if ($noteLines.Count -gt 0) {
        $picked = $noteLines[0]; $pickedTs = ""
        foreach ($nl in $noteLines) {
            $mm = [regex]::Match($nl, '20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}')
            if ($mm.Success -and $mm.Value -gt $pickedTs) { $pickedTs = $mm.Value; $picked = $nl }
        }
        $result.LastNote = $picked
    }
    return $result
}

# ---- Kiem tra tho dang chay (phan biet bang command line, vd --profile youtube) ----
function Test-WorkerRunning([hashtable]$Lane) {
    $proc = "omp.exe"
    if ($Lane.ContainsKey("WorkerProcessName")) { $proc = [string]$Lane.WorkerProcessName }
    if ($proc -eq "") { return $false }
    $match = ""
    if ($Lane.WorkerMatch) { $match = [string]$Lane.WorkerMatch }
    try {
        $list = Get-CimInstance Win32_Process -Filter ("Name='" + $proc + "'") -ErrorAction Stop
        foreach ($p in $list) {
            if ($match -eq "") { return $true }
            if ($p.CommandLine -and $p.CommandLine.Contains($match)) { return $true }
        }
        return $false
    } catch {
        # CIM loi -> lui ve Get-Process (thao, chi biet co process hay khong)
        $gp = Get-Process -Name ($proc -replace '\.exe$', '') -ErrorAction SilentlyContinue
        return ($null -ne $gp)
    }
}

# ---- Dong bo repo (chi khi cay sach, chi ff-only, loi thi bo qua) ----
function Sync-Repo() {
    if (-not $Cfg.AutoSync) { return "tat" }
    try {
        $dirty = & git -C $Cfg.RepoDir status --porcelain 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { return "khong-phai-repo-git" }
        if ($dirty.Trim() -ne "") { return "clone-ban-bo-qua-pull" }
        $out = & git -C $Cfg.RepoDir pull --ff-only 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { return "pull-loi" }
        return "da-pull"
    } catch { return "loi-sync" }
}

function Get-LastLaunch([string]$LaneName) {
    $f = Join-Path $StateDir ("last-launch-" + $LaneName + ".txt")
    if (Test-Path -LiteralPath $f) {
        $raw = [System.IO.File]::ReadAllText($f).Trim()
        $dt = [DateTime]::MinValue
        $ok = [DateTime]::TryParseExact($raw, "yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$dt)
        if ($ok) { return $dt }
    }
    return $null
}
function Set-LastLaunch([string]$LaneName) {
    Write-Utf8NoBom (Join-Path $StateDir ("last-launch-" + $LaneName + ".txt")) (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
}

# ---- Trang tong quan: doc status.json cua MOI project trong StateRoot, sinh 1 HTML co tab ----
function Write-Overview() {
    try {
        $projects = @()
        foreach ($d in (Get-ChildItem -LiteralPath $StateRoot -Directory -ErrorAction SilentlyContinue)) {
            $sj = Join-Path $d.FullName "status.json"
            if (Test-Path -LiteralPath $sj) {
                try { $projects += ([System.IO.File]::ReadAllText($sj) | ConvertFrom-Json) } catch {}
            }
        }
        if ($projects.Count -eq 0) { return }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.AppendLine("<!DOCTYPE html><html lang='vi'><head><meta charset='utf-8'>")
        [void]$sb.AppendLine("<meta name='viewport' content='width=device-width, initial-scale=1'>")
        [void]$sb.AppendLine("<title>Tong quan dieu phoi - cac project</title>")
        [void]$sb.AppendLine("<style>body{font-family:system-ui,sans-serif;margin:24px;background:#0f1115;color:#e6e6e6}h1{font-size:20px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}button.tab{background:#1c2030;color:#e6e6e6;border:1px solid #333a4d;border-radius:8px;padding:8px 14px;cursor:pointer}button.tab.active{background:#2563eb;border-color:#2563eb}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #262b3a;padding:8px;text-align:left;vertical-align:top}.chip{border-radius:999px;padding:2px 10px;font-size:12px;background:#374151}.moi{background:#b45309}.dang-lam{background:#1d4ed8}.xong-cho-duyet{background:#7e22ce}.xong{background:#15803d}.cho-muse{background:#b91c1c}.meta{color:#9aa3b2;font-size:12px}.pane{display:none}.pane.active{display:block}</style>")
        [void]$sb.AppendLine("<script>function openTab(id,btn){var ps=document.querySelectorAll('.pane');for(var i=0;i<ps.length;i++){ps[i].classList.remove('active')}var bs=document.querySelectorAll('button.tab');for(var j=0;j<bs.length;j++){bs[j].classList.remove('active')}document.getElementById(id).classList.add('active');btn.classList.add('active')}</script></head><body>")
        [void]$sb.AppendLine("<h1>Tong quan dieu phoi - cac project</h1>")
        [void]$sb.AppendLine("<div class='tabs'>")
        $first = $true
        foreach ($p in $projects) {
            $cls = ""; if ($first) { $cls = " active" }
            [void]$sb.AppendLine(("<button class='tab{0}' onclick=`"openTab('pane-{1}',this)`">{2}</button>" -f $cls, $p.name, (Html-Enc $p.displayName)))
            $first = $false
        }
        [void]$sb.AppendLine("</div>")
        $first = $true
        foreach ($p in $projects) {
            $cls = ""; if ($first) { $cls = " active" }
            [void]$sb.AppendLine(("<div class='pane{0}' id='pane-{1}'>" -f $cls, $p.name))
            [void]$sb.AppendLine(("<p class='meta'>Project: {0} | Che do: {1} | Cap nhat: {2} | Dong bo: {3}</p>" -f (Html-Enc $p.name), (Html-Enc $p.mode), (Html-Enc $p.updatedAt), (Html-Enc $p.syncNote)))
            [void]$sb.AppendLine("<table><tr><th>Lan</th><th>Trang thai</th><th>Ve dang chay</th><th>Tho</th><th>Ghi chu moi nhat</th></tr>")
            foreach ($l in $p.lanes) {
                $worker = "ranh"
                if ($l.workerRunning) { $worker = "dang chay" }
                if ($l.paused) { $worker = $worker + " (PAUSE)" }
                [void]$sb.AppendLine(("<tr><td>{0}</td><td><span class='chip {1}'>{2}</span></td><td>{3}</td><td>{4}</td><td>{5}</td></tr>" -f (Html-Enc $l.displayName), (Html-Enc $l.status), (Html-Enc $l.status), (Html-Enc $l.ticket), (Html-Enc $worker), (Html-Enc $l.lastNote)))
            }
            [void]$sb.AppendLine("</table></div>")
            $first = $false
        }
        [void]$sb.AppendLine(("<p class='meta'>Trang nay do watcher tu sinh moi vong quet. Trang thai doc tu file trang-thai.md cua tung hop thu; watcher khong sua cac file do.</p>"))
        [void]$sb.AppendLine("</body></html>")
        $tmp = Join-Path $StateRoot "tong-quan.html.tmp"
        $dst = Join-Path $StateRoot "tong-quan.html"
        Write-Utf8NoBom $tmp $sb.ToString()
        Move-Item -LiteralPath $tmp -Destination $dst -Force
    } catch { Add-Log ("Loi sinh tong quan: " + $_.Exception.Message) }
}

# ---- Mot vong quet ----
function Invoke-Cycle() {
    $syncNote = Sync-Repo
    $laneResults = @()
    foreach ($lane in $Cfg.Lanes) {
        $st = Read-LaneStatus $lane
        $running = Test-WorkerRunning $lane
        $paused = (Test-Path -LiteralPath (Join-Path $StateDir "PAUSE")) -or (Test-Path -LiteralPath (Join-Path $StateDir ("PAUSE-" + $lane.Name)))
        $lastLaunch = Get-LastLaunch $lane.Name
        $runningFile = Join-Path $StateDir ("running-" + $lane.Name + ".json")

        # Don running.json rac: khong con process tho va da qua 5 phut
        if ((Test-Path -LiteralPath $runningFile) -and -not $running) {
            $age = (Get-Date) - (Get-Item -LiteralPath $runningFile).LastWriteTime
            if ($age.TotalMinutes -gt 5) { Remove-Item -LiteralPath $runningFile -Force -ErrorAction SilentlyContinue }
        }
        $freshRun = $false
        if (Test-Path -LiteralPath $runningFile) {
            $age2 = (Get-Date) - (Get-Item -LiteralPath $runningFile).LastWriteTime
            if ($age2.TotalMinutes -lt 3) { $freshRun = $true }
        }

        $cooldownOk = $true
        $minGap = 15
        if ($Cfg.MinLaunchIntervalMinutes) { $minGap = [int]$Cfg.MinLaunchIntervalMinutes }
        if ($lastLaunch -and (((Get-Date) - $lastLaunch).TotalMinutes -lt $minGap)) { $cooldownOk = $false }

        if ($Cfg.Mode -eq "auto" -and $st.Status -eq "moi" -and -not $running -and -not $freshRun -and -not $paused -and $cooldownOk) {
            $prompt = [string]$lane.Prompt
            $args = ([string]$lane.LaunchArgsTemplate).Replace("{Prompt}", $prompt)
            if ($DryRun) {
                Add-Log ("[DRYRUN] Se mo tho lane {0}: {1} {2} (wd={3})" -f $lane.Name, $lane.LaunchCommand, $args, $lane.WorkDir)
            } else {
                try {
                    $proc = $null
                    if ($Cfg.ShowWindow) {
                        $proc = Start-Process -FilePath $lane.LaunchCommand -ArgumentList $args -WorkingDirectory $lane.WorkDir -PassThru
                    } else {
                        $proc = Start-Process -FilePath $lane.LaunchCommand -ArgumentList $args -WorkingDirectory $lane.WorkDir -WindowStyle Hidden -PassThru
                    }
                    $pidVal = 0
                    if ($proc) { $pidVal = $proc.Id }
                    Set-LastLaunch $lane.Name
                    $rec = [ordered]@{ pid = $pidVal; started = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); ticket = $st.Ticket } | ConvertTo-Json -Compress
                    Write-Utf8NoBom $runningFile $rec
                    $logLine = "{0} | MO-THO | project={1} lane={2} ticket={3} pid={4}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Cfg.Name, $lane.Name, $st.Ticket, $pidVal
                    [System.IO.File]::AppendAllText((Join-Path $StateDir "launches.log"), $logLine + "`r`n", $Utf8NoBom)
                    Add-Log $logLine
                } catch {
                    Add-Log ("Loi mo tho lane {0}: {1}" -f $lane.Name, $_.Exception.Message)
                }
            }
        }
        $laneResults += [ordered]@{
            name = $lane.Name; displayName = $lane.DisplayName; status = $st.Status
            ticket = $st.Ticket; lastNote = $st.LastNote; workerRunning = $running
            paused = $paused
            lastLaunch = $(if ($lastLaunch) { $lastLaunch.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
        }
    }
    $snap = [ordered]@{
        name = $Cfg.Name; displayName = $Cfg.DisplayName; mode = $Cfg.Mode
        syncNote = $syncNote; updatedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        lanes = $laneResults
    }
    Write-Utf8NoBom (Join-Path $StateDir "status.json") ($snap | ConvertTo-Json -Depth 5)
    Write-Overview
}

Add-Log ("Watcher khoi dong: project={0} mode={1} dryrun={2} once={3}" -f $Cfg.Name, $Cfg.Mode, $DryRun.IsPresent, $Once.IsPresent)
try {
    do {
        try { Invoke-Cycle } catch { Add-Log ("Loi vong quet: " + $_.Exception.Message) }
        if ($Once) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
} finally {
    if ($LockStream) { $LockStream.Close() }
    Add-Log "Watcher dung."
}
