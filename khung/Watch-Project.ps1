# Watch-Project.ps1 - ENGINE WATCHER CHUNG cho khung da project (agent-mailbox/khung).
# Mot tien trinh chay cho MOT project (doc cau hinh projects\<Project>.project.ps1).
# Che do "auto": thay trang thai "moi" + tho ranh -> tu mo tho theo cau hinh.
# Che do "monitor": chi doc trang thai + viet snapshot cho trang tong quan, KHONG mo tho.
#
# Co che GIAM SAT PHIEN DANG CHAY (khi SessionMonitorEnabled = $true trong project config):
#  - Moi lan mo tho cho 1 ve, ghi vao state ngoai cay git (sessions.json + running-<lane>.json):
#    ma ve, project/lane, PID cay tien trinh tho + dinh danh (ten, StartTime, CommandLine),
#    thoi diem bat dau, moc tien do cuoi (lastActivityAt), loai ve, han ra ket qua.
#  - 2 tang phat hien phien chet khi chua co bao cao ket qua chinh trong ket-qua/:
#      1. Trigger chinh theo TIEN DO (NoProgressTimeoutMinutes, mac dinh 30 phut):
#         Trong thu muc ket qua cua ve, neu qua N phut khong co tep moi/thay doi -> coi nhu phien da chet.
#      2. Tran cung thu hai theo LOAI VE (TicketTimeoutsHours: audit / nghien-cuu = 2 gio;
#         cac loai khac tra bang trong config project, co default).
#  - Khi phat hien phien chet (do treo tien do hoac cham tran cung) -> xu ly dung thu tu:
#      (a) Xac minh dinh danh PID; neu khop thi giet dung cay tien trinh tho cua ve do
#          (neu PID khong khop / tai su dung -> KHONG giet, chi ghi bao dong).
#      (b) APPEND dung 1 dong bao dong vao cuoi trang-thai.md cua hop thu do.
#      (c) Giai phong registry cua ve do de ve moi (ma moi) khong bi chan; khoa ma ve cu
#          de watcher KHONG tu mo lai tho cho cung ma ve.
#
# LUAT CUNG (bai hoc 2026-10-05/10-10/10-17, khong duoc pha):
#  - Watcher KHONG BAO GIO sua dong trang thai VE hay ghi chu cua tho/dieu phoi trong
#    trang-thai.md / prompt.md (chi duoc APPEND dong "- bao-dong: ..." khi phien qua han).
#  - Khong tu phat lai ve, khong doi trang thai VE, khong tu mo lai tho cho cung ma ve.
#  - State/khoa/log/registry cua watcher nam NGOAI cay git (StateRoot trong cau hinh).
#  - Loi phu (pull loi, CIM loi...) khong duoc chan viec chinh; ghi log va di tiep.
#  - Moi lan chi chay toi da so tho theo MaxConcurrent cua tung lane (mac dinh 1).
#
# Dung:
#   powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project youtube
#   powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project youtube -Once -DryRun
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

$CloneRoot = Split-Path $KhungDir -Parent
$StateRoot = Join-Path $CloneRoot "khung-state"
if ($Cfg.StateRoot) { $StateRoot = [string]$Cfg.StateRoot }
$LocalCfg = Join-Path $KhungDir "config.local.ps1"
if (Test-Path -LiteralPath $LocalCfg) {
    . $LocalCfg
    if ($StateRootOverride) { $StateRoot = [string]$StateRootOverride }
}
$StateDir = Join-Path $StateRoot $Cfg.Name
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$PollSeconds = 90
if ($Cfg.PollSeconds) { $PollSeconds = [int]$Cfg.PollSeconds }
$SessionMonitorEnabled = $false
if ($Cfg.ContainsKey("SessionMonitorEnabled") -and $Cfg.SessionMonitorEnabled) {
    $SessionMonitorEnabled = [bool]$Cfg.SessionMonitorEnabled
}
$DefaultNoProgressMinutes = 30.0
if ($Cfg.ContainsKey("NoProgressTimeoutMinutes") -and $null -ne $Cfg.NoProgressTimeoutMinutes) {
    $DefaultNoProgressMinutes = [double]$Cfg.NoProgressTimeoutMinutes
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}
function Add-Log([string]$Msg) {
    $line = "{0} | {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
    try { [System.IO.File]::AppendAllText((Join-Path $StateDir "watcher.log"), $line + "`r`n", $Utf8NoBom) } catch {}
    Write-Host $line
}
function Add-LaunchLog([string]$Msg) {
    $line = "{0} | {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
    try { [System.IO.File]::AppendAllText((Join-Path $StateDir "launches.log"), $line + "`r`n", $Utf8NoBom) } catch {}
    Add-Log $Msg
}
function Html-Enc([string]$s) {
    if (-not $s) { return "" }
    return [System.Net.WebUtility]::HtmlEncode($s)
}
function ConvertTo-AsciiLower([string]$s) {
    if (-not $s) { return "" }
    $norm = $s.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $norm.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            if ($ch -eq [char]0x0111 -or $ch -eq [char]0x0110) {
                [void]$sb.Append('d')
            } else {
                [void]$sb.Append($ch)
            }
        }
    }
    return $sb.ToString().ToLowerInvariant()
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

# ---- Quan ly state/registry phien dang chay (ngoai cay git) ----
$SessionsFile = Join-Path $StateDir "sessions.json"

function ConvertTo-HashtableRecursive($InputObject) {
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $ht = [ordered]@{}
        foreach ($k in $InputObject.Keys) {
            $ht[[string]$k] = ConvertTo-HashtableRecursive $InputObject[$k]
        }
        return $ht
    }
    if ($InputObject -is [System.Collections.IEnumerable] -and -not ($InputObject -is [string])) {
        $arr = @()
        foreach ($item in $InputObject) {
            $arr += ,(ConvertTo-HashtableRecursive $item)
        }
        return $arr
    }
    if ($InputObject -is [PSCustomObject]) {
        $ht = [ordered]@{}
        foreach ($prop in $InputObject.PSObject.Properties) {
            $ht[$prop.Name] = ConvertTo-HashtableRecursive $prop.Value
        }
        return $ht
    }
    return $InputObject
}

function Load-SessionState() {
    $state = [ordered]@{
        project        = $Cfg.Name
        updatedAt      = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        activeSessions = [ordered]@{}
        closedTickets  = [ordered]@{}
    }
    if (Test-Path -LiteralPath $SessionsFile) {
        try {
            $raw = [System.IO.File]::ReadAllText($SessionsFile, [System.Text.Encoding]::UTF8)
            if ($raw.Trim() -ne "") {
                $parsed = ConvertTo-HashtableRecursive ($raw | ConvertFrom-Json)
                if ($parsed -and $parsed.Contains("activeSessions") -and $parsed["activeSessions"]) {
                    $state.activeSessions = $parsed["activeSessions"]
                }
                if ($parsed -and $parsed.Contains("closedTickets") -and $parsed["closedTickets"]) {
                    $state.closedTickets = $parsed["closedTickets"]
                }
            }
        } catch {
            Add-Log ("Loi doc sessions.json: " + $_.Exception.Message)
        }
    }
    foreach ($lane in $Cfg.Lanes) {
        $rf = Join-Path $StateDir ("running-" + $lane.Name + ".json")
        if (Test-Path -LiteralPath $rf) {
            try {
                $rRaw = [System.IO.File]::ReadAllText($rf, [System.Text.Encoding]::UTF8)
                $rObj = ConvertTo-HashtableRecursive ($rRaw | ConvertFrom-Json)
                if ($rObj -and $rObj.Contains("deadlineAt")) {
                    $useRf = $false
                    if (-not $state.activeSessions.Contains($lane.Name)) {
                        $useRf = $true
                    } elseif (Test-Path -LiteralPath $SessionsFile) {
                        $rfTime = (Get-Item -LiteralPath $rf).LastWriteTimeUtc
                        $sfTime = (Get-Item -LiteralPath $SessionsFile).LastWriteTimeUtc
                        if ($rfTime -gt $sfTime.AddSeconds(1)) { $useRf = $true }
                    }
                    if ($useRf) {
                        $state.activeSessions[$lane.Name] = $rObj
                    }
                }
            } catch {}
        }
    }
    return $state
}

