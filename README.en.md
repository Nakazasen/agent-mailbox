# Ticket loop via mailbox (Muse <-> OMP)

> Ban tieng Viet: [README.md](README.md).

Split out of `AIOS_habbit` (`docs/phieu-viec/mailbox/`): the full Windows
automation side of the ticket loop between Muse (remote: writes tickets +
reviews) and OMP (local: works tickets) over GitHub. The source project repo
no longer contains these files.

## What's inside

- `QUY-UOC.md` — copy of the coordination protocol (Vietnamese; the master
  copy lives in the project repo).
- `HUONG-DAN-WATCHER.md` — watcher setup + verification guide (Vietnamese).
- `Watch-Mailbox.ps1` — polls the mailbox every ~90 s + monitors the OMP
  process: reminder popups / stuck alerts / self-stop on `xong`. This build
  fixes 2 blocking bugs (see "Bugfix history" in the guide).
- `Watchdog-Mailbox.ps1` — runs every 10 min: relaunches the watcher if missing.
- `Install-MailboxTasks.ps1` — registers 2 Task Scheduler tasks
  (`MailboxWatcher`, `MailboxWatchdog`) with one command. Re-runnable.
  Default state is **OFF** (no auto-start on boot).
- `Bat-BaoVe.ps1` / `Tat-BaoVe.ps1` — ON/OFF switch: double-click (Desktop
  shortcuts included). ON persists across reboots until switched OFF.

## Setup (once)

1. Edit the **CONFIG** block in `Watch-Mailbox.ps1`:
   `$ompProcessName` (OMP process name in Task Manager > Details).
   `$AUTO_LAUNCH = $true` (enabled): on a new ticket with OMP idle, launches
   headless OMP (`omp -p --auto-approve`) to work the ticket; if OMP is busy,
   popup only.
   `$SHOW_WORKER_WINDOW = $true` (enabled): show the worker window so you can
   watch it work; set `$false` for fully hidden runs.
   `$AUTO_RELAUNCH = $true` (enabled): relaunch the worker if it vanishes
   mid-ticket (once per ticket). Stuck alerts fire only when both mailbox
   and worker log go quiet.
2. Open PowerShell and run:
   `powershell -ExecutionPolicy Bypass -File Install-MailboxTasks.ps1`
3. Verify per the "Kiem tra" section of `HUONG-DAN-WATCHER.md`.
4. Daily use is just 2 Desktop buttons: **Bat Bao Ve Mailbox** (ON) /
   **Tat Bao Ve Mailbox** (OFF). Boot default is OFF.

## Second machine (e.g. company PC0575)

1. Clone this repo + the project repo (keep `D:\Sandbox\AIOS_habbit` like home).
2. Install omp + Git (user scope, no admin needed).
3. Copy `config.PC0575.ps1` to `config.local.ps1`, fix the omp path if
   installed elsewhere (open a terminal, run `where omp`). No admin needed.
4. Run `Install-MailboxTasks.ps1`, press the **ON** button.

## Requirements

- Windows PowerShell 5.1, Task Scheduler, permission to register tasks for the
  current user.
- Mailbox on a public GitHub repo (or a fine-grained `Contents: read` token
  for private repos / faster polling — see the `$token` note in the script).
- Runtime files (`watcher_state.json`, `_ticket-moi.md`, `*.log`) stay local,
  never committed (covered by `.gitignore`).
