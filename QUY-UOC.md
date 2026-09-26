# Quy ước mailbox — điều phối việc giữa Muse và OMP qua GitHub

Branch làm việc: `phieu-viec/rag-fix1`. **Không push/merge trực tiếp, không đụng `main`.**

## Vai trò

- **Muse** (reviewer/kiến trúc sư): viết prompt việc vào `mailbox/prompt.md`, commit + push.
  Đọc báo cáo từ git, review độc lập, trả verdict cho user duyệt.
- **OMP** (agent local, máy nhà `h410asrock`): đọc `mailbox/prompt.md` sau khi
  `git pull`, làm đúng theo từng bước, dừng chờ duyệt ở các điểm prompt yêu cầu.

## Luồng một vòng việc

1. Muse ghi prompt mới vào `docs/phieu-viec/mailbox/prompt.md`, commit + push.
2. OMP: `git pull origin phieu-viec/rag-fix1` → đọc `prompt.md` → làm theo.
3. OMP xong một bước: commit + push như cũ, báo cáo vào `docs/phieu-viec/ket-qua/`
   (quy ước cũ giữ nguyên), **đồng thời** cập nhật `docs/phieu-viec/mailbox/trang-thai.md`:
   - `trang_thai`: `dang-lam` | `xong-cho-duyet`
   - `commit`: SHA commit mới nhất của bước vừa xong
   - `bao_cao`: đường dẫn file báo cáo trong `docs/phieu-viec/ket-qua/`
   - `ghi_chu`: tóm tắt 1–2 dòng
4. Muse tự đọc báo cáo từ git, review, trả verdict trong chat. User duyệt rồi mới sang bước tiếp.

## Quy tắc bất biến (áp dụng mọi ticket)

- Mọi tính năng mới nằm sau feature flag, mặc định tắt.
- Mọi thao tác ghi index thật: dry-run trước + backup trước, cần user duyệt rõ ràng.
- Không merge vào `main` khi chưa có đèn xanh rõ ràng của user.
- OMP chỉ đọc `prompt.md`, không tự sửa file này. Muse chỉ đọc `trang-thai.md` và báo cáo, không sửa.
- Prompt mới của Muse luôn ghi đè toàn bộ `prompt.md` (mỗi thời điểm chỉ có một việc active).

## Trạng thái `xong` và watcher Windows (vòng khép kín)

- Khi không còn ticket nào (hết việc / hết lỗi), Muse đặt `trang-thai.md`
  thành `xong` thay vì `moi`. Đây là trạng thái kết thúc, không phải ticket mới.
- Trên máy nhà chạy script `Watch-Mailbox.ps1` (xem `HUONG-DAN-WATCHER.md`):
  poll `trang-thai.md` mỗi ~90 s; thấy `moi` mới → popup nhắc OMP đọc
  `prompt.md` (đồng thời lưu bản local `_ticket-moi.md`); thấy `xong` →
  popup báo hết việc, vòng lặp dừng.
- Vòng khép kín: Muse viết ticket (`moi`) → watcher nhắc → OMP làm
  (`dang-lam` → `xong-cho-duyet`) → cron của Muse review mỗi 5 phút →
  ĐẠT → Muse viết ticket tiếp (`moi`) … cho đến khi Muse đặt `xong`.

## Quy ước báo tiến độ cho OMP (để watcher canh kẹt)

- Nhận ticket: đặt `trang-thai.md` thành `dang-lam` NGAY LẬP TỨC (commit +
  push), kèm `ghi_chu` có timestamp giờ máy.
- Mỗi mốc quan trọng (init xong, chạy xong batch/câu hỏi, verify xong):
  cập nhật `ghi_chu` + timestamp trong `trang-thai.md` rồi push.
- Watcher Windows coi "`dang-lam` quá 20 phút không đổi `ghi_chu`/commit"
  là kẹt và popup cảnh báo; "`moi` quá 15 phút không ai nhận" thì popup
  nhắc OMP `git pull` và đọc mailbox.
