# Watch-Mailbox.ps1 (v4) — watcher + giám sát OMP, vòng lặp cưỡng chế 2 đầu
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
$AUTO_LAUNCH = $false
# $ompLaunchCommand = "C:\tools\omp.exe"
# $ompLaunchArgs    = @("run", "doc docs/phieu-viec/mailbox/prompt.md va lam theo, tuan thu QUY-UOC.md")
$ompLaunchCommand = ""
$ompLaunchArgs    = @()
# =====================================================================

$stateFile  = Join-Path $PSScriptRoot "watcher_state.json"
$ticketFile = Join-Path $PSScriptRoot "_ticket-moi.md"
$logFile    = Join-Path $PSScriptRoot "watcher.log"
# Muon poll moi 60 giay: tao token fine-grained (quyen Contents: read),
# bo comment dong duoi va dan token vao. KHONG commit token len git.
# $token = "DAN_TOKEN_VAO_DAY"

$mutex = New-Object System.Threading.Mutex($false, "Global\MailboxWatcher")
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
    return $null -ne (Get-Process -Name $ompProcessName -ErrorAction SilentlyContinue)
}
function Write-Log($msg) {
    ("[{0}] {1}" -f (Get-Date).ToString("s"), $msg) | Out-File $logFile -Append -Encoding utf8
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
$launchedTicket = St-Get "launchedTicket" ""
$idleCount      = [int](St-Get "idleCount" 0)
$ticketsDone    = @(St-Get "ticketsDone" @())

while ($true) {
    try {
        $text       = Get-MailboxFile "docs/phieu-viec/mailbox/trang-thai.md"
        $status     = Parse-Field $text 'Trạng thái:\s*`([^`]+)`'
        $ticket     = Parse-Field $text 'Ticket hiện tại:\s*([^\r\n]+)'
        $note       = Parse-Field $text '(?m)^\s*-\s*[Gg]hi ch[uú][:\s]`?([^`\r\n]+)'
        $commit     = Parse-Field $text '[Cc]ommit[^:0-9a-f]*`?([0-9a-f]{7,40})`?'
        $sig        = "$status|$ticket|$note|$commit"
        $now        = Get-Date
        $ompRunning = Test-OmpRunning

        if ($sig -ne $lastSig) { $lastSig = $sig; $sigTime = $now.ToString("s"); $warnedStuck = $false }

        # Ghi nhận ticket hoàn thành: chuyển sang xong-cho-duyet
        if ($status -eq "xong-cho-duyet" -and $lastStatus -ne "xong-cho-duyet" -and $ticket -ne "") {
            if ($ticketsDone -notcontains $ticket) { $ticketsDone += $ticket }
        }

        if ($status -eq "xong") {
            # Trạng thái kết thúc: đếm số lần check ổn định liên tiếp rồi tự dừng
            $idleCount++
            if ($idleCount -ge $idleExitChecks) {
                $doneList = ($ticketsDone | Select-Object -Last 5) -join "`n- "
                if ($doneList -eq "") { $doneList = "(không ghi nhận)" }
                $summary = "Vong lap mailbox ket thuc.`n`nTicket da xong ($($ticketsDone.Count)):`n- $doneList`n`nWatcher tu dung sau $idleExitChecks lan check on dinh."
                Show-Popup "Mailbox: hoan thanh" $summary
                Write-Log "STOP: trang thai 'xong' on dinh $idleExitChecks lan. Tong ticket xong: $($ticketsDone.Count)."
                exit
            }
        } else {
            $idleCount = 0

            if ($status -eq "moi") {
                $isNewTicket = ($ticket -ne $lastTicket -or $lastStatus -ne "moi")
                if ($isNewTicket) {
                    try {
                        $prompt = Get-MailboxFile "docs/phieu-viec/mailbox/prompt.md"
                        $prompt | Out-File -FilePath $ticketFile -Encoding utf8
                    } catch {}
                    $firstSeenMoi = $now.ToString("s")
                    $warnedMoi = $false; $warnedIdle = $false
                }
                if (-not $ompRunning) {
                    if ($AUTO_LAUNCH -and $ompLaunchCommand -ne "" -and $launchedTicket -ne $ticket) {
                        Start-Process -FilePath $ompLaunchCommand -ArgumentList $ompLaunchArgs -WorkingDirectory "D:\Sandbox\AIOS_habbit"
                        $launchedTicket = $ticket
                        Show-Popup "Mailbox: tu mo OMP" ("Da tu dong mo OMP chay ticket:`n$ticket")
                    } elseif (-not $warnedIdle) {
                        Show-Popup "Mailbox: ticket moi (OMP ranh)" ("Co ticket moi ma OMP chua chay:`n$ticket`n`nMo OMP len hoac bao no: doc mailbox, co ticket moi.")
                        $warnedIdle = $true
                    } elseif (-not $warnedMoi -and $firstSeenMoi -ne "") {
                        $age = $now - [datetime]$firstSeenMoi
                        if ($age.TotalMinutes -ge $moiWarnMinutes) {
                            Show-Popup "Mailbox: ticket treo" ("Ticket moi da hon $moiWarnMinutes phut chua ai nhan:`n$ticket`n`nNhac OMP: git pull origin $branch roi doc mailbox.")
                            $warnedMoi = $true
                        }
                    }
                } else {
                    if ($isNewTicket -and -not $warnedIdle) {
                        Show-Popup "Mailbox: ticket moi" ("Co ticket moi cho OMP:`n$ticket`n`nDa luu ban local: _ticket-moi.md`nBao OMP doc va lam theo prompt.")
                        $warnedIdle = $true
                    }
                }
            }
            elseif ($status -eq "dang-lam") {
                if (-not $ompRunning) {
                    if (-not $warnedStuck) {
                        Show-Popup "Mailbox: OMP bien mat?" ("Trang thai dang-lam nhung khong thay process OMP ($ompProcessName).`nCo the OMP da crash giua chung - kiem tra terminal.")
                        $warnedStuck = $true
                    }
                } else {
                    if (-not $warnedStuck -and $sigTime -ne "") {
                        $idle = $now - [datetime]$sigTime
                        if ($idle.TotalMinutes -ge $stuckMinutes) {
                            Show-Popup "Mailbox: co ve ket" ("OMP dang-lam hon $stuckMinutes phut khong tien trien:`n$ticket`n`nKiem tra terminal OMP xem co bi treo khong.")
                            $warnedStuck = $true
                        }
                    }
                }
            }
            elseif ($status -eq "xong-cho-duyet" -and $status -ne $lastStatus) {
                Show-Popup "Mailbox: OMP bao xong" "OMP da bao xong-cho-duyet. Muse poll moi 5 phut se review ngay."
            }
        }

        $lastStatus = $status; $lastTicket = $ticket
        @{
            status = $status; ticket = $ticket; sig = $sig; sigTime = $sigTime
            firstSeenMoi = $firstSeenMoi; warnedMoi = $warnedMoi
            warnedStuck = $warnedStuck; warnedIdle = $warnedIdle
            launchedTicket = $launchedTicket; idleCount = $idleCount
            ticketsDone = $ticketsDone; updated = $now.ToString("s")
        } | ConvertTo-Json | Out-File $stateFile -Encoding utf8
    } catch {
        Write-Log ("loi: " + $_.Exception.Message)
    }
    Start-Sleep -Seconds $pollSeconds
}
