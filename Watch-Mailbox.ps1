# Watch-Mailbox.ps1 (v5) — watcher + giám sát OMP, vòng lặp cưỡng chế 2 đầu
#
# Đầu 1 (Muse, trên VM): viết ticket -> poll 5 phút -> review.
# Đầu 2 (script này, máy Windows): poll mailbox mỗi ~90s, và:
#   - Ticket `moi` + OMP đang rảnh  -> popup (hoặc TỰ MỞ OMP nếu bật AUTO_LAUNCH)
#   - Ticket `moi` + OMP đang mở nhưng chưa nhận -> nhắc nhẹ 1 lần
#   - `dang-lam` + thấy process OMP  -> IM LẶNG (đang làm thì thôi)
#   - `dang-lam` + KHÔNG thấy process -> cảnh báo (có thể crash giữa chừng)
#   - `dang-lam` quá 20 phút không tiến triển -> cảnh báo kẹt
#   - `xong-cho-duyet` -> popup (Muse sẽ review); KHÔNG tự dừng ở đây vì
#     có thể đang chờ user duyệt ticket tiếp theo
#   - `xong` ổn định đủ $idleExitChecks lần check liên tiếp -> popup tổng kết
#     + TỰ DỪNG script (vòng lặp kết thúc thật sự)
#
# Cài đặt: xem HUONG-DAN-WATCHER.md.
# -MailboxDir: thư mục mailbox trên repo (mặc định "docs/phieu-viec/mailbox" = máy nhà).
#   Máy công ty chạy: .\Watch-Mailbox.ps1 -MailboxDir "docs/phieu-viec/mailbox-pc0575"

param(
    [string]$MailboxDir = "docs/phieu-viec/mailbox",
    [string]$Worker = "omp",
    [string]$AgyModel = "gemini-3.8-flash-high",
    [string]$OpenCodeModel = "opencode/muse-spark-1.3-contributor-free"
)

$ErrorActionPreference = "SilentlyContinue"

# ================= CẤU HÌNH (sửa cho đúng máy mình) =================
$owner          = "Nakazasen"
$repo           = "AIOS_habbit"
$branch         = "phieu-viec/rag-fix1"
$pollSeconds    = 90
$moiWarnMinutes = 15    # ticket moi quá N phút không ai nhận -> nhắc lại
$stuckMinutes   = 20    # dang-lam quá N phút không tiến triển -> báo kẹt
$idleExitChecks = 3     # thấy `xong` ổn định đủ N lần check liên tiếp -> tự dừng

# --- Giám sát OMP ---
# Tên process OMP trong Task Manager > Details (không có .exe).
$ompProcessName = "omp"

# $false = chỉ popup nhắc (an toàn, mặc định).
# $true  = tự mở OMP chạy ticket khi OMP đang rảnh (CHỈ bật khi OMP hỗ trợ
#          chạy kèm prompt từ dòng lệnh, và bạn chấp nhận OMP tự chạy).
$AUTO_LAUNCH = $true
# $ompLaunchCommand = "C:\tools\omp.exe"
# Vi du cu (khong dung): $ompLaunchArgs = @("-p", "...") -- array vo khong quote, dung string nhu tren
$aiosDir           = "D:\Sandbox\AIOS_habbit"
$ompLaunchCommand = "C:\Users\Admin\AppData\Local\omp\omp.exe"
# $true = mo cua so de nhin chu chay (yen tam); $false = chay an hoan toan.
$SHOW_WORKER_WINDOW = $true
# Nhat ky tho (phan biet ket that vs dang lam viec dai):
$sessionDir       = "C:\Users\Admin\.omp\agent\sessions\--D--Sandbox-AIOS_habbit--"
$heartbeatMinutes = 5
# $true = tu mo lai tho khi bien mat giua chung (chi khi khong con process OMP nao).
$AUTO_RELAUNCH = $true
$relaunchCooldownMinutes = 10  # moi ve duoc mo lai toi da 1 lan moi N phut
$maxStallLaunches = 4  # spec N=4: 4 su kien cach nhau 10p (~30p) khong tien trien -> escalate cho-muse (code-level, khong trong cho OMP tu giac)
# --- Chong chet im (batch 1) ---
$maxPollFails = 5        # poll loi lien tiep N lan (~7.5 phut) -> popup (mang/GitHub chet)
$choMuseSlaHours = 6     # cho-muse dung yen qua N gio -> popup (cron Muse co the dung)
$minDiskGB = 1           # o nao duoi N GB -> popup + tam ngung mo tho moi
$ompLaunchTicket = "git pull origin phieu-viec/rag-fix1; doc ky $MailboxDir/QUY-UOC.md va $MailboxDir/prompt.md roi lam dung theo ticket, tuan thu quy uoc (commit + push + cap nhat trang-thai.md). Vua lam vua giai thich ngan gon tung buoc bang tieng Viet don gian. Den moi moc quan trong: cap nhat ngay 1 dong tien do + timestamp vao trang-thai.md roi push. Kiem cong gate: neu 4 lan watcher tu mo OMP lien tiep (moi lan cach nhau ~10 phut) ma van chua thay dieu kien mo thi dat trang-thai.md thanh cho-muse + DUNG, khong quay no-op."
$ompLaunchArgs = '-p --auto-approve "{0}"' -f $ompLaunchTicket

