# Khung watcher đa project (agent-mailbox/khung)

Một chương trình chung cho mọi project điều phối qua hộp thư git: **1 engine, N project**.
Mỗi project (một "làn") được tách bằng đúng 5 thứ:

| Tách | Bằng cách |
|---|---|
| Tab giao diện | Mỗi project một tab trên trang `tong-quan.html` (watcher tự sinh mỗi vòng quét) |
| Thư mục | Cây hộp thư riêng trong repo của project (luật "cây ai nấy ghi" như cũ) |
| Watcher | Tiến trình riêng theo project — một làn sập không kéo làn khác |
| Cấu hình | Một file `projects/<tên>.project.ps1` riêng |
| Lệnh mở thợ | Khai trong cấu hình của lane (vd YouTube: `omp --profile youtube`) |

Thêm project mới = thêm 1 file cấu hình + cài 1 task. **Không sửa engine.**

## Thành phần

- `Watch-Project.ps1` — engine chung (tham số `-Project <tên>`, `-Once`, `-DryRun`).
- `Cai-Lan.ps1` — cài/gỡ Scheduled Task cho từng project.
- `projects/_mau.project.ps1` — mẫu cấu hình để copy.
- `projects/youtube.project.ps1` — làn YouTube (tự động bốc vé OMP/xAI, thay bốc tay).
- `projects/aios-habbit.project.ps1` — làn AIOS ở chế độ monitor (watcher cũ vẫn sở hữu việc mở thợ; khung chỉ đọc trạng thái lên tab riêng).
- `HUONG-DAN-KHUNG.md` — hướng dẫn cài + vận hành + kiểm chứng lần chạy đầu.

## Luật cứng của khung (bài học đã trả giá, không được phá)

1. Watcher **không bao giờ ghi/sửa** file `trang-thai.md` hay `prompt.md` của thợ — chỉ đọc.
2. State/khoá/log của watcher nằm **ngoài các cây repo điều phối**: engine tự đặt ở thư mục `khung-state` ngay trong thư mục clone agent-mailbox (máy nhà: `D:\Sandbox\Vong_lap_giao_viec\khung-state`; tên thư mục clone ở máy khác khác thì tự khớp theo vị trí cài). Thư mục này đã được `.gitignore` của repo loại trừ — không bao giờ bị commit/pull đè. Đổi chỗ bằng `StateRoot` trong cấu hình project hoặc `$StateRootOverride` trong `khung\config.local.ps1`.
3. Không leo thang, không đổi trạng thái thay thợ/điều phối; lỗi phụ (pull lỗi, đọc process lỗi) chỉ ghi log, không chặn việc chính.
4. Mỗi lane tối đa **1 thợ chạy cùng lúc** (nhận diện bằng tên process + command line, vd `--profile youtube`), kèm khoảng cách tối thiểu giữa 2 lần mở (mặc định 15 phút).
5. Đồng bộ: chỉ `git pull --ff-only` khi cây sạch — cây bẩn thì bỏ qua, không stash, không reset.
6. Công tắc dừng khẩn cấp: tạo file `PAUSE` trong `khung-state\<project>\` là watcher ngừng mở thợ (vẫn đọc + báo trạng thái).
7. Mọi file watcher ghi ra đều UTF-8 **không BOM**.
