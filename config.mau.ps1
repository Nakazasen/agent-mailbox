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