# --- Tho phu: agy (Antigravity CLI) ---
# Headless: agy --model <model> -p --dangerously-skip-permissions "<ticket>"
# Model mac dinh viec thuong: gemini-3.8-flash-high; viec kho: claude-sonnet-5-5-medium / claude-opus-5-5-medium.
$agyProcessName = "agy"
$agyLaunchCommand = "C:\Users\Admin\AppData\Local\agy\bin\agy.exe"
$agyModel = $AgyModel

# --- Tho phu: opencode (free) ---
# Headless: opencode run --model <model> --dangerously-skip-permissions "<ticket>" --dir <aiosDir>
# Chay qua powershell wrapper (opencode.ps1 -> node.exe) de Start-Process on dinh.
$opencodeShim = "C:\Users\Admin\AppData\Roaming\npm\opencode.ps1"
$opencodeLaunchCommand = "powershell.exe"
$opencodeModel = $OpenCodeModel
# CLI opencode `run` tu dung server hay hong (Session not found) -> dung server
# thuong truc 127.0.0.1:$opencodePort + `run --attach`. Watcher tu dung server
# khi can (chi localhost, nhe).
$opencodePort = 4096
# =====================================================================

# --- Chot tho cho lan chay nay (che do B: moi watcher 1 tho, 1 mailbox) ---
$worker = $Worker.ToLower()
if ($worker -ne "omp" -and $worker -ne "agy" -and $worker -ne "opencode") { $worker = "omp" }
# Ve goi tho theo ten tho hien tai (tranh ghi cung "OMP" cho ca 3).
$workerTicket = $ompLaunchTicket -replace 'tu mo OMP', ("tu mo " + $worker)
$activeProcessName = $ompProcessName
$activeLaunchCommand = $ompLaunchCommand
$activeLaunchArgsTemplate = $ompLaunchArgs
$activeSessionDir = $sessionDir
if ($worker -eq "agy") {
    $activeProcessName = $agyProcessName
    $activeLaunchCommand = $agyLaunchCommand
    # Luu y: -p nuot token ke tiep lam prompt -> prompt phai dinh kem -p, co khac dung truoc.
    $activeLaunchArgsTemplate = '--model {0} --dangerously-skip-permissions -p "{1}"' -f $agyModel, $workerTicket
    $activeSessionDir = ""
} elseif ($worker -eq "opencode") {
    $activeLaunchCommand = $opencodeLaunchCommand
    $activeLaunchArgsTemplate = '-NoProfile -ExecutionPolicy Bypass -File "{0}" run "{2}" --attach http://127.0.0.1:{4} --model {1} --dangerously-skip-permissions --dir "{3}"' -f $opencodeShim, $opencodeModel, $workerTicket, $aiosDir, $opencodePort
    $activeSessionDir = ""
}
function Test-OpencodeServer {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $r = $c.BeginConnect("127.0.0.1", $opencodePort, $null, $null)
        $ok = $r.AsyncWaitHandle.WaitOne(1500)
        if ($ok) { $c.EndConnect($r) }
        $c.Close()
        return $ok
    } catch { return $false }
}
function Ensure-OpencodeServer {
    if (Test-OpencodeServer) { return $true }
    $serveArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" serve --port {1}' -f $opencodeShim, $opencodePort
    Start-Process -FilePath "powershell.exe" -ArgumentList $serveArgs -WorkingDirectory $aiosDir -WindowStyle Hidden
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OpencodeServer) { Write-Log ("OPENCODE-SRV: server len o port $opencodePort"); return $true }
    }
    Write-Log ("OPENCODE-SRV: khong dung duoc server port $opencodePort")
    return $false
}
function Test-WorkerRunning {
    if ($worker -eq "opencode") {
        $hit = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*opencode*run*"
        }
        return $null -ne $hit
    }
    if ($worker -eq "agy") {
        # Loai tien trinh hub nen cua Antigravity IDE (--hub, chay thuong truc);
        # chi tinh tho worker (co -p/--print trong dong lenh).
        $hit = Get-CimInstance Win32_Process -Filter "Name='agy.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -notlike "*--hub*" }
        return $null -ne $hit
    }
    return $null -ne (Get-Process -Name $activeProcessName -ErrorAction SilentlyContinue)
}
function Invoke-WorkerLaunch {
    if ($worker -eq "opencode") { Ensure-OpencodeServer | Out-Null }
    if ($SHOW_WORKER_WINDOW) {
        Start-Process -FilePath $activeLaunchCommand -ArgumentList $activeLaunchArgsTemplate -WorkingDirectory $aiosDir
    } else {
        if ($activeLaunchCommand -like "*powershell.exe") {
            Start-Process -FilePath $activeLaunchCommand -ArgumentList $activeLaunchArgsTemplate -WorkingDirectory $aiosDir -WindowStyle Hidden
        } else {
            Start-Process -FilePath $activeLaunchCommand -ArgumentList $activeLaunchArgsTemplate -WorkingDirectory $aiosDir -WindowStyle Hidden
        }
    }
}

