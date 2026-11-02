# HƯỚNG DẪN THÊM LÀN MỚI CHO THỢ CANH (WATCHER-NUDGE)
**Mã hiệu**: `STANDARD-WATCHER-NUDGE-V2`  
**Kho mã nguồn**: `Nakazasen/agent-mailbox` (`sidecar/watcher-nudge/`)  
**Đối tượng áp dụng**: Mọi máy trạm (Máy nhà, PC0575, VM) và mọi dự án (Desktop, YouTube, Rebuild, Mobile...)

---

## 1. Nguyên Lý Thiết Kế: Cấu Hình Là Chạy (Config-Driven Architecture)

Trước đây, mỗi khi thêm một làn mới (như làn YouTube), đội ngũ phải sao chép toàn bộ mã nguồn của thợ canh sang thư mục mới (`sidecar/yt-watcher-nudge/watcher.js`), dẫn đến trùng lặp mã nguồn và khó bảo trì các bản vá.

Kiến trúc **Thợ canh Chuẩn Đa Làn (Multi-Lane Standard Watcher)** tách rời hoàn toàn:
- **Động cơ lõi bất biến** (`watcher.js`): Xử lý toàn bộ logic quét hộp thư, kiểm tra sức khỏe tiến trình/log, tự cứu hẹp Git, sinh tệp giục và ghi heartbeat.
- **Tệp cấu hình theo làn** (`lanes/<lane_id>.lane.json`): Khai báo toàn bộ đường dẫn và tham số vận hành riêng biệt của làn đó.

> **QUY TẮC BẤT DI BẤT DỊCH**:
> 1. Thêm làn mới **CHỈ ĐƯỢC TẠO TỆP CẤU HÌNH JSON**, tuyệt đối không sửa một dòng code nào trong `watcher.js`.
> 2. **Cách ly tuyệt đối giữa các làn**: Một làn bị lỗi (sai đường dẫn, crash) **không được phép** làm sập hoặc kéo dừng các làn khác.
> 3. **Bất biến trạng thái**: Toàn bộ nhật ký và tệp khóa tạm thời của thợ canh phải nằm trong `khung-state/<lane_id>/` (ngoài cây Git hoặc đã gitignored). Thợ canh **không bao giờ ghi đè** tệp trạng thái (`registry.json`, `trang-thai.md`) của thợ.

---

## 2. Cấu Trúc Tệp Cấu Hình Làn (`<lane_id>.lane.json`)

Mỗi làn được định nghĩa trong thư mục `sidecar/watcher-nudge/lanes/<lane_id>.lane.json`:

```json
{
  "lane_id": "lan-pc0575",
  "lane_name": "Làn Desktop PC0575 Công Ty",
  "repo_dir": "D:/Sandbox/aios-dieu-phoi-desktop",
  "mailbox_dir": "hop-thu/lan-desktop-pc0575",
  "nudges_dir": "hop-thu/lan-desktop-pc0575/nudges",
  "heartbeats_dir": "hop-thu/lan-desktop-pc0575/heartbeats",
  "heartbeat_file": "hop-thu/lan-desktop-pc0575/heartbeats/heartbeat-pc0575-watcher.json",
  "ket_qua_dir": "hop-thu/lan-desktop-pc0575/ket-qua",
  "prompts_dir": "hop-thu/lan-desktop-pc0575/prompts",
  "registry_file": "hop-thu/lan-desktop-pc0575/registry.json",
  "picker_log_file": "hop-thu/lan-desktop-pc0575/picker.log",
  "picker_process_pattern": "*picker.js*",
  "cycle_seconds": 300,
  "silence_threshold_seconds": 180,
  "cooldown_seconds": 900,
  "realqueue": {
    "enabled": false,
    "worker_process_pattern": "*picker-realqueue*",
    "log_file": "hop-thu/lan-desktop-pc0575/picker-realqueue.log",
    "heartbeat_file": "hop-thu/lan-desktop-pc0575/heartbeats/heartbeat-realqueue-worker.json",
    "silence_threshold_seconds": 1800,
    "heartbeat_interval_seconds": 1800
  },
  "git": {
    "remote": "origin",
    "branch": "main",
    "enable_self_rescue": true
  },
  "state_dir": "khung-state/lan-pc0575"
}
```

### Chi tiết các trường cấu hình:

