# Cap-Nhat-Picker.ps1 - Cai dat hoac cap nhat sidecar picker cho Antigravity Desktop
# Ho tro ca may nha (h410asrock) va may cong ty (KDTVN-PC0575).
# Tu dong copy picker.js, sidecar.json, package.json vao thu muc sidecars cua user.
#
# Cach dung:
#   powershell -ExecutionPolicy Bypass -File .\khung\Cap-Nhat-Picker.ps1
#   powershell -ExecutionPolicy Bypass -File .\khung\Cap-Nhat-Picker.ps1 -RestartSidecar
#
param(
    [switch]$RestartSidecar = $true
)

$ErrorActionPreference = "Stop"

$KhungDir = $PSScriptRoot
$RepoRoot = Split-Path $KhungDir -Parent
$SourceSidecarDir = Join-Path $RepoRoot "sidecar"

if (-not (Test-Path -LiteralPath $SourceSidecarDir)) {
    Write-Error "Khong tim thay thu muc nguon: $SourceSidecarDir"
    exit 1
}

# Thu muc dich: ~/.gemini/config/sidecars/agy-mailbox-picker/
$UserHome = [Environment]::GetFolderPath("UserProfile")
$TargetDir = Join-Path $UserHome ".gemini\config\sidecars\agy-mailbox-picker"

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "[TAO THU MUC] Da tao thu muc sidecar: $TargetDir"
}

# Sao chep cac file cau hinh va ma nguon
$files = @("picker.js", "sidecar.json", "package.json")
foreach ($f in $files) {
    $src = Join-Path $SourceSidecarDir $f
    $dst = Join-Path $TargetDir $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Write-Host "[CAP NHAT] Da sao chep $f -> $dst"
    }
}

# Sao chep vao ca clone aios-dieu-phoi neu co
$DieuPhoiSidecar = "D:\Sandbox\aios-dieu-phoi\sidecar\picker.js"
if (Test-Path -LiteralPath (Split-Path $DieuPhoiSidecar -Parent)) {
    Copy-Item -LiteralPath (Join-Path $SourceSidecarDir "picker.js") -Destination $DieuPhoiSidecar -Force
    Write-Host "[DONG BO] Da cap nhat sidecar picker trong kho dieu phoi: $DieuPhoiSidecar"
}

Write-Host "Da cap nhat thanh cong sidecar picker v2 (tu dong day ket qua len kho)."

# Khoi dong lai tien trinh sidecar neu duoc yeu cau
if ($RestartSidecar) {
    try {
        $procs = Get-CimInstance Win32_Process | Where-Object {
            ($_.CommandLine -like "*picker.js*" -and $_.CommandLine -like "*sidecar*") -or
            ($_.Name -eq "cmd.exe" -and $_.CommandLine -like "*agy-node.cmd*picker.js*")
        }
        if ($procs) {
            Write-Host "[KHOI DONG LAI] Dang ngat cac tien trinh sidecar cu de Antigravity tu nap lai ma moi..."
            foreach ($p in $procs) {
                try { Stop-Process -Id $p.ProcessId -Force; Write-Host "  -> Da ngat PID $($p.ProcessId)" } catch {}
            }
            Write-Host "[HOAN TAT] Antigravity app se tu dong tai lai sidecar moi trong vong 5 giay."
        } else {
            Write-Host "[THONG BAO] Khong thay tien trinh sidecar picker dang chay."
        }
    } catch {
        Write-Warning "Khong the tu khoi dong lai sidecar: $($_.Exception.Message)"
    }
}
