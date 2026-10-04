# config.mau.ps1 - MAU cau hinh rieng tung may (khong sua file nay).
# Cach dung: copy thanh "config.local.ps1" (cung thu muc), sua gia tri cho
# dung may do. File config.local.ps1 KHONG commit len git.
# Cac script (Watch-Mailbox.ps1, LogCanary.ps1) tu nap file nay neu co.

# Ten process OMP (Task Manager > Details, khong co .exe)
$ompProcessName = "omp"

# Duong dan chuong trinh omp (tim bang: mo terminal, go "where omp")
$ompLaunchCommand = "C:\Users\Admin\AppData\Local\omp\omp.exe"

# Thu muc repo du an tren may (chua mailbox)
$aiosDir = "D:\Sandbox\AIOS_habbit"

# Thu muc session cua omp tren may (de canh heartbeat)
$sessionDir = "C:\Users\Admin\.omp\agent\sessions\--D--Sandbox-AIOS_habbit--"

# Mailbox can (doi neu dung repo/nhanh khac)
$owner = "Nakazasen"
$repo = "AIOS_habbit"
$branch = "phieu-viec/rag-fix1"

# Hanh vi (doi neu muon)
$AUTO_LAUNCH = $true
$SHOW_WORKER_WINDOW = $true
$AUTO_RELAUNCH = $true

# Tho phu: agy (Antigravity CLI) - doi model tuy viec
# Viec thuong: gemini-3.8-flash-high; viec kho: claude-sonnet-5-5-medium / claude-opus-5-5-medium
$agyLaunchCommand = "C:\Users\Admin\AppData\Local\agy\bin\agy.exe"
$agyModel = "gemini-3.8-flash-high"

# Tho phu: opencode (free) - doi model tuy viec
# opencode/muse-spark-1.3-contributor-free | opencode/space-bunny-free
# Luu y: `opencode run` tu dung server hay hong -> watcher dung server rieng
# o port duoi + run --attach. Doi port neu 4096 bi chiem.
$opencodeShim = "C:\Users\Admin\AppData\Roaming\npm\opencode.ps1"
$opencodeModel = "opencode/muse-spark-1.3-contributor-free"
$opencodePort = 4096