# Cau hinh rieng tung may (neu co): file cung thu muc ten config.local.ps1.
# Copy config.mau.ps1 (hoac config.PC0575.ps1) thanh config.local.ps1 roi sua theo may.
$localCfg = Join-Path $PSScriptRoot "config.local.ps1"
if (Test-Path -LiteralPath $localCfg) { . $localCfg }
# Dung lai lenh goi tho sau khi nap config rieng (phong port/model bi doi).
# Chu y: tho omp CUNG phai dung lai (truoc day giu duong dan mac dinh C:\Users\Admin\... nen mo tho that bai).
if ($worker -eq "omp") {
    $activeProcessName = $ompProcessName
    $activeLaunchCommand = $ompLaunchCommand
    $activeLaunchArgsTemplate = $ompLaunchArgs
    $activeSessionDir = $sessionDir
} elseif ($worker -eq "agy") {
    $activeLaunchCommand = $agyLaunchCommand
    $activeLaunchArgsTemplate = '--model {0} --dangerously-skip-permissions -p "{1}"' -f $agyModel, $workerTicket
} elseif ($worker -eq "opencode") {
    $activeLaunchCommand = $opencodeLaunchCommand
    $activeLaunchArgsTemplate = '-NoProfile -ExecutionPolicy Bypass -File "{0}" run "{2}" --attach http://127.0.0.1:{4} --model {1} --dangerously-skip-permissions --dir "{3}"' -f $opencodeShim, $opencodeModel, $workerTicket, $aiosDir, $opencodePort
}
$mailboxTag = Split-Path $MailboxDir -Leaf
if ($mailboxTag -eq "mailbox") { $mailboxTag = "" } else { $mailboxTag = "-" + $mailboxTag }
if ($worker -ne "omp") { $mailboxTag = "$mailboxTag-$worker" }
$stateFile  = Join-Path $PSScriptRoot ("watcher_state{0}.json" -f $mailboxTag)
$ticketFile = Join-Path $PSScriptRoot ("_ticket-moi{0}.md" -f $mailboxTag)
$logFile    = Join-Path $PSScriptRoot ("watcher{0}.log" -f $mailboxTag)
# Muon poll moi 60 giay: tao token fine-grained (quyen Contents: read),
# bo comment dong duoi va dan token vao. KHONG commit token len git.
# $token = "DAN_TOKEN_VAO_DAY"

$mutex = New-Object System.Threading.Mutex($false, "Global\MailboxWatcher$mailboxTag")
if (-not $mutex.WaitOne(0)) { exit }

