# aios-habbit.project.ps1 - Lane AIOS_habbit trong khung chung.
# Che do MONITOR: watcher cu (Watch-Mailbox.ps1 cua repo agent-mailbox) van dang chay
# va so huu viec mo tho cho AIOS. Cau hinh nay chi de khung doc trang thai cac hop thu
# AIOS va dua len trang tong quan (tab rieng) - KHONG mo tho, KHONG pull.
# Khi nao chuyen han AIOS sang engine chung: doi Mode thanh "auto", tat watcher cu,
# va khai bao Launch* cho tung lane nhu mau.

$ProjectCfg = @{
    Name        = "aios-habbit"
    DisplayName = "AIOS_habbit - Dieu phoi loi LSU (watcher cu)"
    Mode        = "monitor"
    # StateRoot de trong: engine tu suy ra <thu muc clone agent-mailbox>\khung-state.
    StateRoot   = ""
    RepoDir     = "D:\Sandbox\AIOS_habbit"
    AutoSync    = $false
    PollSeconds = 120
    MinLaunchIntervalMinutes = 15
    ShowWindow  = $true

    Lanes = @(
        @{
            Name        = "omp"
            DisplayName = "OMP may nha (dong bang tu 2026-10-10)"
            StatusFile  = "docs\phieu-viec\mailbox\trang-thai.md"
            StatusMode  = "newest"
            WorkerProcessName = "omp.exe"
            WorkerMatch = ""
        },
        @{
            Name        = "agy"
            DisplayName = "Antigravity may nha (tho chinh)"
            StatusFile  = "docs\phieu-viec\mailbox-agy\trang-thai.md"
            StatusMode  = "newest"
            WorkerProcessName = "agy.exe"
            WorkerMatch = ""
        },
        @{
            Name        = "opencode"
            DisplayName = "opencode may nha (audit)"
            StatusFile  = "docs\phieu-viec\mailbox-opencode\trang-thai.md"
            StatusMode  = "newest"
            WorkerProcessName = ""
            WorkerMatch = ""
        }
    )
}
