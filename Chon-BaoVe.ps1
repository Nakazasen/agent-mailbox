# Chon-BaoVe.ps1 - UI chon tho truoc khi BAT bao ve mailbox (che do B).
#
# 6 che do (luu vao che-do-tho.json):
#   1. omp         - tho chinh OMP (mailbox goc)
#   2. agy         - Antigravity CLI (mailbox-agy) + chon model
#   3. opencode    - OpenCode free (mailbox-opencode) + chon model
#   4. all         - phoi hop ca 3, moi tho 1 mailbox rieng (khong ghi de viec nhau)
#   5. duo         - OMP + AGY (dung khi CLI opencode loi server, tam nghi opencode)
#   6. farm_audit  - AGY farm viec nho/bulk + OpenCode tho audit doc lap (suy luan cao nhat)
#
# Cach dung:
#   Nhan 2 click file nay (hien UI) - thay cho Bat-BaoVe.ps1.
#   powershell -ExecutionPolicy Bypass -File Chon-BaoVe.ps1 -Mode farm_audit -ApplyOnly
#   powershell -ExecutionPolicy Bypass -File Chon-BaoVe.ps1 -Mode agy -AgyModel claude-opus-5-5-high -ApplyOnly
#
# Ghi chu: Bat-BaoVe.ps1 (khong tham so) se mo UI nay. Tat-BaoVe.ps1 tat het.

param(
    [string]$Mode = "",
    [string]$AgyModel = "",
    [string]$OpenCodeModel = "",
    [string]$OpenCodeVariant = "xhigh",
    [switch]$ApplyOnly
)

$ErrorActionPreference = "SilentlyContinue"

$AGY_MODELS = @(
    "gemini-3.8-flash-high",
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-high",
    "gemini-3.8-flash-medium",
    "claude-sonnet-5-5-medium",
    "claude-opus-5-5-medium"
)
$OPENCODE_MODELS = @(
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/space-bunny-free"
)
$AGY_DEFAULT = "gemini-3.8-flash-high"
$OPENCODE_DEFAULT = "opencode/muse-spark-1.3-contributor-free"
$OPENCODE_VARIANT_DEFAULT = "xhigh"

$choiceFile = Join-Path $PSScriptRoot "che-do-tho.json"
$installScript = Join-Path $PSScriptRoot "Install-MailboxTasks.ps1"

$WATCHER_TASKS = @{
    "omp"      = "MailboxWatcher"
    "agy"      = "MailboxWatcher-agy"
    "opencode" = "MailboxWatcher-opencode"
}
$DOG_TASKS = @{
    "omp"      = "MailboxWatchdog"
    "agy"      = "MailboxWatchdog-agy"
    "opencode" = "MailboxWatchdog-opencode"
}
$ALL_WORKERS = @("omp", "agy", "opencode")

function Get-SavedChoice {
    $d = @{ mode = "omp"; agyModel = $AGY_DEFAULT; openCodeModel = $OPENCODE_DEFAULT; openCodeVariant = $OPENCODE_VARIANT_DEFAULT }
    if (Test-Path -LiteralPath $choiceFile) {
        try {
            $j = Get-Content -LiteralPath $choiceFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.mode) { $d.mode = [string]$j.mode }
            if ($j.agyModel -and ($AGY_MODELS -contains $j.agyModel)) { $d.agyModel = [string]$j.agyModel }
            if ($j.openCodeModel -and ($OPENCODE_MODELS -contains $j.openCodeModel)) { $d.openCodeModel = [string]$j.openCodeModel }
            if ($j.openCodeVariant) { $d.openCodeVariant = [string]$j.openCodeVariant }
        } catch {}
    }
    return $d
}

function Save-Choice([string]$mode, [string]$agy, [string]$oc, [string]$ocVariant = "xhigh") {
    @{ mode = $mode; agyModel = $agy; openCodeModel = $oc; openCodeVariant = $ocVariant; updated = (Get-Date).ToString("s") } |
        ConvertTo-Json | Out-File -LiteralPath $choiceFile -Encoding utf8
}

function Get-WorkersOfMode([string]$mode) {
    if ($mode -eq "all") { return $ALL_WORKERS }
    if ($mode -eq "duo") { return @("omp", "agy") }
    if ($mode -eq "farm_audit" -or $mode -eq "agy_opencode" -or $mode -eq "mode6" -or $mode -eq "6" -or $mode -eq "audit") { return @("agy", "opencode") }
    if ($WATCHER_TASKS.ContainsKey($mode)) { return @($mode) }
    return @("omp")
}