function Get-MailboxFile {
    param([string]$path)
    $url = "https://api.github.com/repos/$owner/$repo/contents/${path}?ref=" + [uri]::EscapeDataString($branch)
    $headers = @{"Accept" = "application/vnd.github+json"; "User-Agent" = "mailbox-watcher"}
    if ($token) { $headers["Authorization"] = "Bearer $token" }
    $data = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 30
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($data.content))
}
function Show-Popup {
    param([string]$title, [string]$msg)
    (New-Object -ComObject Wscript.Shell).Popup($msg, 25, $title, 64) | Out-Null
}
function Parse-Field {
    param([string]$text, [string]$pattern)
    if ($text -match $pattern) { return $Matches[1].Trim() }
    return ""
}
function Test-OmpRunning {
    return Test-WorkerRunning
}
function Get-SessionAgeMinutes {
    if ([string]::IsNullOrWhiteSpace($activeSessionDir)) { return $null }
    $sf = Get-ChildItem -LiteralPath $activeSessionDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($sf -eq $null) { return $null }
    return ((Get-Date) - $sf.LastWriteTime).TotalMinutes
}
function Write-Log($msg) {
    ("[{0}] {1}" -f (Get-Date).ToString("s"), $msg) | Out-File $logFile -Append -Encoding utf8
}
function Invoke-StallEscalation {
    # Gate that that: dem code-level so lan watcher tu mo OMP ma sig khong doi.
    # Thu tu theo spec: ghi cho-muse -> commit + push -> xac nhan push moi ngung mo.
    # Push fail -> tra $false de caller popup bao dong (cron Muse doc tu GitHub).
    param([string]$stallSig, [string]$stallTicket, [string]$stallStatus, [int]$stallCount)
    $mailboxRel = "$MailboxDir/trang-thai.md"
    $mailboxFile = Join-Path $aiosDir $mailboxRel
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm")
    $reason = "$ts watcher auto-escalate: $stallCount lan tu mo $worker (moi lan cach ~${relaunchCooldownMinutes} phut) ma mailbox khong tien trien. Chuyen sang cho-muse de Muse xu ly. Ticket: $stallTicket"
    if (-not (Test-Path -LiteralPath $mailboxFile)) {
        Show-Popup "Mailbox: escalate THAT BAI" ("Khong tim thay file local:`n$mailboxFile`n`nCron Muse doc tu GitHub nen can push. Kiem tra aiosDir.")
        Write-Log ("ESCALATE FAIL: missing file $mailboxFile sig=$stallSig")
        return $false
    }
    try {
        $c = Get-Content -LiteralPath $mailboxFile -Raw -Encoding UTF8
        if ($c -match 'Trạng thái:\s*`[^`]+`') {
            $c = $c -replace 'Trạng thái:\s*`[^`]+`', 'Trạng thái: `cho-muse`'
        } else { throw "khong tim thay dong Trang thai" }
        if ($c -match '(?m)^\s*-\s*`?ghi_chu`?\s*:') {
            $c = $c -replace '(?m)^\s*-\s*`?ghi_chu`?\s*:.*$', ("- ``ghi_chu``: " + $reason)
        } else {
            $c = $c.TrimEnd() + "`r`n- ``ghi_chu``: " + $reason + "`r`n"
        }
        $c | Out-File -LiteralPath $mailboxFile -Encoding utf8
    } catch {
        Show-Popup "Mailbox: escalate THAT BAI" ("Ghi cho-muse that bai: $($_.Exception.Message)")
        Write-Log ("ESCALATE FAIL write: " + $_.Exception.Message)
        return $false
    }
    try {
        # Keo ve moi nhat truoc khi sua (sach se moi rebase duoc; fail thi abort + mo tho du phong o caller).
        $syncOut = & git -C $aiosDir pull --rebase origin $branch 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            & git -C $aiosDir rebase --abort 2>&1 | Out-Null
            Show-Popup "Mailbox: escalate THAT BAI" ("Pull-rebase that bai truoc khi day cho-muse.`n$stallTicket`n`nSe van mo tho chay tiep thay vi cho. Tu pull-rebase + day tay neu can.`n$syncOut")
            Write-Log ("ESCALATE FAIL sync: $syncOut")
            return $false
        }
        $addOut = & git -C $aiosDir add $mailboxRel 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Log ("ESCALATE FAIL add: $addOut")
            return $false
        }
        $commitOut = & git -C $aiosDir commit -m "watcher: escalate stall to cho-muse after $stallCount launches no progress ($stallStatus ticket $stallTicket)" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            & git -C $aiosDir checkout -- $mailboxRel 2>&1 | Out-Null
            Write-Log ("ESCALATE FAIL commit (da hoan tac sua local): $commitOut")
            return $false
        }
        $pushOut = & git -C $aiosDir push origin $branch 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { Write-Log ("ESCALATE OK: $stallSig -> cho-muse. $pushOut"); return $true }
        else {
            Show-Popup "Mailbox: escalate THAT BAI" ("Da $stallCount lan mo OMP khong tien trien nhung push cho-muse THAT BAI.`n$stallTicket`n`nCron Muse khong thay duoc - kiem tra git push tay.`n$pushOut")
            Write-Log ("ESCALATE FAIL push: $pushOut")
            return $false
        }
    } catch {
        Show-Popup "Mailbox: escalate THAT BAI" ("Push cho-muse that bai: $($_.Exception.Message)")
        Write-Log ("ESCALATE FAIL push ex: " + $_.Exception.Message)
        return $false
    }
}

