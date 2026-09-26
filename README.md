# Vong lap giao viec qua mailbox (Muse <-> OMP)

> English version: [README.en.md](README.en.md).

Repo nay tach tu `AIOS_habbit` (`docs/phieu-viec/mailbox/`): toan bo phia
tu dong hoa vong lap giao viec giua Muse (remote: viet ticket + review) va
OMP (local: lam ticket) qua GitHub. Repo goc (du an AIOS_habbit) khong con
chua cac file nay.

## Co gi trong nay

- `QUY-UOC.md` — ban sao quy uoc dieu phoi (ban chinh nam trong repo du an).
- `HUONG-DAN-WATCHER.md` — huong dan cai + kiem tra watcher.
- `Watch-Mailbox.ps1` — poll mailbox moi ~90 giay + giam sat process OMP,
  popup nhac / canh ket / tu dung khi `xong`. Ban nay da fix 2 loi chan
  (xem `HUONG-DAN-WATCHER.md` muc "Lich su sua loi").
- `Watchdog-Mailbox.ps1` — chay moi 10 phut: khong thay watcher thi mo lai.
- `Install-MailboxTasks.ps1` — dang ky 2 Task Scheduler (`MailboxWatcher`,
  `MailboxWatchdog`) bang 1 lenh. Chay lai bat cu luc nao de cap nhat.
  Mac dinh de **TAT** (mo may khong tu chay).
- `Bat-BaoVe.ps1` / `Tat-BaoVe.ps1` — cong tac bat/tat: nhan 2 click (co
  shortcut ngoai Desktop). Bat thi giu den khi tat, ke ca qua cac lan mo may.

## Cai dat (lam 1 lan)

1. Sua khoi **CAU HINH** trong `Watch-Mailbox.ps1`:
   `$ompProcessName` (ten process OMP trong Task Manager > Details).
   `$AUTO_LAUNCH = $true` (da bat): co ticket moi ma OMP dang ranh thi tu mo
   OMP headless (`omp -p --auto-approve`) chay ticket; OMP dang ban thi chi popup.
   `$SHOW_WORKER_WINDOW = $true` (da bat): mo cua so de nhin chu chay cho yen
   tam; dat `$false` de chay an.
   `$AUTO_RELAUNCH = $true` (da bat): tho bien mat giua ve thi tu mo lai
   (1 lan/ve). Bao ket chi no khi ca hom thu va nhat ky tho cung im.
2. Mo PowerShell, chay:
   `powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1`
3. Kiem tra theo `HUONG-DAN-WATCHER.md` muc "Kiem tra".
4. Hang ngay chi can 2 nut ngoai Desktop: **Bat Bao Ve Mailbox** /
   **Tat Bao Ve Mailbox**. Mac dinh mo may khong tu chay.

## Yeu cau

- Windows PowerShell 5.1, Task Scheduler, quyen dang ky task cho user hien tai.
- Mailbox nam tren repo GitHub public (hoac token `Contents: read` neu repo
  private / muon poll nhanh — xem ghi chu `$token` trong script).
- File runtime (`watcher_state.json`, `_ticket-moi.md`, `*.log`) chi nam local,
  khong commit (da co `.gitignore`).