| Trường | Bắt buộc | Mặc định | Ý nghĩa |
| :--- | :---: | :--- | :--- |
| `lane_id` | Có | - | Định danh duy nhất của làn (viết thường, dấu gạch nối, vd: `lan-desktop`, `youtube`). |
| `lane_name` | Có | `lane_id` | Tên hiển thị người dùng và trong tiêu đề giục. |
| `repo_dir` | Không | Thư mục repo gốc | Đường dẫn tuyệt đối hoặc tương đối tới kho Git của làn. |
| `mailbox_dir` | Có | `hop-thu/<lane_id>` | Đường dẫn thư mục hộp thư nhận vé của làn. |
| `nudges_dir` | Không | `<mailbox_dir>/nudges` | Thư mục lưu tệp giục Markdown khi phát hiện sự kiện. |
| `heartbeats_dir`| Không | `<mailbox_dir>/heartbeats` | Thư mục lưu tệp nhịp tim JSON của làn. |
| `heartbeat_file`| Không | `heartbeat-<lane_id>-watcher.json` | Đường dẫn tệp nhịp tim chính của watcher. |
| `ket_qua_dir` | Không | `<mailbox_dir>/ket-qua` | Thư mục chứa báo cáo hoàn thành vé của thợ. |
| `prompts_dir` | Không | `<mailbox_dir>/prompts` | Thư mục chứa tệp đề bài / vé (nếu tách rời). |
| `registry_file`| Không | `<mailbox_dir>/registry.json` | Tệp sổ cái theo dõi vé của thợ. |
| `picker_log_file`| Không| `<mailbox_dir>/picker.log` | Tệp nhật ký nhịp tim của tiến trình bốc vé (picker). |
| `picker_process_pattern` | Không | `*picker.js*` | Mẫu nhận diện tiến trình picker qua WMI/CIM/CLI. |
| `cycle_seconds`| Không | `300` (5 phút) | Chu kỳ quét định kỳ trạng thái của làn. |
| `silence_threshold_seconds` | Không | `180` (3 phút) | Ngưỡng im lặng tối đa của log picker trước khi báo động. |
| `cooldown_seconds` | Không | `900` (15 phút) | Thời gian giãn cách tối thiểu giữa 2 lần giục cùng loại. |
| `realqueue.enabled` | Không | `false` | Bật/tắt giám sát worker bóng RealQueue (Supabase). |
| `realqueue.supabase_url` | Không | `null` (đọc env) | URL kết nối Supabase PostgREST (nếu không đặt, tự lấy từ `AIOS_REALQUEUE_URL`). |
| `realqueue.supabase_key` | Không | `null` (đọc env) | API Key anon của Supabase (nếu không đặt, tự lấy từ `AIOS_REALQUEUE_KEY`). |
| `realqueue.lease_expired_threshold_seconds` | Không | `0` | Ngưỡng trễ bổ sung (giây) sau khi vé CLAIMED hết hạn lease trước khi giục. |
| `realqueue.dlq_threshold` | Không | `0` | Ngưỡng số lượng vé trong DLQ để kích hoạt cảnh báo `dlq-phinh-len`. |
| `realqueue.check_discrepancy` | Không | `true` | Bật/tắt kiểm tra sai lệch trạng thái giữa bảng tickets và registry.json. |
| `git.enable_self_rescue` | Không | `true` | Bật tự cứu hẹp (fetch + rebase --autostash + push thường). |
| `state_dir` | Không | `khung-state/<lane_id>` | Thư mục lưu trạng thái nội bộ ngoài cây Git. |

---

## 3. Quy Trình 3 Bước Thêm Làn Mới Trong 1 Phút

### Bước 1: Sao chép tệp mẫu
Tại thư mục `agent-mailbox`, sao chép tệp mẫu:
```powershell
cp sidecar/watcher-nudge/lanes/_mau.lane.json sidecar/watcher-nudge/lanes/<ten-lan-moi>.lane.json
```

### Bước 2: Chỉnh sửa thông số làn
Mở tệp `sidecar/watcher-nudge/lanes/<ten-lan-moi>.lane.json` và điền đúng đường dẫn hộp thư, repo, registry của làn mới.

### Bước 3: Kiểm chứng một lượt (One-shot Verification)
Chạy thử nghiệm làn mới để xác nhận watcher đọc đúng trạng thái:
```powershell
node sidecar/watcher-nudge/watcher.js --config=sidecar/watcher-nudge/lanes/<ten-lan-moi>.lane.json --once
```
Hoặc gọi theo mã làn:
```powershell
node sidecar/watcher-nudge/watcher.js --lane=<ten-lan-moi> --once
```
Kết quả JSON in ra `eventsDetected` và `heartbeat` là làn mới đã hoạt động hoàn hảo 100%!

---

## 4. Bảy Sự Kiện Giục Và Cơ Chế Hoạt Động