$st = @{}
if (Test-Path $stateFile) { try { $st = Get-Content $stateFile -Raw | ConvertFrom-Json } catch {} }
function St-Get($k, $d) { if ($st.PSObject.Properties.Name -contains $k) { return $st.$k } else { return $d } }

$lastStatus     = St-Get "status" ""
$lastTicket     = St-Get "ticket" ""
$lastSig        = St-Get "sig" ""
$sigTime        = St-Get "sigTime" ""
$firstSeenMoi   = St-Get "firstSeenMoi" ""
$warnedMoi      = [bool](St-Get "warnedMoi" $false)
$warnedStuck    = [bool](St-Get "warnedStuck" $false)
$warnedIdle     = [bool](St-Get "warnedIdle" $false)
$warnedUnknown  = [bool](St-Get "warnedUnknown" $false)
$warnedSla      = [bool](St-Get "warnedSla" $false)
$warnedDisk     = [bool](St-Get "warnedDisk" $false)
$pollFails      = [int](St-Get "pollFails" 0)
$launchedTicket = St-Get "launchedTicket" ""
$launchedAt = St-Get "launchedAt" ""
$relaunchedTicket = St-Get "relaunchedTicket" ""
$relaunchedAt = St-Get "relaunchedAt" ""
$launchSig = St-Get "launchSig" ""
$launchStallCount = [int](St-Get "launchStallCount" 0)
$escalatedSig = St-Get "escalatedSig" ""
$idleCount      = [int](St-Get "idleCount" 0)
$ticketsDone    = @(St-Get "ticketsDone" @())
# Dem rieng ticket xong TRONG LAN CHAY NAY (khong luu state) - de quyet dinh co popup
# khi idle-exit hay khong. Tranh popup lap lai sau khi watchdog mo lai watcher.
$ticketsDoneThisRun = 0

