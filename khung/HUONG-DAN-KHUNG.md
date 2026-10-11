# Hướng dẫn cài + vận hành khung watcher đa project

Áp cho máy nhà `h410asrock` (máy chạy các watcher). Mọi lệnh chạy trong thư mục `khung\` của repo `agent-mailbox` đã pull về máy.

## 1. Chuẩn bị

1. Pull repo `agent-mailbox` mới nhất (có thư mục `khung\`).
2. Kiểm tra đường dẫn trong `khung\projects\youtube-omp.project.ps1` khớp máy: clone `D:\Sandbox\aios-dieu-phoi`, `omp.exe` tại `C:\Users\Admin\AppData\Local\omp\omp.exe`. Lệch thì sửa trong file cấu hình đó (không sửa engine).

## 2. Kiểm chứng lần đầu (BẮT BUỘC, chạy tay có giám sát)

Chạy thử 1 vòng ở chế độ chỉ-báo-quyết-định, chưa mở thợ thật:

```powershell
cd <duong-dan>\agent-mailbox\khung
powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project youtube -Once -DryRun
```

Đọc dòng log in ra: phải thấy watcher đọc đúng trạng thái hộp thư `youtube\mailbox-omp` (hiện là `moi`, vé RESEARCH-THI-TRUONG-01) và câu `[DRYRUN] Se mo tho lane omp-audit: ... --profile youtube ...`. Đồng thời mở `D:\Sandbox\watcher-state\tong-quan.html` — phải có tab YouTube với đúng trạng thái đó.

Chạy tiếp 1 vòng monitor cho AIOS để có tab thứ hai:

```powershell
powershell -ExecutionPolicy Bypass -File Watch-Project.ps1 -Project aios-habbit -Once
```

## 3. Bật tự động

```powershell
powershell -ExecutionPolicy Bypass -File Cai-Lan.ps1 -Project youtube -Start
powershell -ExecutionPolicy Bypass -File Cai-Lan.ps1 -Project aios-habbit -Start
```

- Task `KhungWatcher-youtube`: watcher thường trú, quét mỗi 90 giây. Thấy hộp thư `moi` + không có OMP `--profile youtube` nào đang chạy → tự mở `omp --profile youtube` với prompt bốc vé chuẩn (đọc `PROMPT-BOC-VE-OMP.md` trong clone).
- Task `KhungWatcher-aios-habbit`: chỉ đọc trạng thái các hộp thư AIOS lên trang tổng quan — watcher cũ của AIOS vẫn là bên mở thợ cho AIOS, không thay đổi gì.
- Theo dõi: `D:\Sandbox\watcher-state\youtube\watcher.log` (mọi quyết định), `launches.log` (mỗi lần mở thợ: giờ, vé, pid), trang `tong-quan.html` (trạng thái các làn).

## 4. Vận hành hằng ngày

- **Dừng khẩn cấp 1 project**: tạo file tên `PAUSE` trong `D:\Sandbox\watcher-state\<project>\` (dừng mở thợ, vẫn báo trạng thái). Xoá file là chạy tiếp.
- **Gỡ hẳn 1 project**: `Cai-Lan.ps1 -Project <tên> -Remove` (state/log giữ nguyên).
- **Thêm project mới**: copy `projects\_mau.project.ps1` → `projects\<tên>.project.ps1`, sửa giá trị, chạy kiểm chứng khô như mục 2, rồi `Cai-Lan.ps1 -Project <tên> -Start`. Không sửa `Watch-Project.ps1`.
- **Quota xAI của làn YouTube**: mỗi vé audit tốn ~4% hạn mức SuperGrok tuần (số đo vòng pilot 2026-10-11). Watcher có trần cứng: 1 thợ/lane + tối thiểu 15 phút giữa 2 lần mở. Muốn siết thêm: tăng `MinLaunchIntervalMinutes` trong file cấu hình làn, hoặc đặt `PAUSE`.

## 5. Giới hạn đã biết

- Nhận diện thợ đang chạy dựa trên tên process + command line (CIM). Nếu CIM lỗi, engine lui về kiểm tra tên process đơn thuần và ghi log.
- Trạng thái hộp thư được xác định theo quy tắc "mốc thời gian mới nhất thắng" (StatusMode `newest`) — đúng quy ước điều phối hiện hành; lane nào dùng quy ước khác thì đặt `first`/`last` trong cấu hình lane.
- Watcher không tự pull khi clone đang bẩn — thợ/điều phối đang dở tay thì watcher đứng ngoài, chỉ ghi vào snapshot là `clone-ban-bo-qua-pull`.
