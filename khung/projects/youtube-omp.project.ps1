# youtube-omp.project.ps1 - Lane YouTube: OMP (xAI, profile youtube) audit + nghien cuu
# thi truong cho kenh Thao Nguyen Nihongo. Hop thu: youtube/mailbox-omp trong repo
# dieu phoi Nakazasen/aios-dieu-phoi (clone D:\Sandbox\aios-dieu-phoi).
# Watcher nay thay the viec boc ve TAY truoc day (user chot tu dong 2026-10-11).
# Giu file ASCII. Duong dan la cua MAY NHA h410asrock - doi tai day neu may khac chay.

$ProjectCfg = @{
    Name        = "youtube"
    DisplayName = "YouTube - Audit bai giang (OMP xAI)"
    Mode        = "auto"
    # StateRoot de trong: engine tu suy ra <thu muc clone agent-mailbox>\khung-state.
    # Muon doi cho: dat StateRoot tai day, hoac $StateRootOverride trong khung\config.local.ps1.
    StateRoot   = ""
    RepoDir     = "D:\Sandbox\aios-dieu-phoi"
    AutoSync    = $true
    PollSeconds = 90
    MinLaunchIntervalMinutes = 15
    ShowWindow  = $true

    Lanes = @(
        @{
            Name        = "omp-audit"
            DisplayName = "OMP audit + nghien cuu thi truong"
            StatusFile  = "youtube\mailbox-omp\trang-thai.md"
            StatusMode  = "newest"
            WorkDir     = "D:\Sandbox\aios-dieu-phoi\youtube"
            LaunchCommand      = "C:\Users\Admin\AppData\Local\omp\omp.exe"
            LaunchArgsTemplate = '--profile youtube -p --auto-approve "{Prompt}"'
            Prompt             = "Doc va lam dung theo file PROMPT-BOC-VE-OMP.md trong thu muc lam viec nay: boc ve dang o trang thai moi trong mailbox-omp, lam va nop dung quy trinh ghi trong file do. Chi lam trong cay youtube, tuyet doi khong dung cay hop-thu hay so-cai."
            WorkerProcessName  = "omp.exe"
            WorkerMatch        = "--profile youtube"
        }
    )
}