function Get-InstalledMailboxBase {
    # Doc mailbox goc tu task da cai (giu dung cho may PC0575). Mac dinh: mailbox may nha.
    try {
        $t = Get-ScheduledTask -TaskName "MailboxWatcher" -ErrorAction Stop
        $args = [string]$t.Actions[0].Arguments
        $m = [regex]::Match($args, '-MailboxDir\s+"([^"]+)"')
        if ($m.Success) { return $m.Groups[1].Value }
    } catch {}
    return "docs/phieu-viec/mailbox"
}

function Stop-WorkerWatcher([string]$w) {
    # Dung tien trinh watcher cua 1 tho (khong dung tho dang lam).
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -like "*Watch-Mailbox*.ps1*" -and $_.CommandLine -notlike "*Watchdog-Mailbox*.ps1*" }
        foreach ($p in $procs) {
            $cl = [string]$p.CommandLine
            $isTarget = $false
            if ($w -eq "omp") {
                if ($cl -like "*-Worker omp*" -or $cl -notlike "*-Worker *") { $isTarget = $true }
            } else {
                if ($cl -like ("*-Worker " + $w + "*")) { $isTarget = $true }
            }
            if ($isTarget) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
        }
    } catch {}
}

function Apply-Mode([string]$mode, [string]$agy, [string]$oc, [string]$ocVariant = "xhigh") {
    Import-Module ScheduledTasks -ErrorAction SilentlyContinue | Out-Null
    $mode = $mode.ToLower()
    $validModes = @("omp", "agy", "opencode", "all", "duo", "farm_audit", "agy_opencode", "mode6", "6", "audit")
    if ($validModes -notcontains $mode) { $mode = "omp" }
    if ($mode -eq "6" -or $mode -eq "mode6" -or $mode -eq "agy_opencode" -or $mode -eq "audit") { $mode = "farm_audit" }
    if (-not ($AGY_MODELS -contains $agy)) { $agy = $AGY_DEFAULT }
    if (-not ($OPENCODE_MODELS -contains $oc)) { $oc = $OPENCODE_DEFAULT }
    if (-not $ocVariant) { $ocVariant = $OPENCODE_VARIANT_DEFAULT }
    Save-Choice $mode $agy $oc $ocVariant

    $active = Get-WorkersOfMode $mode
    $base = Get-InstalledMailboxBase

    # Cai lai task cho tho active de cap nhat model (giu mailbox base hien tai).
    try {
        & powershell -ExecutionPolicy Bypass -NoProfile -File $installScript `
            -MailboxDir $base -Workers $active -AgyModel $agy -OpenCodeModel $oc -OpenCodeVariant $ocVariant | Out-Null
    } catch {}

    Remove-Item -LiteralPath (Join-Path $PSScriptRoot "canary_count.txt") -Force -ErrorAction SilentlyContinue
    foreach ($w in $ALL_WORKERS) {
        $wt = $WATCHER_TASKS[$w]; $dt = $DOG_TASKS[$w]
        if ($active -contains $w) {
            try { Enable-ScheduledTask -TaskName $wt | Out-Null } catch {}
            try { Enable-ScheduledTask -TaskName $dt | Out-Null } catch {}
            try { Start-ScheduledTask -TaskName $wt } catch {}
            if ($w -eq "opencode") {
                try { Enable-ScheduledTask -TaskName "MailboxWatcher-opencode-dieu-phoi" | Out-Null } catch {}
                try { Enable-ScheduledTask -TaskName "MailboxWatchdog-opencode-dieu-phoi" | Out-Null } catch {}
                try { Start-ScheduledTask -TaskName "MailboxWatcher-opencode-dieu-phoi" } catch {}
            }
        } else {
            Stop-WorkerWatcher $w
            try { Disable-ScheduledTask -TaskName $wt | Out-Null } catch {}
            try { Disable-ScheduledTask -TaskName $dt | Out-Null } catch {}
            if ($w -eq "opencode") {
                try { Disable-ScheduledTask -TaskName "MailboxWatcher-opencode-dieu-phoi" | Out-Null } catch {}
                try { Disable-ScheduledTask -TaskName "MailboxWatchdog-opencode-dieu-phoi" | Out-Null } catch {}
            }
        }
    }
    if ($active.Count -gt 0) {
        try { Enable-ScheduledTask -TaskName "LogCanary" | Out-Null } catch {}
        try { Start-ScheduledTask -TaskName "LogCanary" } catch {}
    }
    return @{ mode = $mode; active = ($active -join ","); agy = $agy; oc = $oc; ocVariant = $ocVariant }
}

function Show-ChoiceUI($saved) {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null

    $f = New-Object System.Windows.Forms.Form
    $f.Text = "Bat bao ve mailbox - chon tho"
    $f.Size = New-Object System.Drawing.Size(430, 400)
    $f.StartPosition = "CenterScreen"
    $f.FormBorderStyle = "FixedDialog"
    $f.MaximizeBox = $false
    $f.MinimizeBox = $false

    $y = 15
    $rb1 = New-Object System.Windows.Forms.RadioButton
    $rb1.Text = "1. OMP (tho chinh)"; $rb1.Location = New-Object System.Drawing.Point(20, $y); $rb1.Size = New-Object System.Drawing.Size(370, 22)
    $y += 26
    $rb2 = New-Object System.Windows.Forms.RadioButton
    $rb2.Text = "2. AGY - Antigravity CLI"; $rb2.Location = New-Object System.Drawing.Point(20, $y); $rb2.Size = New-Object System.Drawing.Size(370, 22)
    $y += 26
    $cbAgy = New-Object System.Windows.Forms.ComboBox
    $cbAgy.Location = New-Object System.Drawing.Point(45, $y); $cbAgy.Size = New-Object System.Drawing.Size(340, 22)
    $cbAgy.DropDownStyle = "DropDownList"
    foreach ($m in $AGY_MODELS) { $cbAgy.Items.Add($m) | Out-Null }
    $cbAgy.SelectedItem = $saved.agyModel
    if ($cbAgy.SelectedIndex -lt 0) { $cbAgy.SelectedIndex = 0 }
    $y += 30
    $rb3 = New-Object System.Windows.Forms.RadioButton
    $rb3.Text = "3. OpenCode (free)"; $rb3.Location = New-Object System.Drawing.Point(20, $y); $rb3.Size = New-Object System.Drawing.Size(370, 22)
    $y += 26
    $cbOc = New-Object System.Windows.Forms.ComboBox
    $cbOc.Location = New-Object System.Drawing.Point(45, $y); $cbOc.Size = New-Object System.Drawing.Size(340, 22)
    $cbOc.DropDownStyle = "DropDownList"
    foreach ($m in $OPENCODE_MODELS) { $cbOc.Items.Add($m) | Out-Null }
    $cbOc.SelectedItem = $saved.openCodeModel
    if ($cbOc.SelectedIndex -lt 0) { $cbOc.SelectedIndex = 0 }
    $y += 30
    $rb4 = New-Object System.Windows.Forms.RadioButton
    $rb4.Text = "4. Phoi hop ca 3 (moi tho 1 mailbox)"; $rb4.Location = New-Object System.Drawing.Point(20, $y); $rb4.Size = New-Object System.Drawing.Size(370, 22)
    $y += 26
    $rb5 = New-Object System.Windows.Forms.RadioButton
    $rb5.Text = "5. OMP + AGY (opencode CLI loi, tam nghi)"; $rb5.Location = New-Object System.Drawing.Point(20, $y); $rb5.Size = New-Object System.Drawing.Size(370, 22)
    $y += 26
    $rb6 = New-Object System.Windows.Forms.RadioButton
    $rb6.Text = "6. AGY (farm bulk) + OpenCode (tho audit doc lap)"; $rb6.Location = New-Object System.Drawing.Point(20, $y); $rb6.Size = New-Object System.Drawing.Size(370, 22)

    if ($saved.mode -eq "agy") { $rb2.Checked = $true }
    elseif ($saved.mode -eq "opencode") { $rb3.Checked = $true }
    elseif ($saved.mode -eq "all") { $rb4.Checked = $true }
    elseif ($saved.mode -eq "duo") { $rb5.Checked = $true }
    elseif ($saved.mode -eq "farm_audit" -or $saved.mode -eq "agy_opencode" -or $saved.mode -eq "mode6" -or $saved.mode -eq "6" -or $saved.mode -eq "audit") { $rb6.Checked = $true }
    else { $rb1.Checked = $true }

    $note = New-Object System.Windows.Forms.Label
    $note.Text = "Mode 6: AGY farm viec nho/bulk (Flash High). OpenCode tho audit doc lap (Xhigh). Tat ca tho che do suy luan cao nhat."
    $note.Location = New-Object System.Drawing.Point(20, ($y + 26)); $note.Size = New-Object System.Drawing.Size(370, 32)

    $btnOn = New-Object System.Windows.Forms.Button
    $btnOn.Text = "BAT"; $btnOn.Location = New-Object System.Drawing.Point(45, ($y + 64)); $btnOn.Size = New-Object System.Drawing.Size(100, 30)
    $btnOff = New-Object System.Windows.Forms.Button
    $btnOff.Text = "TAT het"; $btnOff.Location = New-Object System.Drawing.Point(160, ($y + 64)); $btnOff.Size = New-Object System.Drawing.Size(100, 30)
    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Text = "Dong"; $btnClose.Location = New-Object System.Drawing.Point(275, ($y + 64)); $btnClose.Size = New-Object System.Drawing.Size(100, 30)

    $f.Controls.AddRange(@($rb1, $rb2, $cbAgy, $rb3, $cbOc, $rb4, $rb5, $rb6, $note, $btnOn, $btnOff, $btnClose))

    $getMode = {
        if ($rb2.Checked) { return "agy" }
        if ($rb3.Checked) { return "opencode" }
        if ($rb4.Checked) { return "all" }
        if ($rb5.Checked) { return "duo" }
        if ($rb6.Checked) { return "farm_audit" }
        return "omp"
    }

    $btnOn.Add_Click({
        $m = & $getMode
        $ocVar = if ($saved.openCodeVariant) { $saved.openCodeVariant } else { $OPENCODE_VARIANT_DEFAULT }
        $r = Apply-Mode $m ([string]$cbAgy.SelectedItem) ([string]$cbOc.SelectedItem) $ocVar
        [System.Windows.Forms.MessageBox]::Show(("Da BAT bao ve. Che do: {0} (tho: {1}).`nAGY: {2} | OpenCode: {3} (variant: {4})" -f $r.mode, $r.active, $r.agy, $r.oc, $r.ocVariant), "Bao ve mailbox")
        $f.Close()
    })
    $btnOff.Add_Click({
        try { & (Join-Path $PSScriptRoot "Tat-BaoVe.ps1") } catch {}
        $f.Close()
    })
    $btnClose.Add_Click({ $f.Close() })

    $f.Add_Shown({ $f.Activate() })
    $f.ShowDialog() | Out-Null
}

