# _mau.project.ps1 - MAU cau hinh 1 project cho khung watcher chung.
# Cach them project moi:
#   1. Copy file nay thanh "projects\<ten-project>.project.ps1" (ten file = ten project).
#   2. Sua cac gia tri ben duoi cho dung project (duong dan tren MAY CHAY watcher).
#   3. Cai task: chay Cai-Lan.ps1 -Project <ten-project> (xem HUONG-DAN-KHUNG.md).
# File cau hinh la PowerShell thuan: chi khai bao bien $ProjectCfg nhu mau.
# Giu file nay ASCII (khong dau) de tranh loi ma hoa tren Windows PowerShell 5.1.

$ProjectCfg = @{
    # Ten project (trung ten file, khong dau, khong khoang trang)
    Name        = "ten-project"
    # Ten hien thi tren trang tong quan
    DisplayName = "Ten project - mo ta ngan"
    # "auto": watcher tu mo tho khi thay ve "moi". "monitor": chi doc + bao trang thai.
    Mode        = "auto"
    # Thu muc state cua watcher (log, khoa, snapshot) - BAT BUOC ngoai cac cay repo
    # dieu phoi. De "" thi engine tu dung <thu muc clone agent-mailbox>\khung-state.
    # Chi dien duong dan rieng khi muon tach han (vd o dia khac).
    StateRoot   = ""
    # Thu muc clone repo cua project tren may chay
    RepoDir     = "D:\Sandbox\ten-project"
    # Tu dong git pull --ff-only khi cay sach (chi nen bat o che do auto)
    AutoSync    = $true
    # Chu ky quet (giay) + khoang cach toi thieu giua 2 lan mo tho cung 1 lane (phut)
    PollSeconds = 90
    MinLaunchIntervalMinutes = 15
    # Hien cua so tho khi mo (true) hay chay an (false)
    ShowWindow  = $true

    # Danh sach lane (hop thu) cua project. Moi lane toi da 1 tho chay cung luc.
    Lanes = @(
        @{
            Name        = "lane-1"
            DisplayName = "Lane 1 - mo ta"
            # File trang thai cua hop thu (tuong doi theo RepoDir hoac tuyet doi)
            StatusFile  = "duong\dan\trang-thai.md"
            # "newest": trang thai gan moc thoi gian moi nhat thang.
            # "first": dong trang thai dau tien. "last": dong cuoi cung.
            StatusMode  = "newest"
            # Thu muc lam viec khi mo tho
            WorkDir     = "D:\Sandbox\ten-project"
            # Chuong trinh tho + mau tham so ({Prompt} se duoc thay bang Prompt ben duoi)
            LaunchCommand      = "C:\duong\dan\tho.exe"
            LaunchArgsTemplate = '-p --auto-approve "{Prompt}"'
            Prompt             = "Noi dung giao viec ngan cho tho (doc file ve chi tiet tu hop thu)."
            # Nhan dien tho dang chay: ten process + chuoi phai co trong command line.
            # De trong "" neu lane khong can hien trang thai tho (che do monitor).
            WorkerProcessName  = "tho.exe"
            WorkerMatch        = ""
        }
    )
}