function Save-SessionState([System.Collections.IDictionary]$State) {
    $State["updatedAt"] = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    try {
        Write-Utf8NoBom $SessionsFile ($State | ConvertTo-Json -Depth 8)
    } catch {
        Add-Log ("Loi ghi sessions.json: " + $_.Exception.Message)
    }
    if ($SessionMonitorEnabled) {
        foreach ($lane in $Cfg.Lanes) {
            $rf = Join-Path $StateDir ("running-" + $lane.Name + ".json")
            if ($State.activeSessions.Contains($lane.Name) -and $null -ne $State.activeSessions[$lane.Name]) {
                try {
                    Write-Utf8NoBom $rf ($State.activeSessions[$lane.Name] | ConvertTo-Json -Depth 6 -Compress)
                } catch {}
            } else {
                if (Test-Path -LiteralPath $rf) {
                    Remove-Item -LiteralPath $rf -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

# ---- Doc trang thai 1 lane ----
function Read-LaneStatus([hashtable]$Lane, [string[]]$ClosedTicketIds = @()) {
    $result = @{ Status = "khong-thay-file"; Ticket = ""; TicketFile = ""; LastNote = ""; LatestTs = "" }
    $file = $Lane.StatusFile
    if (-not [System.IO.Path]::IsPathRooted($file)) { $file = Join-Path $Cfg.RepoDir $file }
    if (-not (Test-Path -LiteralPath $file)) { return $result }
    $text = ""
    try { $text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) } catch { return $result }

    # Loai bo cac dong "- bao-dong:" do watcher append khi tinh trang thai & moc thoi gian
    $linesWithoutAlarm = @()
    foreach ($ln in ($text -split "`r?`n")) {
        if ($ln -notmatch '(?i)^\s*[-*]?\s*bao-dong\s*:') {
            $linesWithoutAlarm += $ln
        }
    }
    $cleanText = ($linesWithoutAlarm -join "`r`n")

    $statusMatches = [regex]::Matches($cleanText, '(?im)^\s*[-*]?\s*(Tr\u1EA1ng th\u00E1i|Trang thai|trang_thai|trang-thai)\s*:\s*`?\s*([a-zA-Z\-]+)\s*`?')
    $usedInlineVeStatus = $false
    if ($statusMatches.Count -eq 0) {
        $statusMatches = [regex]::Matches($cleanText, '(?im)\b(trang-thai|trang_thai)\s*:\s*`?\s*([a-zA-Z\-]+)\s*`?')
        $usedInlineVeStatus = $true
    }
    if ($statusMatches.Count -eq 0) { $result.Status = "khong-doc-duoc"; return $result }

    $mode = "newest"
    if ($Lane.StatusMode) { $mode = [string]$Lane.StatusMode }
    $chosen = $null
    if ($usedInlineVeStatus -or $mode -eq "first") {
        $chosen = $statusMatches[0]
    } elseif ($mode -eq "last") {
        $chosen = $statusMatches[$statusMatches.Count - 1]
    } else {
        $tsMatches = [regex]::Matches($cleanText, '20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}')
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

    # Trich xuat ma ve (Ticket) va tep ve (TicketFile)
    $veMatches = [regex]::Matches($cleanText, '(?im)^\s*\|?\s*[-*]?\s*\*?\*?VE\s*:\s*([A-Za-z0-9\-_]+)\*?\*?([^\r\n]*)')
    if ($veMatches.Count -gt 0) {
        $pickedVe = $null
        foreach ($vm in $veMatches) {
            $tId = $vm.Groups[1].Value.Trim()
            $rest = $vm.Groups[2].Value
            $inlineSt = ""
            $ism = [regex]::Match($rest, '(?i)\b(?:trang-thai|trang_thai)\s*:\s*`?\s*([a-zA-Z\-]+)\s*`?')
            if ($ism.Success) { $inlineSt = $ism.Groups[1].Value.Trim().ToLower() }
            if ($inlineSt -eq $result.Status -and ($ClosedTicketIds -notcontains $tId)) {
                $pickedVe = $vm
                break
            }
        }
        if ($null -eq $pickedVe) {
            foreach ($vm in $veMatches) {
                $rest = $vm.Groups[2].Value
                $ism = [regex]::Match($rest, '(?i)\b(?:trang-thai|trang_thai)\s*:\s*`?\s*([a-zA-Z\-]+)\s*`?')
                if ($ism.Success -and $ism.Groups[1].Value.Trim().ToLower() -eq $result.Status) {
                    $pickedVe = $vm
                    break
                }
            }
        }
        if ($null -eq $pickedVe) { $pickedVe = $veMatches[0] }

        $result.Ticket = $pickedVe.Groups[1].Value.Trim()
        $fm = [regex]::Match($pickedVe.Groups[2].Value, '(?i)file\s*:?\s*`?([^\s|`)]+\.md)`?')
        if ($fm.Success) { $result.TicketFile = $fm.Groups[1].Value.Trim() }
    } else {
        $tm = [regex]::Match($cleanText, '(?im)^\s*[-*]?\s*(?:V\u00E9 \u0111ang ch\u1EA1y|Ve dang chay|ve_dang_chay)\s*:\s*(.+?)\s*$')
        if ($tm.Success) {
            $rawVal = $tm.Groups[1].Value.Trim()
            $fm = [regex]::Match($rawVal, '(?i)file\s*:?\s*`?([^\s|`)]+\.md)`?')
            if ($fm.Success) { $result.TicketFile = $fm.Groups[1].Value.Trim() }
            $idMatch = [regex]::Match($rawVal, '^`?\*?\*?([A-Za-z0-9\-_]+)\*?\*?`?')
            if ($idMatch.Success -and $idMatch.Groups[1].Value -notmatch '(?i)^file$') {
                $result.Ticket = $idMatch.Groups[1].Value.Trim()
            } else {
                $result.Ticket = $rawVal
            }
        } else {
            $fm = [regex]::Match($cleanText, '(?i)file\s*:?\s*`?((?:ve-|prompts/prompt-)[^\s|`)]+\.md)`?')
            if ($fm.Success) {
                $result.TicketFile = $fm.Groups[1].Value.Trim()
                $slug = [System.IO.Path]::GetFileNameWithoutExtension($result.TicketFile) -replace '^(?i)(ve-|prompt-)', ''
                $result.Ticket = $slug.ToUpperInvariant()
            }
        }
    }

    $noteLines = @()
    foreach ($ln in ($cleanText -split "`r?`n")) { if ($ln -match '(?i)ghi_chu|ghi chu') { $noteLines += $ln.Trim() } }
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

# ---- Doc tep ve de xac dinh LOAI VE, HAN RA KET QUA va duong dan ket-qua ----
function Resolve-TicketDetails([hashtable]$Lane, [hashtable]$LaneStatus) {
    $statusFileFull = $Lane.StatusFile
    if (-not [System.IO.Path]::IsPathRooted($statusFileFull)) {
        $statusFileFull = Join-Path $Cfg.RepoDir $statusFileFull
    }
    $mailboxDir = Split-Path $statusFileFull -Parent
    if ($Lane.ContainsKey("MailboxDir") -and $Lane.MailboxDir) {
        $mailboxDir = [string]$Lane.MailboxDir
        if (-not [System.IO.Path]::IsPathRooted($mailboxDir)) {
            $mailboxDir = Join-Path $Cfg.RepoDir $mailboxDir
        }
    }

    $ticketId = [string]$LaneStatus.Ticket
    $ticketFile = [string]$LaneStatus.TicketFile
    $ticketFilePath = ""

    if ($ticketFile -ne "") {
        if ([System.IO.Path]::IsPathRooted($ticketFile) -and (Test-Path -LiteralPath $ticketFile)) {
            $ticketFilePath = $ticketFile
        } else {
            $cand1 = Join-Path $mailboxDir $ticketFile
            $cand2 = Join-Path $Cfg.RepoDir $ticketFile
            if (Test-Path -LiteralPath $cand1) { $ticketFilePath = $cand1 }
            elseif (Test-Path -LiteralPath $cand2) { $ticketFilePath = $cand2 }
        }
    }
    if ($ticketFilePath -eq "" -and $ticketId -ne "") {
        $idLow = $ticketId.ToLowerInvariant()
        $candidates = @(
            (Join-Path $mailboxDir ("ve-" + $idLow + ".md")),
            (Join-Path $mailboxDir ($ticketId + ".md")),
            (Join-Path $mailboxDir ($idLow + ".md")),
            (Join-Path $mailboxDir ("prompts\prompt-" + $idLow + ".md"))
        )
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) {
                $ticketFilePath = $c
                if ($ticketFile -eq "") { $ticketFile = [System.IO.Path]::GetFileName($c) }
                break
            }
        }
    }

    $ticketType = ""
    $explicitResultPaths = @()

    if ($ticketFilePath -ne "" -and (Test-Path -LiteralPath $ticketFilePath)) {
        try {
            $tContent = [System.IO.File]::ReadAllText($ticketFilePath, [System.Text.Encoding]::UTF8)
            if ($ticketId -eq "" -or $ticketId -match '\.md$') {
                $hm = [regex]::Match($tContent, '(?im)^#\s*(?:V\u00C9|VE)\s+(?:\d+\s+)?([A-Za-z0-9\-_]+)')
                if ($hm.Success) { $ticketId = $hm.Groups[1].Value.Trim() }
            }
            $typeMatch = [regex]::Match($tContent, '(?im)^\s*[-*]?\s*\*?\*?(?:Lo\u1EA1i v\u00E9|Loai ve|loai_ve|loai-ve|Type)\*?\*?\s*:\s*`?([^\r\n`(|]+)')
            if ($typeMatch.Success) {
                $rawType = ConvertTo-AsciiLower ($typeMatch.Groups[1].Value.Trim())
                if ($rawType -match '\baudit\b|kiem[\s\-_]*toan') { $ticketType = "audit" }
                elseif ($rawType -match 'nghien[\s\-_]*cuu|\bresearch\b') { $ticketType = "nghien-cuu" }
                else {
                    $tok = ($rawType -replace '[^a-z0-9\-_]', ' ').Trim().Split(' ')[0]
                    if ($tok) { $ticketType = $tok }
                }
            }
            if ($ticketType -eq "") {
                $firstHeading = [regex]::Match($tContent, '(?im)^#\s+([^\r\n]+)')
                if ($firstHeading.Success) {
                    $hNorm = ConvertTo-AsciiLower $firstHeading.Groups[1].Value
                    if ($hNorm -match '\baudit\b|kiem[\s\-_]*toan') { $ticketType = "audit" }
                    elseif ($hNorm -match 'nghien[\s\-_]*cuu|\bresearch\b') { $ticketType = "nghien-cuu" }
                }
            }
            $kqMatches = [regex]::Matches($tContent, '(?i)([a-zA-Z0-9_\-/\\]*ket-qua[/\\][a-zA-Z0-9_\-/\\.]*)')
            foreach ($km in $kqMatches) {
                $p = $km.Groups[1].Value.Trim().TrimEnd('.', ',', ';', ')', '`', '"', "'")
                if ($p -ne "" -and ($explicitResultPaths -notcontains $p)) {
                    $explicitResultPaths += $p
                }
            }
        } catch {}
    }

    if ($ticketType -eq "" -and $ticketId -ne "") {
        $idNorm = ConvertTo-AsciiLower $ticketId
        if ($idNorm -match '^audit\b|\baudit\b') { $ticketType = "audit" }
        elseif ($idNorm -match '^research\b|^nghien-cuu\b|\bresearch\b') { $ticketType = "nghien-cuu" }
        elseif ($idNorm -match '^([a-z0-9]+)-') {
            $prefix = $Matches[1]
            if ($Cfg.ContainsKey("TicketTimeoutsHours") -and $Cfg.TicketTimeoutsHours -and $Cfg.TicketTimeoutsHours.ContainsKey($prefix)) {
                $ticketType = $prefix
            }
        }
    }
    if ($ticketType -eq "") { $ticketType = "default" }

    $deadlineHours = 4.0
    if ($ticketType -eq "audit" -or $ticketType -eq "nghien-cuu" -or $ticketType -eq "research") {
        $deadlineHours = 2.0
    }
    if ($Cfg.ContainsKey("TicketTimeoutsHours") -and $Cfg.TicketTimeoutsHours) {
        $table = $Cfg.TicketTimeoutsHours
        if ($table.ContainsKey($ticketType)) {
            $deadlineHours = [double]$table[$ticketType]
        } elseif ($ticketType -eq "nghien-cuu" -and $table.ContainsKey("research")) {
            $deadlineHours = [double]$table["research"]
        } elseif ($ticketType -eq "research" -and $table.ContainsKey("nghien-cuu")) {
            $deadlineHours = [double]$table["nghien-cuu"]
        } elseif ($ticketType -ne "audit" -and $ticketType -ne "nghien-cuu" -and $ticketType -ne "research" -and $table.ContainsKey("default")) {
            $deadlineHours = [double]$table["default"]
        }
    }

    if ($ticketId -eq "") { $ticketId = "UNKNOWN-TICKET" }

    return @{
        TicketId            = $ticketId
        TicketFile          = $ticketFile
        TicketFilePath      = $ticketFilePath
        TicketType          = $ticketType
        DeadlineHours       = $deadlineHours
        MailboxDir          = $mailboxDir
        StatusFileFull      = $statusFileFull
        ExplicitResultPaths = $explicitResultPaths
    }
}

# ---- Dinh danh tien trinh & cay tien trinh tho ----
function Get-ProcessIdentity([int]$PidVal) {
    $res = @{
        Exists       = $false
        Pid          = $PidVal
        Name         = ""
        StartTime    = $null
        StartTimeIso = ""
        CommandLine  = ""
    }
    if ($PidVal -le 0) { return $res }
    try {
        $gp = Get-Process -Id $PidVal -ErrorAction Stop
        $res.Exists = $true
        $res.Name = $gp.ProcessName + ".exe"
        try {
            $st = $gp.StartTime
            $res.StartTime = $st
            $res.StartTimeIso = $st.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
        } catch {}
    } catch {
        return $res
    }
    try {
        $cim = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PidVal) -ErrorAction Stop
        if ($cim) {
            if ($cim.Name) { $res.Name = [string]$cim.Name }
            if ($cim.CommandLine) { $res.CommandLine = [string]$cim.CommandLine }
            if ($null -eq $res.StartTime -and $cim.CreationDate) {
                $st = [DateTime]$cim.CreationDate
                $res.StartTime = $st
                $res.StartTimeIso = $st.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
            }
        }
    } catch {}
    return $res
}

function Get-ProcessTreePids([int]$RootPid, $RootStartTime) {
    $tree = New-Object System.Collections.Generic.List[int]
    if ($RootPid -le 0) { return @() }
    $tree.Add($RootPid)
    try {
        $allProcs = Get-CimInstance Win32_Process -ErrorAction Stop
        $childrenByParent = @{}
        foreach ($p in $allProcs) {
            $ppid = [int]$p.ParentProcessId
            if (-not $childrenByParent.ContainsKey($ppid)) {
                $childrenByParent[$ppid] = New-Object System.Collections.Generic.List[object]
            }
            $childrenByParent[$ppid].Add($p)
        }
        $queue = New-Object System.Collections.Generic.Queue[int]
        $queue.Enqueue($RootPid)
        while ($queue.Count -gt 0) {
            $cur = $queue.Dequeue()
            if ($childrenByParent.ContainsKey($cur)) {
                foreach ($child in $childrenByParent[$cur]) {
                    $cPid = [int]$child.ProcessId
                    if (-not $tree.Contains($cPid)) {
                        $validTime = $true
                        if ($null -ne $RootStartTime -and $null -ne $child.CreationDate) {
                            $cStart = [DateTime]$child.CreationDate
                            if ($cStart -lt ([DateTime]$RootStartTime).AddSeconds(-2)) {
                                $validTime = $false
                            }
                        }
                        if ($validTime) {
                            $tree.Add($cPid)
                            $queue.Enqueue($cPid)
                        }
                    }
                }
            }
        }
    } catch {}
    return $tree.ToArray()
}

function Test-SessionProcessVerified([System.Collections.IDictionary]$Sess) {
    $rPid = 0
    if ($Sess.Contains("rootPid") -and $Sess["rootPid"]) { $rPid = [int]$Sess["rootPid"] }
    elseif ($Sess.Contains("pid") -and $Sess["pid"]) { $rPid = [int]$Sess["pid"] }

    $recName = ""
    if ($Sess.Contains("processName") -and $Sess["processName"]) { $recName = [string]$Sess["processName"] }
    $recStartIso = ""
    if ($Sess.Contains("processStartTime") -and $Sess["processStartTime"]) { $recStartIso = [string]$Sess["processStartTime"] }
    $recCmd = ""
    if ($Sess.Contains("commandLine") -and $Sess["commandLine"]) { $recCmd = [string]$Sess["commandLine"] }

    if ($rPid -le 0) {
        return @{ Exists = $false; Verified = $false; Pid = $rPid; Reason = "PID-khong-hop-le" }
    }
    if ($recName -eq "" -or $recStartIso -eq "") {
        return @{ Exists = $false; Verified = $false; Pid = $rPid; Reason = "thieu-metadata-dinh-danh-PID" }
    }
    $recStartDt = [DateTime]::MinValue
    $parsedOk = [DateTime]::TryParse($recStartIso, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$recStartDt)
    if (-not $parsedOk) {
        return @{ Exists = $false; Verified = $false; Pid = $rPid; Reason = "khong-parse-duoc-processStartTime" }
    }

    $osProc = Get-ProcessIdentity -PidVal $rPid
    if (-not $osProc.Exists) {
        return @{ Exists = $false; Verified = $true; Pid = $rPid; RecStart = $recStartDt; Reason = "tien-trinh-goc-da-thoat" }
    }

    $osBase = ($osProc.Name -replace '(?i)\.exe$', '').ToLowerInvariant()
    $recBase = ($recName -replace '(?i)\.exe$', '').ToLowerInvariant()
    if ($osBase -ne $recBase) {
        return @{
            Exists   = $true
            Verified = $false
            Pid      = $rPid
            Reason   = ("ten-tien-trinh-khong-khop (os=" + $osProc.Name + " vs state=" + $recName + ")")
        }
    }

    if ($null -ne $osProc.StartTime) {
        $diffSec = [Math]::Abs(($osProc.StartTime - $recStartDt).TotalSeconds)
        if ($diffSec -gt 5.0) {
            return @{
                Exists   = $true
                Verified = $false
                Pid      = $rPid
                Reason   = ("StartTime-khong-khop-PID-tai-su-dung (lech=" + [Math]::Round($diffSec, 1) + "s)")
            }
        }
    } else {
        return @{ Exists = $true; Verified = $false; Pid = $rPid; Reason = "khong-doc-duoc-StartTime-cua-PID" }
    }

    if ($recCmd -ne "" -and $osProc.CommandLine -ne "" -and $osProc.CommandLine -ne $recCmd) {
        return @{
            Exists   = $true
            Verified = $false
            Pid      = $rPid
            Reason   = "CommandLine-khong-khop"
        }
    }

    return @{
        Exists   = $true
        Verified = $true
        Pid      = $rPid
        RecStart = $recStartDt
        Reason   = "khop-dinh-danh"
    }
}

# ---- Kiem tra tep ket qua chinh cua ve trong ket-qua/ cua hop thu tuong ung ----
function Get-TicketCandidateSlugs([string]$TicketId, [string]$TicketFile) {
    $slugs = New-Object System.Collections.Generic.List[string]
    $idLow = $(if ($TicketId) { $TicketId.ToLowerInvariant().Trim() } else { "" })
    $fileSlug = ""
    if ($TicketFile) {
        $fileSlug = ([System.IO.Path]::GetFileNameWithoutExtension($TicketFile) -replace '^(?i)(ve-|prompt-)', '').ToLowerInvariant().Trim()
    }
    foreach ($seed in @($idLow, $fileSlug)) {
        if (-not $seed) { continue }
        if (-not $slugs.Contains($seed)) { $slugs.Add($seed) }
        $cur = $seed
        while ($cur -match '^(?<base>[a-z0-9]+-[a-z0-9\-_]+?)-(?:pilot|lan\d+|synthesize(?:-\d+)?|du-phong(?:-\d+)?|dot\d+|v\d+|retry\d*)$') {
            $nextBase = $Matches["base"]
            if (-not $nextBase -or $nextBase.Length -lt 4 -or $nextBase -eq $cur) { break }
            $cur = $nextBase
            if (-not $slugs.Contains($cur)) { $slugs.Add($cur) }
        }
    }
    return $slugs.ToArray()
}

function Test-TicketResultExists([System.Collections.IDictionary]$Sess) {
    $mailboxDir = [string]$Sess["mailboxDir"]
    if (-not $mailboxDir -or -not (Test-Path -LiteralPath $mailboxDir)) { return $null }
    $ketQuaDir = Join-Path $mailboxDir "ket-qua"
    if (-not (Test-Path -LiteralPath $ketQuaDir)) { return $null }
    $ketQuaFull = [System.IO.Path]::GetFullPath($ketQuaDir)
    $ketQuaNorm = $ketQuaFull.TrimEnd('\', '/')

    $ticketId = [string]$Sess["ticket"]
    $idLow = $ticketId.ToLowerInvariant()
    $ticketFile = [string]$Sess["ticketFile"]
    $fileSlug = ""
    if ($ticketFile -ne "") {
        $fileSlug = ([System.IO.Path]::GetFileNameWithoutExtension($ticketFile) -replace '^(?i)(ve-|prompt-)', '').ToLowerInvariant()
    }
    $candidateSlugs = Get-TicketCandidateSlugs -TicketId $ticketId -TicketFile $ticketFile

    $startedDt = [DateTime]::MinValue
    if ($Sess.Contains("startedAt") -and $Sess["startedAt"]) {
        [void][DateTime]::TryParseExact([string]$Sess["startedAt"], "yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$startedDt)
    }

    $directFiles = @(
        (Join-Path $ketQuaDir ($ticketId + ".md")),
        (Join-Path $ketQuaDir ($idLow + ".md"))
    )
    if ($fileSlug -ne "") {
        $directFiles += (Join-Path $ketQuaDir ($fileSlug + ".md"))
    }
    foreach ($df in $directFiles) {
        if (Test-Path -LiteralPath $df -PathType Leaf) {
            $item = Get-Item -LiteralPath $df -ErrorAction SilentlyContinue
            if ($item -and $item.Length -gt 0) { return $item.FullName }
        }
    }

    $subDirs = New-Object System.Collections.Generic.List[string]
    foreach ($cand in @((Join-Path $ketQuaDir $ticketId), (Join-Path $ketQuaDir $idLow))) {
        $normCand = [System.IO.Path]::GetFullPath($cand).TrimEnd('\', '/')
        if (-not $subDirs.Contains($normCand)) { $subDirs.Add($normCand) }
    }
    if ($fileSlug -ne "") {
        $normSlug = [System.IO.Path]::GetFullPath((Join-Path $ketQuaDir $fileSlug)).TrimEnd('\', '/')
        if (-not $subDirs.Contains($normSlug)) { $subDirs.Add($normSlug) }
    }
    foreach ($cs in $candidateSlugs) {
        $normCs = [System.IO.Path]::GetFullPath((Join-Path $ketQuaDir $cs)).TrimEnd('\', '/')
        if (-not $subDirs.Contains($normCs)) { $subDirs.Add($normCs) }
    }

    if ($Sess.Contains("explicitResultPaths") -and $Sess["explicitResultPaths"]) {
        $matchedExplicitDirs = New-Object System.Collections.Generic.List[string]
        $allExplicitDirs = New-Object System.Collections.Generic.List[string]
        foreach ($rel in $Sess["explicitResultPaths"]) {
            $relStr = [string]$rel
            $relLow = $relStr.ToLowerInvariant()
            if ($relLow -match '(?i)(prompt-|stt-log|vision-log|crosscheck-log)') { continue }
            $isSlugMatch = $false
            foreach ($cs in $candidateSlugs) {
                if ($cs -ne "" -and $relLow.Contains($cs)) { $isSlugMatch = $true; break }
            }
            foreach ($base in @($Cfg.RepoDir, $mailboxDir)) {
                if (-not $base) { continue }
                try {
                    $fullP = [System.IO.Path]::GetFullPath((Join-Path $base $relStr))
                    if ($fullP.StartsWith($ketQuaFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $dirP = $fullP
                        if ($fullP -match '\.[a-zA-Z0-9]+$') { $dirP = Split-Path $fullP -Parent }
                        $dirP = $dirP.TrimEnd('\', '/')
                        if ($dirP -ne $ketQuaNorm) {
                            if (-not $allExplicitDirs.Contains($dirP)) { $allExplicitDirs.Add($dirP) }
                            if ($isSlugMatch -and -not $matchedExplicitDirs.Contains($dirP)) { $matchedExplicitDirs.Add($dirP) }
                        }
                    }
                } catch {}
            }
        }
        $chosenExplicitDirs = $(if ($matchedExplicitDirs.Count -gt 0) { $matchedExplicitDirs } else { $allExplicitDirs })
        foreach ($ed in $chosenExplicitDirs) {
            if (-not $subDirs.Contains($ed)) { $subDirs.Add($ed) }
        }
    }

    foreach ($sd in $subDirs) {
        if (Test-Path -LiteralPath $sd -PathType Container) {
            $sdName = [System.IO.Path]::GetFileName($sd)
            $sdNameLow = $sdName.ToLowerInvariant()
            $isExactTicketDir = ($sdNameLow -eq $idLow) -or ($fileSlug -ne "" -and $sdNameLow -eq $fileSlug)
            $reportCandidates = @(
                (Join-Path $sd ($ticketId + ".md")),
                (Join-Path $sd ($idLow + ".md")),
                (Join-Path $sd ($sdName + ".md"))
            )
            if ($fileSlug -ne "") {
                $reportCandidates += (Join-Path $sd ($fileSlug + ".md"))
            }
            foreach ($rc in $reportCandidates) {
                if (Test-Path -LiteralPath $rc -PathType Leaf) {
                    $it = Get-Item -LiteralPath $rc -ErrorAction SilentlyContinue
                    if ($it -and $it.Length -gt 0) {
                        $rcNameLow = ([System.IO.Path]::GetFileNameWithoutExtension($rc)).ToLowerInvariant()
                        $isExactTicketFile = ($rcNameLow -eq $idLow) -or ($fileSlug -ne "" -and $rcNameLow -eq $fileSlug)
                        if ($isExactTicketDir -or $isExactTicketFile -or $startedDt -le [DateTime]::MinValue -or $it.LastWriteTime -ge $startedDt.AddSeconds(-5)) {
                            return $it.FullName
                        }
                    }
                }
            }
        }
    }

    if ($Sess.Contains("explicitResultPaths") -and $Sess["explicitResultPaths"]) {
        foreach ($rel in $Sess["explicitResultPaths"]) {
            $relStr = [string]$rel
            if ($relStr -notmatch '(?i)\.md$') { continue }
            $relLow = $relStr.ToLowerInvariant()
            if ($relLow -match '(?i)(prompt-|stt-log|vision-log|crosscheck-log)') { continue }
            $matchesSlug = $false
            foreach ($cs in $candidateSlugs) {
                if ($cs -ne "" -and $relLow.Contains($cs)) { $matchesSlug = $true; break }
            }
            $cands = @(
                (Join-Path $Cfg.RepoDir $relStr),
                (Join-Path $mailboxDir $relStr)
            )
            foreach ($c in $cands) {
                try {
                    $cFull = [System.IO.Path]::GetFullPath($c)
                    if ($cFull.StartsWith($ketQuaFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                        if (Test-Path -LiteralPath $cFull -PathType Leaf) {
                            $it = Get-Item -LiteralPath $cFull -ErrorAction SilentlyContinue
                            if ($it -and $it.Length -gt 0) {
                                $isExactFile = ($idLow -ne "" -and $relLow.Contains($idLow)) -or ($fileSlug -ne "" -and $relLow.Contains($fileSlug))
                                if ($isExactFile -or ($startedDt -gt [DateTime]::MinValue -and $it.LastWriteTime -ge $startedDt.AddSeconds(-5)) -or ($startedDt -le [DateTime]::MinValue -and $matchesSlug)) {
                                    return $it.FullName
                                }
                            }
                        }
                    }
                } catch {}
            }
        }
    }

    return $null
}

# ---- Do moc TIEN DO moi nhat (LastWriteTime / CreationTime) trong thu muc ket qua cua ve ----
function Get-TicketLastProgress([System.Collections.IDictionary]$Sess) {
    $startedDt = Get-Date
    if ($Sess.Contains("startedAt") -and $Sess["startedAt"]) {
        [void][DateTime]::TryParseExact([string]$Sess["startedAt"], "yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$startedDt)
    }
    $lastDt = $startedDt
    $lastFile = "(startedAt)"

    $mailboxDir = [string]$Sess["mailboxDir"]
    if (-not $mailboxDir -or -not (Test-Path -LiteralPath $mailboxDir)) {
        return @{ LastProgressAt = $lastDt; LastProgressStr = $lastDt.ToString("yyyy-MM-dd HH:mm:ss"); LastFile = $lastFile }
    }
    $ketQuaDir = Join-Path $mailboxDir "ket-qua"
    if (-not (Test-Path -LiteralPath $ketQuaDir)) {
        return @{ LastProgressAt = $lastDt; LastProgressStr = $lastDt.ToString("yyyy-MM-dd HH:mm:ss"); LastFile = $lastFile }
    }
    $ketQuaFull = [System.IO.Path]::GetFullPath($ketQuaDir)
    $ketQuaNorm = $ketQuaFull.TrimEnd('\', '/')

    $ticketId = [string]$Sess["ticket"]
    $idLow = $ticketId.ToLowerInvariant()
    $ticketFile = [string]$Sess["ticketFile"]
    $fileSlug = ""
    if ($ticketFile -ne "") {
        $fileSlug = ([System.IO.Path]::GetFileNameWithoutExtension($ticketFile) -replace '^(?i)(ve-|prompt-)', '').ToLowerInvariant()
    }
    $candidateSlugs = Get-TicketCandidateSlugs -TicketId $ticketId -TicketFile $ticketFile

    $targetDirs = New-Object System.Collections.Generic.List[string]
    foreach ($candDir in @((Join-Path $ketQuaDir $ticketId), (Join-Path $ketQuaDir $idLow))) {
        if ($candDir) {
            $normDir = [System.IO.Path]::GetFullPath($candDir).TrimEnd('\', '/')
            if (-not $targetDirs.Contains($normDir)) { $targetDirs.Add($normDir) }
        }
    }
    if ($fileSlug -ne "") {
        $slugDir = [System.IO.Path]::GetFullPath((Join-Path $ketQuaDir $fileSlug)).TrimEnd('\', '/')
        if (-not $targetDirs.Contains($slugDir)) { $targetDirs.Add($slugDir) }
    }
    foreach ($cs in $candidateSlugs) {
        $csDir = [System.IO.Path]::GetFullPath((Join-Path $ketQuaDir $cs)).TrimEnd('\', '/')
        if (-not $targetDirs.Contains($csDir)) { $targetDirs.Add($csDir) }
    }
    if ($Sess.Contains("explicitResultPaths") -and $Sess["explicitResultPaths"]) {
        $matchedExplicitDirs = New-Object System.Collections.Generic.List[string]
        $allExplicitDirs = New-Object System.Collections.Generic.List[string]
        foreach ($rel in $Sess["explicitResultPaths"]) {
            $relStr = [string]$rel
            $relLow = $relStr.ToLowerInvariant()
            $isSlugMatch = $false
            foreach ($cs in $candidateSlugs) {
                if ($cs -ne "" -and $relLow.Contains($cs)) { $isSlugMatch = $true; break }
            }
            foreach ($base in @($Cfg.RepoDir, $mailboxDir)) {
                if (-not $base) { continue }
                try {
                    $fullP = [System.IO.Path]::GetFullPath((Join-Path $base $relStr))
                    if ($fullP.StartsWith($ketQuaFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $dirP = $fullP
                        if ($fullP -match '\.[a-zA-Z0-9]+$') { $dirP = Split-Path $fullP -Parent }
                        $dirP = $dirP.TrimEnd('\', '/')
                        if ($dirP -ne $ketQuaNorm) {
                            if (-not $allExplicitDirs.Contains($dirP)) { $allExplicitDirs.Add($dirP) }
                            if ($isSlugMatch -and -not $matchedExplicitDirs.Contains($dirP)) { $matchedExplicitDirs.Add($dirP) }
                        }
                    }
                } catch {}
            }
        }
        $chosenExplicitDirs = $(if ($matchedExplicitDirs.Count -gt 0) { $matchedExplicitDirs } else { $allExplicitDirs })
        foreach ($ed in $chosenExplicitDirs) {
            if (-not $targetDirs.Contains($ed)) { $targetDirs.Add($ed) }
        }
    }

    foreach ($td in $targetDirs) {
        if (Test-Path -LiteralPath $td -PathType Container) {
            try {
                $dirItem = Get-Item -LiteralPath $td -Force -ErrorAction SilentlyContinue
                if ($dirItem) {
                    $dt = $dirItem.LastWriteTime
                    if ($dirItem.CreationTime -gt $dt) { $dt = $dirItem.CreationTime }
                    if ($dt -ge $startedDt.AddSeconds(-5) -and $dt -gt $lastDt) {
                        $lastDt = $dt
                        $lastFile = $dirItem.Name
                    }
                }
                $items = Get-ChildItem -LiteralPath $td -Recurse -Force -ErrorAction SilentlyContinue
                foreach ($it in $items) {
                    $dt = $it.LastWriteTime
                    if ($it.CreationTime -gt $dt) { $dt = $it.CreationTime }
                    if ($dt -ge $startedDt.AddSeconds(-5) -and ($dt -gt $lastDt -or ($dt -eq $lastDt -and -not $it.PSIsContainer))) {
                        $lastDt = $dt
                        $lastFile = $it.Name
                    }
                }
            } catch {}
        }
    }

    return @{
        LastProgressAt  = $lastDt
        LastProgressStr = $lastDt.ToString("yyyy-MM-dd HH:mm:ss")
        LastFile        = $lastFile
    }
}

# ---- Giet cay tien trinh tho cua phien (co xac minh PID chong giet nham) ----
function Invoke-KillSessionTree([System.Collections.IDictionary]$Sess) {
    $ver = Test-SessionProcessVerified $Sess
    $rPid = $ver.Pid

    if (-not $ver.Verified) {
        return @{
            Action     = "mismatch-not-killed"
            KilledPids = @()
            RootPid    = $rPid
            Reason     = $ver.Reason
        }
    }

    $recStart = $ver.RecStart
    $toKill = New-Object System.Collections.Generic.List[int]

    if ($ver.Exists) {
        $liveTree = Get-ProcessTreePids -RootPid $rPid -RootStartTime $recStart
        foreach ($tp in $liveTree) {
            if (-not $toKill.Contains([int]$tp)) { $toKill.Add([int]$tp) }
        }
    }

    if ($Sess.Contains("treePids") -and $Sess["treePids"]) {
        foreach ($oldPid in $Sess["treePids"]) {
            $op = [int]$oldPid
            if ($op -gt 0 -and -not $toKill.Contains($op)) {
                $pIdent = Get-ProcessIdentity -PidVal $op
                if ($pIdent.Exists -and $null -ne $pIdent.StartTime -and $pIdent.StartTime -ge $recStart.AddSeconds(-2)) {
                    $subTree = Get-ProcessTreePids -RootPid $op -RootStartTime $recStart
                    foreach ($sp in $subTree) {
                        if (-not $toKill.Contains([int]$sp)) { $toKill.Add([int]$sp) }
                    }
                }
            }
        }
    }

    $killed = New-Object System.Collections.Generic.List[int]
    if ($toKill.Count -gt 0) {
        $ordered = @($toKill.ToArray())
        [array]::Reverse($ordered)
        foreach ($kp in $ordered) {
            try {
                Stop-Process -Id $kp -Force -ErrorAction Stop
                $killed.Add($kp)
            } catch {
                if (-not (Get-Process -Id $kp -ErrorAction SilentlyContinue)) {
                    $killed.Add($kp)
                }
            }
        }
    }

    return @{
        Action     = "killed"
        KilledPids = $killed.ToArray()
        RootPid    = $rPid
        Reason     = $ver.Reason
    }
}

# ---- APPEND dong bao dong vao cuoi trang-thai.md cua hop thu ----
function Append-MailboxAlarm([string]$StatusFilePath, [string]$TicketId, [double]$DeadlineHours, [string]$KillAction, [int]$RootPid, [string]$Reason, [string]$TriggerType = "hard-deadline", [double]$NoProgressMinutes = 0, [string]$LastProgressStr = "") {
    $tzNow = [DateTimeOffset]::Now.ToOffset([TimeSpan]::FromHours(7)).ToString("yyyy-MM-dd HH:mm +07")
    $hStr = ([double]$DeadlineHours).ToString("0.###", [System.Globalization.CultureInfo]::InvariantCulture)
    $mStr = ([double]$NoProgressMinutes).ToString("0.###", [System.Globalization.CultureInfo]::InvariantCulture)
    $emDash = [char]0x2014

    $alarmLine = ""
    if ($TriggerType -eq "no-progress") {
        if ($KillAction -eq "mismatch-not-killed") {
            $alarmLine = "- bao-dong: {0} {1} Watcher: ve {2} qua {3}p khong co tep moi/thay doi trong ket-qua/ (moc cuoi {4}, tran {5}h), khong chac chan tien trinh thuoc ve ve (PID {6}: {7}) nen KHONG giet, tra ve cho dieu phoi phat lai." -f $tzNow, $emDash, $TicketId, $mStr, $LastProgressStr, $hStr, $RootPid, $Reason
        } else {
            $alarmLine = "- bao-dong: {0} {1} Watcher: ve {2} qua {3}p khong co tep moi/thay doi trong ket-qua/ (moc cuoi {4}, tran {5}h) khong ra ket qua, da giet phien tho, tra ve cho dieu phoi phat lai." -f $tzNow, $emDash, $TicketId, $mStr, $LastProgressStr, $hStr
        }
    } else {
        if ($KillAction -eq "mismatch-not-killed") {
            $alarmLine = "- bao-dong: {0} {1} Watcher: ve {2} qua han {3}h khong ra ket qua, khong chac chan tien trinh thuoc ve ve (PID {4}: {5}) nen KHONG giet, tra ve cho dieu phoi phat lai." -f $tzNow, $emDash, $TicketId, $hStr, $RootPid, $Reason
        } else {
            $alarmLine = "- bao-dong: {0} {1} Watcher: ve {2} qua han {3}h khong ra ket qua, da giet phien tho, tra ve cho dieu phoi phat lai." -f $tzNow, $emDash, $TicketId, $hStr
        }
    }

    if (Test-Path -LiteralPath $StatusFilePath) {
        $existing = [System.IO.File]::ReadAllText($StatusFilePath, [System.Text.Encoding]::UTF8)
        $prefix = ""
        if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) {
            $prefix = "`r`n"
        }
        [System.IO.File]::AppendAllText($StatusFilePath, $prefix + $alarmLine + "`r`n", $Utf8NoBom)

        if ($Cfg.AutoSync -and $Cfg.RepoDir -and (Test-Path -LiteralPath $Cfg.RepoDir)) {
            try {
                & git -C $Cfg.RepoDir add -- $StatusFilePath 2>&1 | Out-Null
                $commitMsg = "watcher(bao-dong): ve $TicketId ($TriggerType)"
                & git -C $Cfg.RepoDir commit -m $commitMsg -- $StatusFilePath 2>&1 | Out-Null
                & git -C $Cfg.RepoDir pull --rebase --autostash origin main 2>&1 | Out-Null
                & git -C $Cfg.RepoDir push origin HEAD 2>&1 | Out-Null
            } catch {
                Add-Log ("Loi git push bao-dong: " + $_.Exception.Message)
            }
        }
    }
    return $alarmLine
}

# ---- Kiem tra tho dang chay (phan biet bang command line hoac PID phien dang giam sat) ----
function Test-WorkerRunning([hashtable]$Lane, [System.Collections.IDictionary]$State = $null) {
    if ($SessionMonitorEnabled -and $null -ne $State -and $State.activeSessions.Contains($Lane.Name)) {
        $sess = $State.activeSessions[$Lane.Name]
        if ($null -ne $sess) {
            $ver = Test-SessionProcessVerified $sess
            if ($ver.Exists -and $ver.Verified) { return $true }
        }
    }
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
        $gp = Get-Process -Name ($proc -replace '\.exe$', '') -ErrorAction SilentlyContinue
        return ($null -ne $gp)
    }
}

# ---- Dong bo repo (chi khi cac file tracked trong pham vi sach, chi ff-only, loi thi bo qua) ----
function Sync-Repo() {
    if (-not $Cfg.AutoSync) { return "tat" }
    try {
        $paths = @()
        if ($Cfg.ContainsKey("SyncPaths") -and $Cfg.SyncPaths) { $paths = @($Cfg.SyncPaths) }
        $statusArgs = @("-C", $Cfg.RepoDir, "status", "--porcelain", "-uno")
        if ($paths.Count -gt 0) { $statusArgs += "--"; $statusArgs += $paths }
        $dirty = & git @statusArgs 2>&1 | Out-String
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
function Clear-LastLaunch([string]$LaneName) {
    $f = Join-Path $StateDir ("last-launch-" + $LaneName + ".txt")
    if (Test-Path -LiteralPath $f) {
        Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    }
}

# ---- Giam sat cac phien dang chay cua 1 lane ----
function Invoke-LaneSessionMonitor([hashtable]$Lane, [System.Collections.IDictionary]$State) {
    if (-not $SessionMonitorEnabled) { return }
    if (-not $State.activeSessions.Contains($Lane.Name)) { return }
    $sess = $State.activeSessions[$Lane.Name]
    if ($null -eq $sess) { return }

    $ticketId = [string]$sess["ticket"]
    $resFile = Test-TicketResultExists $sess
    if ($null -ne $resFile) {
        # Tho da nop ket qua -> hoan thanh phien, giai phong giam sat, khong dung vao tien trinh
        Add-LaunchLog ("HOAN-THANH-PHIEN | project={0} lane={1} ticket={2} ketQua={3} startedAt={4} deadlineAt={5}" -f $Cfg.Name, $Lane.Name, $ticketId, $resFile, $sess["startedAt"], $sess["deadlineAt"])
        $State.closedTickets[$ticketId] = [ordered]@{
            ticket     = $ticketId
            lane       = $Lane.Name
            outcome    = "completed"
            resultFile = $resFile
            closedAt   = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        }
        $State.activeSessions.Remove($Lane.Name)
        Save-SessionState $State
        Add-LaunchLog ("GIAI-PHONG-REGISTRY | project={0} lane={1} ticket={2} lyDo=da-co-ket-qua" -f $Cfg.Name, $Lane.Name, $ticketId)
        return
    }

    $deadlineDt = [DateTime]::MaxValue
    $okDl = [DateTime]::TryParseExact([string]$sess["deadlineAt"], "yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$deadlineDt)
    if (-not $okDl) { return }

    # Cap nhat moc tien do moi nhat trong thu muc ket qua cua ve
    $prog = Get-TicketLastProgress $sess
    $sess["lastActivityAt"] = $prog.LastProgressStr
    $sess["lastActivityFile"] = $prog.LastFile
    $noProgMinutes = $DefaultNoProgressMinutes
    $sess["noProgressTimeoutMinutes"] = $noProgMinutes

    $now = Get-Date
    $idleMinutes = ($now - $prog.LastProgressAt).TotalMinutes
    $isStalled = ($noProgMinutes -gt 0 -and $idleMinutes -ge $noProgMinutes)
    $isPastHardCap = ($now -ge $deadlineDt)

    if (-not $isStalled -and -not $isPastHardCap) {
        # Chua vi pham han tien do va chua cham tran cung: cap nhat treePids neu tien trinh goc van song
        $ver = Test-SessionProcessVerified $sess
        if ($ver.Exists -and $ver.Verified) {
            $curTree = Get-ProcessTreePids -RootPid $ver.Pid -RootStartTime $ver.RecStart
            $merged = New-Object System.Collections.Generic.List[int]
            if ($sess.Contains("treePids") -and $sess["treePids"]) {
                foreach ($p in $sess["treePids"]) {
                    if (-not $merged.Contains([int]$p)) { $merged.Add([int]$p) }
                }
            }
            foreach ($p in $curTree) {
                if (-not $merged.Contains([int]$p)) { $merged.Add([int]$p) }
            }
            $sess["treePids"] = @($merged.ToArray())
        }
        Save-SessionState $State
        return
    }

    # PHAT HIEN PHIEN CHET (do treo tien do hoac cham tran cung) -> Xu ly dung thu tu (a) -> (b) -> (c)
    $dlHours = [double]$sess["deadlineHours"]
    $triggerType = $(if ($isStalled) { "no-progress" } else { "hard-deadline" })
    if ($isStalled) {
        Add-LaunchLog ("PHAT-HIEN-TREO-TIEN-DO | project={0} lane={1} ticket={2} loai={3} startedAt={4} lastActivityAt={5} lastFile={6} idleMinutes={7}p hanTienDo={8}p deadlineAt={9}" -f $Cfg.Name, $Lane.Name, $ticketId, $sess["ticketType"], $sess["startedAt"], $prog.LastProgressStr, $prog.LastFile, [Math]::Round($idleMinutes, 1), $noProgMinutes, $sess["deadlineAt"])
    } else {
        Add-LaunchLog ("PHAT-HIEN-QUA-HAN | project={0} lane={1} ticket={2} loai={3} startedAt={4} deadlineAt={5} han={6}h" -f $Cfg.Name, $Lane.Name, $ticketId, $sess["ticketType"], $sess["startedAt"], $sess["deadlineAt"], $dlHours)
    }

    # (a) Giet dung cay tien trinh tho cua ve do (hoac tu choi giet neu PID khong khop/tai su dung)
    $killRes = Invoke-KillSessionTree $sess
    if ($killRes.Action -eq "mismatch-not-killed") {
        Add-LaunchLog ("BAO-DONG-PID-KHONG-KHOP | project={0} lane={1} ticket={2} pid={3} lyDo={4} -> KHONG-GIET-TIEN-TRINH" -f $Cfg.Name, $Lane.Name, $ticketId, $killRes.RootPid, $killRes.Reason)
    } else {
        $killedStr = "khong-con-process-song"
        if ($killRes.KilledPids -and $killRes.KilledPids.Count -gt 0) {
            $killedStr = ($killRes.KilledPids -join ",")
        }
        Add-LaunchLog ("GIET-PHIEN-THO | project={0} lane={1} ticket={2} rootPid={3} killedPids=[{4}] lyDo={5}" -f $Cfg.Name, $Lane.Name, $ticketId, $killRes.RootPid, $killedStr, $killRes.Reason)
    }

    # (b) APPEND dung mot dong bao dong vao cuoi tep trang-thai.md cua hop thu do
    $statusFilePath = [string]$sess["statusFile"]
    if (-not $statusFilePath) {
        $statusFilePath = $Lane.StatusFile
        if (-not [System.IO.Path]::IsPathRooted($statusFilePath)) {
            $statusFilePath = Join-Path $Cfg.RepoDir $statusFilePath
        }
    }
    $alarmLine = Append-MailboxAlarm -StatusFilePath $statusFilePath -TicketId $ticketId -DeadlineHours $dlHours -KillAction $killRes.Action -RootPid $killRes.RootPid -Reason $killRes.Reason -TriggerType $triggerType -NoProgressMinutes $noProgMinutes -LastProgressStr $prog.LastProgressStr
    Add-LaunchLog ("GHI-BAO-DONG | project={0} lane={1} ticket={2} file={3} line={4}" -f $Cfg.Name, $Lane.Name, $ticketId, $statusFilePath, $alarmLine)

    # (c) Giai phong registry cua ve do de mot ve moi (ma moi) cho cung viec khong bi chan
    $State.closedTickets[$ticketId] = [ordered]@{
        ticket         = $ticketId
        lane           = $Lane.Name
        outcome        = $(if ($killRes.Action -eq "mismatch-not-killed") { "timeout-pid-mismatch" } elseif ($isStalled) { "timeout-no-progress" } else { "timeout-killed" })
        trigger        = $triggerType
        lastActivityAt = $prog.LastProgressStr
        rootPid        = $killRes.RootPid
        killedPids     = @($killRes.KilledPids)
        closedAt       = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }
    $State.activeSessions.Remove($Lane.Name)
    Clear-LastLaunch $Lane.Name
    Save-SessionState $State
    Add-LaunchLog ("GIAI-PHONG-REGISTRY | project={0} lane={1} ticket={2} lyDo={3} -> Da giai phong slot lane {1} cho ve moi (ma moi), khoa ma cu {2}" -f $Cfg.Name, $Lane.Name, $ticketId, $triggerType)
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
        $tmp = Join-Path $StateRoot ("tong-quan." + $Cfg.Name + ".html.tmp")
        $dst = Join-Path $StateRoot "tong-quan.html"
        Write-Utf8NoBom $tmp $sb.ToString()
        Move-Item -LiteralPath $tmp -Destination $dst -Force
    } catch { Add-Log ("Loi sinh tong quan: " + $_.Exception.Message) }
}

# ---- Mot vong quet ----
function Invoke-Cycle() {
    $syncNote = Sync-Repo
    $state = $null
    if ($SessionMonitorEnabled) {
        $state = Load-SessionState
    }
    $laneResults = @()
    foreach ($lane in $Cfg.Lanes) {
        if ($SessionMonitorEnabled) {
            Invoke-LaneSessionMonitor -Lane $lane -State $state
        }

        $closedIds = @()
        if ($SessionMonitorEnabled -and $null -ne $state -and $state.closedTickets) {
            $closedIds = @($state.closedTickets.Keys)
        }
        $st = Read-LaneStatus -Lane $lane -ClosedTicketIds $closedIds

        if ($SessionMonitorEnabled -and $st.Status -eq "moi" -and $st.Ticket -ne "" -and ($closedIds -notcontains $st.Ticket)) {
            $preInfo = Resolve-TicketDetails -Lane $lane -LaneStatus $st
            $preCheckSess = [ordered]@{
                ticket              = $preInfo.TicketId
                ticketFile          = $preInfo.TicketFile
                mailboxDir          = $preInfo.MailboxDir
                explicitResultPaths = $preInfo.ExplicitResultPaths
            }
            $existingRes = Test-TicketResultExists $preCheckSess
            if ($null -ne $existingRes) {
                Add-LaunchLog ("BO-QUA-VE-DA-CO-KET-QUA | project={0} lane={1} ticket={2} ketQua={3}" -f $Cfg.Name, $lane.Name, $preInfo.TicketId, $existingRes)
                $state.closedTickets[$preInfo.TicketId] = [ordered]@{
                    ticket     = $preInfo.TicketId
                    lane       = $lane.Name
                    outcome    = "completed-preexisting"
                    resultFile = $existingRes
                    closedAt   = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
                }
                Save-SessionState $state
                $closedIds = @($state.closedTickets.Keys)
            }
        }

        $running = Test-WorkerRunning -Lane $lane -State $state
        $paused = (Test-Path -LiteralPath (Join-Path $StateDir "PAUSE")) -or (Test-Path -LiteralPath (Join-Path $StateDir ("PAUSE-" + $lane.Name)))
        $lastLaunch = Get-LastLaunch $lane.Name
        $runningFile = Join-Path $StateDir ("running-" + $lane.Name + ".json")

        $hasActiveSession = $false
        $isClosedTicket = $false
        if ($SessionMonitorEnabled -and $null -ne $state) {
            $hasActiveSession = $state.activeSessions.Contains($lane.Name)
            if ($st.Ticket -ne "" -and $state.closedTickets.Contains($st.Ticket)) {
                $isClosedTicket = $true
            }
        } else {
            if ((Test-Path -LiteralPath $runningFile) -and -not $running) {
                $age = (Get-Date) - (Get-Item -LiteralPath $runningFile).LastWriteTime
                if ($age.TotalMinutes -gt 5) { Remove-Item -LiteralPath $runningFile -Force -ErrorAction SilentlyContinue }
            }
        }

        $freshRun = $false
        if (-not $SessionMonitorEnabled -and (Test-Path -LiteralPath $runningFile)) {
            $age2 = (Get-Date) - (Get-Item -LiteralPath $runningFile).LastWriteTime
            if ($age2.TotalMinutes -lt 3) { $freshRun = $true }
        }

        $cooldownOk = $true
        $minGap = 15
        if ($null -ne $Cfg.MinLaunchIntervalMinutes) { $minGap = [double]$Cfg.MinLaunchIntervalMinutes }
        if ($lastLaunch -and (((Get-Date) - $lastLaunch).TotalMinutes -lt $minGap)) { $cooldownOk = $false }

        if ($Cfg.Mode -eq "auto" -and $st.Status -eq "moi" -and -not $running -and -not $freshRun -and -not $paused -and $cooldownOk -and -not $hasActiveSession -and -not $isClosedTicket) {
            $prompt = [string]$lane.Prompt
            $args = ([string]$lane.LaunchArgsTemplate).Replace("{Prompt}", $prompt)
            if ($DryRun) {
                if ($SessionMonitorEnabled) {
                    $tInfoDry = Resolve-TicketDetails -Lane $lane -LaneStatus $st
                    Add-Log ("[DRYRUN] Se mo tho lane {0}: ticket={1} loai={2} hanTienDo={3}p tran={4}h cmd={5} {6} (wd={7})" -f $lane.Name, $tInfoDry.TicketId, $tInfoDry.TicketType, $DefaultNoProgressMinutes, $tInfoDry.DeadlineHours, $lane.LaunchCommand, $args, $lane.WorkDir)
                } else {
                    Add-Log ("[DRYRUN] Se mo tho lane {0}: {1} {2} (wd={3})" -f $lane.Name, $lane.LaunchCommand, $args, $lane.WorkDir)
                }
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

                    if ($SessionMonitorEnabled) {
                        Start-Sleep -Milliseconds 250
                        $tInfo = Resolve-TicketDetails -Lane $lane -LaneStatus $st
                        $pIdent = Get-ProcessIdentity -PidVal $pidVal
                        if (-not $pIdent.StartTime) {
                            try {
                                if ($proc -and $proc.StartTime) {
                                    $pIdent.StartTime = $proc.StartTime
                                    $pIdent.StartTimeIso = $proc.StartTime.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
                                }
                            } catch {}
                        }
                        if (-not $pIdent.Name -and $proc) {
                            try { $pIdent.Name = $proc.ProcessName + ".exe" } catch {}
                        }
                        $treePids = Get-ProcessTreePids -RootPid $pidVal -RootStartTime $pIdent.StartTime
                        if ($treePids.Count -eq 0 -and $pidVal -gt 0) { $treePids = @($pidVal) }

                        $startedDt = Get-Date
                        $deadlineDt = $startedDt.AddHours([double]$tInfo.DeadlineHours)
                        $sessRec = [ordered]@{
                            ticket                   = $tInfo.TicketId
                            ticketFile               = $tInfo.TicketFile
                            ticketType               = $tInfo.TicketType
                            project                  = $Cfg.Name
                            lane                     = $lane.Name
                            mailboxDir               = $tInfo.MailboxDir
                            statusFile               = $tInfo.StatusFileFull
                            rootPid                  = $pidVal
                            treePids                 = @($treePids)
                            processName              = $pIdent.Name
                            processStartTime         = $pIdent.StartTimeIso
                            commandLine              = $pIdent.CommandLine
                            startedAt                = $startedDt.ToString("yyyy-MM-dd HH:mm:ss")
                            lastActivityAt           = $startedDt.ToString("yyyy-MM-dd HH:mm:ss")
                            lastActivityFile         = "(startedAt)"
                            noProgressTimeoutMinutes = $DefaultNoProgressMinutes
                            deadlineAt               = $deadlineDt.ToString("yyyy-MM-dd HH:mm:ss")
                            deadlineHours            = [double]$tInfo.DeadlineHours
                            explicitResultPaths      = @($tInfo.ExplicitResultPaths)
                        }
                        $state.activeSessions[$lane.Name] = $sessRec
                        Save-SessionState $state
                        $running = $true
                        Add-LaunchLog ("MO-THO | project={0} lane={1} ticket={2} loai={3} pid={4} treePids=[{5}] startedAt={6} hanTienDo={7}p deadlineAt={8} tran={9}h" -f $Cfg.Name, $lane.Name, $tInfo.TicketId, $tInfo.TicketType, $pidVal, ($treePids -join ","), $sessRec.startedAt, $DefaultNoProgressMinutes, $sessRec.deadlineAt, $tInfo.DeadlineHours)
                    } else {
                        $rec = [ordered]@{ pid = $pidVal; started = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); ticket = $st.Ticket } | ConvertTo-Json -Compress
                        Write-Utf8NoBom $runningFile $rec
                        Add-LaunchLog ("MO-THO | project={0} lane={1} ticket={2} pid={3}" -f $Cfg.Name, $lane.Name, $st.Ticket, $pidVal)
                    }
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
    Write-LaneHeartbeat -LaneResults $laneResults -SyncNote $syncNote
    Write-Overview
}

function Write-LaneHeartbeat([array]$LaneResults = @(), [string]$SyncNote = "init") {
    $hbPath = Join-Path $StateDir "heartbeat.txt"
    try {
        $now = Get-Date
        $isoTs = $now.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $vnTs = $now.ToString("yyyy-MM-dd HH:mm:ss") + " +07"
        $laneSumm = "init"
        if ($LaneResults -and $LaneResults.Count -gt 0) {
            $parts = @()
            foreach ($lr in $LaneResults) {
                $parts += ("{0}:{1}(ticket={2},worker={3})" -f $lr.name, $lr.status, $(if ($lr.ticket) { $lr.ticket } else { "none" }), $lr.workerRunning)
            }
            $laneSumm = ($parts -join ";")
        }
        $line = "[{0}] ({1}) | pid: {2} | project: {3} | mode: {4} | lanes: {5} | sync: {6}" -f $isoTs, $vnTs, $PID, $Cfg.Name, $Cfg.Mode, $laneSumm, $SyncNote
        [System.IO.File]::AppendAllText($hbPath, $line + "`r`n", $Utf8NoBom)
        if ((Test-Path -LiteralPath $hbPath) -and ((Get-Item -LiteralPath $hbPath).Length -gt 200000)) {
            $allLines = [System.IO.File]::ReadAllLines($hbPath, $Utf8NoBom)
            if ($allLines.Count -gt 500) {
                $tail = $allLines[($allLines.Count - 500)..($allLines.Count - 1)]
                Write-Utf8NoBom $hbPath (($tail -join "`r`n") + "`r`n")
            }
        }
    } catch {
        Add-Log ("Loi ghi heartbeat.txt: " + $_.Exception.Message)
    }
}

Add-Log ("Watcher khoi dong: project={0} mode={1} sessionMonitor={2} noProgressMin={3} dryrun={4} once={5}" -f $Cfg.Name, $Cfg.Mode, $SessionMonitorEnabled, $DefaultNoProgressMinutes, $DryRun.IsPresent, $Once.IsPresent)
Write-LaneHeartbeat -LaneResults @() -SyncNote "startup"
try {
    do {
        try {
            Invoke-Cycle
        } catch {
            Add-Log ("Loi vong quet: " + $_.Exception.Message)
            Write-LaneHeartbeat -LaneResults @() -SyncNote ("cycle-err:" + $_.Exception.Message)
        }
        if ($Once) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
} finally {
    if ($LockStream) { $LockStream.Close() }
    Add-Log "Watcher dung."
}