# --- Chinh ---
if ($ApplyOnly) {
    $s = Get-SavedChoice
    if ($Mode -ne "") { $s.mode = $Mode }
    if ($AgyModel -ne "") { $s.agyModel = $AgyModel }
    if ($OpenCodeModel -ne "") { $s.openCodeModel = $OpenCodeModel }
    if ($OpenCodeVariant -ne "") { $s.openCodeVariant = $OpenCodeVariant }
    $r = Apply-Mode $s.mode $s.agyModel $s.openCodeModel $s.openCodeVariant
    ("BAT: mode={0} tho={1} agy={2} opencode={3} variant={4}" -f $r.mode, $r.active, $r.agy, $r.oc, $r.ocVariant)
} else {
    if ($Mode -ne "") {
        $s = Get-SavedChoice
        if ($AgyModel -ne "") { $s.agyModel = $AgyModel }
        if ($OpenCodeModel -ne "") { $s.openCodeModel = $OpenCodeModel }
        if ($OpenCodeVariant -ne "") { $s.openCodeVariant = $OpenCodeVariant }
        $r = Apply-Mode $Mode $s.agyModel $s.openCodeModel $s.openCodeVariant
        (New-Object -ComObject Wscript.Shell).Popup(("Da BAT bao ve. Che do: {0} (tho: {1}).`nAGY: {2} | OpenCode: {3} (variant: {4})" -f $r.mode, $r.active, $r.agy, $r.oc, $r.ocVariant), 10, "Bao ve mailbox", 64) | Out-Null
    } else {
        Show-ChoiceUI (Get-SavedChoice)
    }
}
