# Watcher Windows — tu dong nhac/giam sat OMP (v4: vong lap cuong che 2 dau)

Repo doc lap: `agent-mailbox`. Ban chinh cua quy uoc (`QUY-UOC.md`) nam trong
repo du an; day la ban sao kem theo bo watcher.

## Y tuong

- **Dau 1 (Muse, tren VM):** viet ticket → poll mailbox moi 5 phut → review,
  tra verdict. Khong co gi moi thi im lang.
- **Dau 2 (script nay, may Windows):** poll mailbox moi ~90 giay + kiem tra
  OMP con song khong (qua ten process), roi:
  - Ticket `moi` + OMP dang ranh → popup (hoac **tu mo OMP** neu bat
    `$AUTO_LAUNCH`)
  - Ticket `moi` + OMP dang mo nhung chua nhan → nhac nhe 1 lan
  - `dang-lam` + thay process OMP → **im lang** (dang lam thi thoi)
  - `dang-lam` + khong thay process → **tu mo lai tho** chay tiep
    (`$AUTO_RELAUNCH`, 1 lan/vé, chi khi khong con process OMP nao); het
    luot moi bao "OMP bien mat?"
  - `dang-lam` qua 20 phut khong tien trien tren hom thu **va** nhat ky tho
    cung im (>5 phut, `$heartbeatMinutes`) → canh bao ket. Tho dang lam
    viec dai (log van chay) thi khong het oan.
  - `xong-cho-duyet` → popup (Muse se review trong ~5 phut)
  - `xong` → **khong dung ngay**: dem so lan check lien tiep thay `xong` on
    dinh (mac dinh 3 lan ≈ 4,5 phut, chinh bang `$idleExitChecks`) de loai tru
    ghi nham/thoang qua, roi popup **tong ket** (liet ke ticket da xong trong
    dot) + **tu dung script**

Nguoi van giu chot duyet: ticket nao cung "dung cho duyet", Muse hoi ban
trong chat truoc khi viet ticket tiep theo.

Luu y: `xong-cho-duyet` KHONG tinh la "het viec" de dung — vi co the dang
cho ban duyet ticket tiep theo (ban di vang vai tieng la binh thuong).
Script cu chay nen nhe (1 request GitHub/90s), khong ton gi. Muon chay tiep
sau khi da tu dung (Muse mo ticket moi sau nay) thi chay lai script.

## Cai dat (lam 1 lan)

1. Sua khoi **CAU HINH** trong `Watch-Mailbox.ps1`:
   - `$ompProcessName`: ten process OMP trong Task Manager > Details
     (khong co `.exe`). Mo OMP len roi vao Task Manager xem cho chac.
   - Muon full tu dong: dien `$ompLaunchCommand` + `$ompLaunchArgs` roi dat
     `$AUTO_LAUNCH = $true`. **Chi lam khi OMP cua ban ho tro chay kem prompt
     tu dong lenh** (che do headless/non-interactive, vd `omp -p "..."`).
     Khong chac thi de `$false` — script chi popup nhac, ban mo OMP tay.
   - `$SHOW_WORKER_WINDOW` (`$true` mac dinh): tu mo OMP thi mo cua so de
     nhin chu chay cho yen tam (xong viec cua so tu tat). Dat `$false` de
     chay an hoan toan.
2. Mo PowerShell, chay (dang ky Task Scheduler, khong can dong tay sau do):
   `powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1`
   - Task `MailboxWatcher`: chay khi logon, an, tu restart moi 1 phut khi loi.
   - Task `MailboxWatchdog`: moi 10 phut kiem tra, mat watcher thi mo lai.
3. (Du phong thu cong) Chuot phai `Watch-Mailbox.ps1` → Run with PowerShell.
   Neu bi chan: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Kiem tra no canh dung khong

- Mo OMP, de no lam ticket → script phai im lang (tru khi ket >20 phut).
- Tat OMP khi dang `dang-lam` → phai popup "OMP bien mat?".
- Nho Muse viet ticket test (`moi`) khi OMP tat → phai popup "ticket moi
  (OMP ranh)".

## Quy uoc cho OMP (de watcher canh duoc)

- Nhan ticket: dat `trang-thai.md` thanh `dang-lam` NGAY, kem `ghi_chu` co
  timestamp (gio may).
- Moi moc quan trong: cap nhat `ghi_chu` + timestamp roi push.

## Tuy chinh

- `$pollSeconds` (90), `$moiWarnMinutes` (15), `$stuckMinutes` (20),
  `$idleExitChecks` (3).
- Poll 60 giay: them token fine-grained (Contents: read), bo comment dong
  `$token`. Khong commit token len git.
- `watcher_state.json` / `watcher.log`: trang thai + log, khong can commit.

## Lich su sua loi (ban trong repo nay)

1. URL GitHub API build sai: `"$path?ref="` bi PowerShell expand thanh rong
   (luon 404 `contents/=...`). Fix: dung `${path}`.
2. Pattern regex tieng Viet khong khop tren PowerShell 5.1 khi file khong BOM
   va may dung ANSI codepage khac (vd Shift-JIS): `status`/`ticket` luon rong.
   Fix: luu `Watch-Mailbox.ps1` dang UTF-8 co BOM.
