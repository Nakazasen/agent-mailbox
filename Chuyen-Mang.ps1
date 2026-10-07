# Chuyen-Mang.ps1 - cong tac mang PC0575 (khong can admin, profile da luu san).
#
#   2 mang:
#     congty (vn-kdwireless) - vao duoc tai lieu cong ty/LAN, KHONG ra duoc Google Drive.
#     ngoai  (KT_CHETAO)     - ra duoc Google Drive, KHONG vao duoc tai lieu cong ty.
#
# Cach dung (tho OMP tu chay theo ve, khong can user):
#   powershell -ExecutionPolicy Bypass -File "D:\Sandbox\agent-mailbox\Chuyen-Mang.ps1" -Mang ngoai
#   powershell -ExecutionPolicy Bypass -File "D:\Sandbox\agent-mailbox\Chuyen-Mang.ps1" -Mang congty
#   powershell -ExecutionPolicy Bypass -File "D:\Sandbox\agent-mailbox\Chuyen-Mang.ps1"
#     (khong tham so = chi bao mang hien tai, khong doi)
#
# Output de tho doc (1 dong 1 viec):
#   MANG=<SSID hien tai>
#   DRIVE=OK  (ra duoc drive.usercontent.google.com:443)
#   DRIVE=FAIL
#
# Tho quy uoc: can Drive thi ve ghi "-Mang ngoai", xong viec ve cong ty thi "-Mang congty".

param(
    [string]$Mang = ""
)

$ErrorActionPreference = "SilentlyContinue"

$MAP = @{
    "congty" = "vn-kdwireless"
    "ngoai"  = "KT_CHETAO"
}

function Get-CurrentSsid {
    $info = netsh wlan show interfaces 2>$null | Select-String "^\s*SSID\s*:\s*(.+)"
    if ($info) { return $info[0].Matches[0].Groups[1].Value.Trim() }
    return ""
}

function Test-Drive {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $r = $c.BeginConnect("drive.usercontent.google.com", 443, $null, $null)
        $ok = $r.AsyncWaitHandle.WaitOne(8000)
        if ($ok) { $c.EndConnect($r) }
        $c.Close()
        return $ok
    } catch { return $false }
}

if ($Mang -eq "") {
    ("MANG=" + (Get-CurrentSsid))
    if (Test-Drive) { "DRIVE=OK" } else { "DRIVE=FAIL" }
    exit 0
}

$ssid = $Mang
if ($MAP.ContainsKey($Mang.ToLower())) { $ssid = $MAP[$Mang.ToLower()] }

netsh wlan connect name="$ssid" 2>&1 | Out-Null
Start-Sleep -Seconds 12
$now = Get-CurrentSsid
("MANG=" + $now)
if ($now -ne $ssid) {
    ("WANT=" + $ssid)
    exit 1
}
if (Test-Drive) { "DRIVE=OK" } else { "DRIVE=FAIL" }
exit 0