while ($true) {
    try {
        $text       = Get-MailboxFile "$MailboxDir/trang-thai.md"
        $status     = Parse-Field $text 'Trạng thái:\s*`([^`]+)`'
        $ticket     = Parse-Field $text 'Ticket hiện tại:\s*([^\r\n]+)'
        $note       = Parse-Field $text '(?m)^\s*-\s*[Gg]hi ch[uú][:\s]`?([^`\r\n]+)'
        $commit     = Parse-Field $text '[Cc]ommit[^:0-9a-f]*`?([0-9a-f]{7,40})`?'
        $sig        = "$status|$ticket|$note|$commit"
        $now        = Get-Date
        $ompRunning = Test-OmpRunning

        # Chot o dia (C: chua session + o chua repo): day thi bao + ngung mo tho.
        $diskOK = $true; $diskInfo = ""
        try {
            $drives = @("C", $aiosDir.Substring(0, 1).ToUpper()) | Select-Object -Unique
            $low = @()
            foreach ($dd in $drives) {
                $fg = (Get-PSDrive -Name $dd -ErrorAction Stop).Free / 1GB
                if ($fg -lt $minDiskGB) { $low += ("{0}: ({1:N1} GB)" -f $dd, $fg) }
            }
            if ($low.Count -gt 0) {
                $diskOK = $false; $diskInfo = ($low -join ", ")
                if (-not $warnedDisk) {
                    Show-Popup "Mailbox: o dia sap day" ("O dia con duoi {0} GB: {1}.`n`nDa TAM NGUNG tu mo tho moi. Don o ngay (ve DON-O-C)." -f $minDiskGB, $diskInfo)
                    Write-Log ("DISK-LOW: $diskInfo (nguong {0} GB) - tam ngung launch" -f $minDiskGB)
                    $warnedDisk = $true
                }
            } else { $warnedDisk = $false }
        } catch { $diskOK = $true }

        $pollFails = 0
        if ($sig -ne $lastSig) { $lastSig = $sig; $sigTime = $now.ToString("s"); $warnedStuck = $false; $warnedUnknown = $false; $warnedSla = $false }

        # Ghi nhận ticket hoàn thành: chuyển sang xong-cho-duyet
        if ($status -eq "xong-cho-duyet" -and $lastStatus -ne "xong-cho-duyet" -and $ticket -ne "") {
            if ($ticketsDone -notcontains $ticket) { $ticketsDone += $ticket; $ticketsDoneThisRun++ }
        }

        $validStatuses = @("moi", "dang-lam", "xong-cho-duyet", "xong", "cho-muse")
        if ($validStatuses -notcontains $status) {
            # Trang thai la (sai format/encoding, Muse doi schema): bao ngay, khong im lang.
            $idleCount = 0
            if (-not $warnedUnknown) {
                Show-Popup ("Mailbox [{0}]: trang thai la" -f $worker) ("Trang thai doc duoc: '{0}'.`nKhong thuoc moi/dang-lam/xong-cho-duyet/xong/cho-muse.`n`nKiem tra file trang-thai.md (sai format/encoding?)." -f $status)
                Write-Log ("UNKNOWN-STATUS: '$status' ticket=$ticket")
                $warnedUnknown = $true
            }
        }
        elseif ($status -eq "xong") {
            # Trạng thái kết thúc: đếm số lần check ổn định liên tiếp rồi tự dừng
            $idleCount++
            if ($idleCount -ge $idleExitChecks) {
                $doneList = ($ticketsDone | Select-Object -Last 5) -join "`n- "
                if ($doneList -eq "") { $doneList = "(không ghi nhận)" }
                $summary = "Vong lap mailbox ket thuc.`n`nTicket da xong ($($ticketsDone.Count)):`n- $doneList`n`nWatcher tu dung sau $idleExitChecks lan check on dinh."
                # Chi popup khi lan chay NAY thuc su lam xong ve; neu chi idle (watchdog
                # mo lai sau khi da xong) thi chi ghi log, khong lam phien user.
                if ($ticketsDoneThisRun -gt 0) {
                    Show-Popup "Mailbox: hoan thanh" $summary
                }
                Write-Log "STOP: trang thai 'xong' on dinh $idleExitChecks lan. Tong ticket xong: $($ticketsDone.Count). (trong lan chay nay: $ticketsDoneThisRun)"
                exit
            }
        } else {
            $idleCount = 0

            if ($status -eq "moi") {
                $isNewTicket = ($ticket -ne $lastTicket -or $lastStatus -ne "moi")
                if ($isNewTicket) {
                    try {
                        $prompt = Get-MailboxFile "$MailboxDir/prompt.md"
                        $prompt | Out-File -FilePath $ticketFile -Encoding utf8
                    } catch {}
                    $firstSeenMoi = $now.ToString("s")
                    $warnedMoi = $false; $warnedIdle = $false
                }
                if (-not $ompRunning) {
                    if ($sig -eq $escalatedSig) {
                        # Da escalate sig nay roi -> cho Muse (cron 3p se thay), khong mo lai
                    } else {
                    $canLaunch = ($launchedTicket -ne $ticket -or $launchedAt -eq "" -or ((Get-Date) - [datetime]$launchedAt).TotalMinutes -ge $relaunchCooldownMinutes)
                    if ($AUTO_LAUNCH -and $activeLaunchCommand -ne "" -and $canLaunch -and $diskOK) {
                        if ($sig -eq $launchSig) { if ($launchStallCount -lt $maxStallLaunches) { $launchStallCount++ } } else { $launchSig = $sig; $launchStallCount = 1 }
                        if ($launchStallCount -ge $maxStallLaunches) {
                            Write-Log ("ESCALATE: sig stall $launchStallCount/$maxStallLaunches ticket=$ticket (moi)")
                            $ok = Invoke-StallEscalation -stallSig $sig -stallTicket $ticket -stallStatus $status -stallCount $launchStallCount
                            $launchedAt = $now.ToString("s"); $relaunchedAt = $now.ToString("s")
                            if ($ok) {
                                $escalatedSig = $sig
                                Show-Popup "Mailbox: escalate cho-muse" ("Watcher da tu mo {0} $launchStallCount lan (~30 phut) ma mailbox khong tien trien:`n$ticket`n`nDa chuyen sang cho-muse + push. Cron Muse (3 phut) se thay trong 15 phut SLA." -f $worker)
                                Write-Log ("ESCALATE OK: $sig -> cho-muse")
                            } else {
                                Invoke-WorkerLaunch
                                $launchedTicket = $ticket
                                Show-Popup ("Mailbox [{0}]: tu mo tho (du phong)" -f $worker) ("Day cho-muse that bai (xem log) nen van mo {0} chay ticket de khoi doi ve:`n$ticket" -f $worker)
                                Write-Log ("FALLBACK-LAUNCH [$worker] ticket=$ticket sig=$sig (escalate day that bai)")
                            }
                        } else {
                        Invoke-WorkerLaunch
                        $launchedTicket = $ticket
                        $launchedAt = $now.ToString("s")
                        Show-Popup ("Mailbox [{0}]: tu mo tho" -f $worker) ("Da tu dong mo {0} chay ticket:`n$ticket ($launchStallCount/$maxStallLaunches)")
                        Write-Log ("LAUNCH [$worker] $launchStallCount/$maxStallLaunches ticket=$ticket sig=$sig")
                        }
                    } elseif (-not $warnedIdle) {
                        Show-Popup ("Mailbox [{0}]: ticket moi (tho ranh)" -f $worker) ("Co ticket moi ma {0} chua chay:`n$ticket`n`nMo {0} len hoac bao no: doc mailbox, co ticket moi." -f $worker)
                        $warnedIdle = $true
                    } elseif (-not $warnedMoi -and $firstSeenMoi -ne "") {
                        $age = $now - [datetime]$firstSeenMoi
                        if ($age.TotalMinutes -ge $moiWarnMinutes) {
                            Show-Popup "Mailbox: ticket treo" ("Ticket moi da hon $moiWarnMinutes phut chua ai nhan:`n$ticket`n`nNhac {0}: git pull origin $branch roi doc mailbox." -f $worker)
                            $warnedMoi = $true
                        }
                    }
                    }
                } else {
                    if ($isNewTicket -and -not $warnedIdle) {
                        Show-Popup "Mailbox: ticket moi" ("Co ticket moi cho {0}:`n$ticket`n`nDa luu ban local: _ticket-moi.md`nBao {0} doc va lam theo prompt." -f $worker)
                        $warnedIdle = $true
                    }
                }
            }
            elseif ($status -eq "dang-lam") {
                $sessAge = Get-SessionAgeMinutes
                $sessFresh = ($sessAge -ne $null -and $sessAge -lt $heartbeatMinutes)
                if (-not $ompRunning) {
                    if ($sig -eq $escalatedSig) {
                        # Da escalate sig nay roi -> cho Muse, khong mo lai
                    } else {
                    $canRelaunch = ($relaunchedTicket -ne $ticket -or $relaunchedAt -eq "" -or ((Get-Date) - [datetime]$relaunchedAt).TotalMinutes -ge $relaunchCooldownMinutes)
                    if ($AUTO_RELAUNCH -and $activeLaunchCommand -ne "" -and $canRelaunch -and $diskOK) {
                        if ($sig -eq $launchSig) { if ($launchStallCount -lt $maxStallLaunches) { $launchStallCount++ } } else { $launchSig = $sig; $launchStallCount = 1 }
                        if ($launchStallCount -ge $maxStallLaunches) {
                            Write-Log ("ESCALATE: sig stall $launchStallCount/$maxStallLaunches ticket=$ticket (dang-lam)")
                            $ok = Invoke-StallEscalation -stallSig $sig -stallTicket $ticket -stallStatus $status -stallCount $launchStallCount
                            $launchedAt = $now.ToString("s"); $relaunchedAt = $now.ToString("s")
                            if ($ok) {
                                $escalatedSig = $sig
                                Show-Popup "Mailbox: escalate cho-muse" ("Watcher da tu mo lai {0} $launchStallCount lan (~30 phut) ma mailbox khong tien trien:`n$ticket`n`nDa chuyen sang cho-muse + push. Cron Muse (3 phut) se thay trong 15 phut SLA." -f $worker)
                                Write-Log ("ESCALATE OK: $sig -> cho-muse")
                            } else {
                                Invoke-WorkerLaunch
                                $relaunchedTicket = $ticket
                                Show-Popup ("Mailbox [{0}]: tu mo lai tho (du phong)" -f $worker) ("Day cho-muse that bai (xem log) nen van mo lai {0} chay tiep de khoi doi ve:`n$ticket" -f $worker)
                                Write-Log ("FALLBACK-RELAUNCH [$worker] ticket=$ticket sig=$sig (escalate day that bai)")
                            }
                        } else {
                        Invoke-WorkerLaunch
                        $relaunchedTicket = $ticket
                        $relaunchedAt = $now.ToString("s")
                        Show-Popup "Mailbox: tu mo lai tho" ("{0} bien mat giua chung khi dang lam:`n$ticket`n`nDa tu dong mo lai tho chay tiep ($launchStallCount/$maxStallLaunches)." -f $worker)
                        Write-Log ("RELAUNCH [$worker] $launchStallCount/$maxStallLaunches ticket=$ticket sig=$sig.")
                        }
                    } elseif (-not $warnedStuck) {
                        Show-Popup ("Mailbox: {0} bien mat?" -f $worker) ("Trang thai dang-lam nhung khong thay process {0} ({1}).`nCo the tho da crash giua chung - kiem tra terminal." -f $worker, $activeProcessName)
                        $warnedStuck = $true
                    }
                    }
                } else {
                    if (-not $warnedStuck -and $sigTime -ne "") {
                        $idle = $now - [datetime]$sigTime
                        if ($idle.TotalMinutes -ge $stuckMinutes -and -not $sessFresh) {
                            Show-Popup "Mailbox: co ve ket" ("{0} dang-lam hon $stuckMinutes phut khong tien trien:`n$ticket`n`nKiem tra terminal {0} xem co bi treo khong." -f $worker)
                            $warnedStuck = $true
                        }
                    }
                }
            }
            elseif ($status -eq "xong-cho-duyet" -and $status -ne $lastStatus) {
                Show-Popup "Mailbox: tho bao xong" ("{0} da bao xong-cho-duyet. Muse poll moi 5 phut se review ngay." -f $worker)
            }
            elseif ($status -eq "cho-muse") {
                # Watcher da escalate (hoac tho tu dung theo gate) -> im lang cho Muse (cron 3p se thay).
                # Nhung khong im vinh vien: qua SLA thi bao (cron Muse co the da dung).
                if (-not $warnedSla -and $sigTime -ne "") {
                    $wait = $now - [datetime]$sigTime
                    if ($wait.TotalHours -ge $choMuseSlaHours) {
                        Show-Popup ("Mailbox [{0}]: cho Muse lau" -f $worker) ("cho-muse da {0:N1} gio khong doi:`n$ticket`n`nCron Muse co the da dung - kiem tra VM/cron." -f $wait.TotalHours)
                        Write-Log ("SLA cho-muse qua {0:N1}h ticket=$ticket" -f $wait.TotalHours)
                        $warnedSla = $true
                    }
                }
            }
        }

        $lastStatus = $status; $lastTicket = $ticket
        @{
            status = $status; ticket = $ticket; sig = $sig; sigTime = $sigTime
            firstSeenMoi = $firstSeenMoi; warnedMoi = $warnedMoi
            warnedStuck = $warnedStuck; warnedIdle = $warnedIdle
            warnedUnknown = $warnedUnknown; warnedSla = $warnedSla; warnedDisk = $warnedDisk
            pollFails = $pollFails
            launchedTicket = $launchedTicket; launchedAt = $launchedAt; relaunchedTicket = $relaunchedTicket; relaunchedAt = $relaunchedAt; idleCount = $idleCount
            launchSig = $launchSig; launchStallCount = $launchStallCount; escalatedSig = $escalatedSig
            ticketsDone = $ticketsDone; updated = $now.ToString("s")
        } | ConvertTo-Json | Out-File $stateFile -Encoding utf8
    } catch {
        $pollFails++
        Write-Log ("loi ({0}/{1}): " -f $pollFails, $maxPollFails) + $_.Exception.Message
        if ($pollFails -eq $maxPollFails) {
            Show-Popup ("Mailbox [{0}]: poll that bai lien tuc" -f $worker) ("Da {0} lan lien tiep khong doc duoc mailbox ({1}).`n`nKiem tra mang + han muc GitHub API (403 = het quota, can token)." -f $maxPollFails, $MailboxDir)
            Write-Log ("POLL-FAIL x{0}: can thiep tay" -f $maxPollFails)
        }
    }
    Start-Sleep -Seconds $pollSeconds
}
