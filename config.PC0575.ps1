# config.PC0575.ps1 - cau hinh san cho may cong ty PC0575 (user tvn183660).
# Cach dung tren PC0575: copy file nay thanh "config.local.ps1" (cung thu muc).
# Yeu cau: da cai omp (user-scope, khong can admin), da clone repo AIOS_habbit
# ve D:\Sandbox\AIOS_habbit, da cai Git (user-scope).

# Ten process OMP (Task Manager > Details, khong co .exe)
$ompProcessName = "omp"

# Duong dan omp tren PC0575 (neu cai khac cho: mo terminal, go "where omp" lay duong dan that)
$ompLaunchCommand = "C:\Users\tvn183660\AppData\Local\omp\omp.exe"

# Thu muc repo du an tren PC0575
$aiosDir = "D:\Sandbox\AIOS_habbit"

# Thu muc session cua omp tren PC0575 (de canh heartbeat)
$sessionDir = "C:\Users\tvn183660\.omp\agent\sessions\--D--Sandbox-AIOS_habbit--"

# Mailbox can (giong may nha; doi neu dung repo/nhanh khac)
$owner = "Nakazasen"
$repo = "AIOS_habbit"
$branch = "phieu-viec/rag-fix1"

# Hanh vi (giong may nha)
$AUTO_LAUNCH = $true
$SHOW_WORKER_WINDOW = $true
$AUTO_RELAUNCH = $true