### A. Nhóm Tín Hiệu Dự Phòng Tệp (File Fallback)
1. **`dong-chua-day` (Vé đóng local nhưng chưa có trên kho)**:
   - Phát hiện khi vé trong `registry.json` có trạng thái `da-dong` và đã có tệp báo cáo trong `ket-qua/`, nhưng lệnh `git ls-tree` trên remote `origin/main` chưa thấy tệp.
   - Tự động kích hoạt cơ chế tự cứu hẹp: `git fetch` -> `git rebase --autostash origin/main` -> `git push origin HEAD:main`. Cấm force push, huỷ an toàn nếu xung đột.
2. **`hang-can` (Hàng đợi cạn, không còn vé đang chạy hoặc chờ slot)**:
   - Phát hiện khi `activeCount === 0`, `queuedCount === 0`, và không có vé `moi` nào trong hộp thư.
   - **Cải tiến trả nợ**: Tệp giục ghi rõ ràng trong cả bảng bằng chứng và phân tích:
     `Số vé đang chạy (dang-chay): 0 (Lưu ý: Không tính chính nó - tức tiến trình watcher/sidecar - vào bộ đếm vé đang chạy)`
3. **`picker-im-lang` (Picker im lặng bất thường)**:
   - Phát hiện khi `picker.log` không cập nhật bản ghi mới quá ngưỡng (mặc định 180s) hoặc không tìm thấy PID tiến trình picker trên hệ điều hành.
   - Trích xuất 20 dòng log cuối cùng gửi điều phối viên.
4. **`realqueue-worker-im-lang` (Worker RealQueue im lặng)**:
   - Dành cho các làn bật `realqueue.enabled: true`.
   - Giám sát worker bóng RealQueue, tự động giục khi log ngừng quá 30 phút hoặc tiến trình dừng.

### B. Nhóm Tín Hiệu Supabase Real Queue (Mở rộng v2.1.0)
5. **`ve-claimed-qua-han-lease` (Vé CLAIMED quá hạn lease)**:
   - Phát hiện vé có `state IN ('CLAIMED', 'EXECUTING')` trong bảng `tickets` nhưng `lease_expires_at` đã trôi qua thời gian hiện tại mà chưa chuyển sang `COMPLETED`.
   - Sinh tệp giục: `YYYYMMDD-HHMMSS-ve-claimed-qua-han-lease-<MA_VE>.md`.
6. **`dlq-phinh-len` (Hàng lỗi DLQ phình lên)**:
   - Phát hiện bảng `ticket_dlq` có vé lỗi cách ly chưa xử lý (`resolved_at IS NULL`) vượt ngưỡng cấu hình `dlq_threshold` hoặc số lượng tăng lên so với chu kỳ trước.
   - Sinh tệp giục: `YYYYMMDD-HHMMSS-dlq-phinh-len.md`.
7. **`lech-tickets-registry` (Lệch giữa bảng tickets và registry)**:
   - Phát hiện sự bất đồng nhất giữa CSDL Supabase và sổ cái `registry.json` (vé CLAIMED nhưng thiếu trong registry, vé đã COMPLETED nhưng registry vẫn dang-chay, hoặc registry đã đóng nhưng Supabase chưa hoàn tất).
   - Sinh tệp giục: `YYYYMMDD-HHMMSS-lech-tickets-registry.md`.

---

## 5. Cải Tiến Bộ Đếm Nhịp Tim (`tong_so_nudge_da_phat`)

- Trước đây: `tong_so_nudge_da_phat` là biến đếm trên RAM của tiến trình, bị reset về 0 sau mỗi lần khởi động lại hoặc khi chạy one-shot, dẫn đến số liệu heartbeat bị lệch.
- **Chuẩn mới v2**: Watcher tự động quét số lượng tệp giục `.md` thực tế trong thư mục `nudges_dir` của làn tại mỗi chu kỳ ghi heartbeat. Đảm bảo số lượng luôn phản ánh chính xác 100% bằng chứng thực tế trên đĩa.

---

## 6. Chế Độ Vận Hành

- **Chạy toàn bộ các làn (Multi-Lane Daemon)**:
  ```powershell
  node sidecar/watcher-nudge/watcher.js --all
  ```
- **Chạy riêng 1 làn duy nhất (Single-Lane Daemon)**:
  ```powershell
  node sidecar/watcher-nudge/watcher.js --lane=lan-desktop
  ```
- **Chạy kiểm tra một lần (Dry-run / CI Test)**:
  ```powershell
  node sidecar/watcher-nudge/watcher.js --lane=lan-desktop --once
  ```
- **Cấu hình Antigravity Sidecar**:
  Đã tích hợp sẵn tệp `sidecar/watcher-nudge/sidecar.json` để Antigravity quản lý tự động khởi động và tự phục hồi khi đăng ký.
