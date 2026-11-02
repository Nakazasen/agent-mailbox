# BỘ THỢ CANH CHUẨN ĐA LÀN (MULTI-LANE WATCHER NUDGE)
**Repository**: `Nakazasen/agent-mailbox`  
**Đường dẫn**: `sidecar/watcher-nudge/`  
**Phiên bản**: `2.1.0-standard` (Mở rộng 3 tín hiệu Supabase)  

---

## 1. Mục Đích
Module thợ canh chuẩn hóa dùng chung cho toàn bộ hệ thống Agent Mailbox trên mọi máy trạm (Máy nhà, PC0575, VM).
Nó giám sát hai tuyến điều phối song song:
1. **Tuyến Thời Gian Thực (Supabase Real Queue)**: Trạng thái hàng chờ PostgREST, hạn hợp đồng thuê vé (Lease), hàng chờ chết (DLQ) và độ lệch đồng bộ với sổ cái kiểm toán.
2. **Tuyến Lưu Trữ Cục Bộ (File System & Git Audit)**: Quét hộp thư, tiến trình bốc vé, log, git commit ahead làm dự phòng bền vững khi worker chết hoặc mất mạng.

Khi phát hiện sự cố hoặc điểm nghẽn, thợ canh tự động sinh tệp giục Markdown có cấu trúc chuẩn vào thư mục `nudges/` kèm mã trace, bằng chứng thực tế và hành động đề xuất cho Điều phối viên.

---

## 2. Danh Mục 7 Tín Hiệu Giám Sát Chuẩn

Hệ thống hỗ trợ 7 tín hiệu phát hiện và sinh tệp giục riêng biệt:

### A. Nhóm Tín Hiệu Supabase Real Queue (Mới trong v2.1.0)
| Mã sự kiện | Tên tệp giục | Điều kiện kích hoạt | Phân tích & Hành động đề xuất |
|---|---|---|---|
| **`ve-claimed-qua-han-lease`** | `YYYYMMDD-HHMMSS-ve-claimed-qua-han-lease-<MA_VE>.md` | Vé đang `CLAIMED` / `EXECUTING` nhưng `lease_expires_at` đã quá hạn mà chưa có báo cáo kết quả nghiệm thu | Worker bị treo hoặc ngắt đột tử; đề xuất gọi RPC `reap_expired_leases` để thu hồi vé về `QUEUED` / `FAILED` |
| **`dlq-phinh-len`** | `YYYYMMDD-HHMMSS-dlq-phinh-len.md` | Bảng `ticket_dlq` có vé lỗi chưa xử lý (`resolved_at IS NULL`) vượt ngưỡng cấu hình hoặc tăng thêm | Vé lỗi quá 4 lần liên tiếp (max_retries); điều phối viên cần kiểm tra `final_error` và giải phóng cách ly |
| **`lech-tickets-registry`** | `YYYYMMDD-HHMMSS-lech-tickets-registry.md` | Xuất hiện sai lệch trạng thái giữa CSDL Supabase và sổ cái `registry.json` | Mất đồng bộ giữa hai tuyến; điều phối viên đối chiếu tệp kết quả và cập nhật `completeTicket` hoặc `registry.json` |

### B. Nhóm Tín Hiệu Dự Phòng Tệp (File Fallback)
| Mã sự kiện | Tên tệp giục | Điều kiện kích hoạt | Phân tích & Hành động đề xuất |
|---|---|---|---|
| **`dong-chua-day`** | `YYYYMMDD-HHMMSS-dong-chua-day-<MA_VE>.md` | Vé đã đóng local (`da-dong`) có tệp kết quả nhưng commit chưa xuất hiện trên `origin/main` | Tự kích hoạt chuỗi tự cứu hẹp (`git rebase --autostash` + `push`); giục điều phối viên nếu có xung đột |
| **`hang-can`** | `YYYYMMDD-HHMMSS-hang-can.md` | Không còn vé nào đang chạy (`dang-chay`) hoặc chờ slot (`cho-slot`) trong làn | Báo máy trạm rảnh 100%, sẵn sàng nhận nhiệm vụ mới. *(Ghi rõ không tính chính nó vào bộ đếm)* |
| **`picker-im-lang`** | `YYYYMMDD-HHMMSS-picker-im-lang.md` | Tiến trình picker truyền thống hoặc tệp `picker.log` im lặng vượt ngưỡng | Kiểm tra tài nguyên máy trạm hoặc khởi động lại tiến trình |
| **`realqueue-worker-im-lang`** | `YYYYMMDD-HHMMSS-realqueue-worker-im-lang.md` | Worker RealQueue bóng (`picker-realqueue.js`) dừng chạy hoặc log im lặng vượt ngưỡng | Giục điều phối viên khởi động lại worker RealQueue |

---

## 3. Cấu Trúc Thư Mục
```text
sidecar/watcher-nudge/
├── watcher.js                     # Động cơ thợ canh chuẩn hóa đa làn (v2.1.0-standard)
├── supabase-reader.js             # Module kết nối PostgREST Supabase không phụ thuộc thư viện ngoài
├── package.json                   # Cấu hình gói và kịch bản test (npm test)
├── sidecar.json                   # Đặc tả sidecar cho Antigravity Desktop
├── README.md                      # Tài liệu tổng quan kiến trúc
├── HUONG-DAN-THEM-LAN-MOI.md      # Hướng dẫn chi tiết cách thêm làn mới bằng cấu hình
├── test_watcher_standard.js       # Bộ kiểm thử tự động 13 kịch bản
├── test_standard_results.json     # Bằng chứng kết quả 13/13 test pass 100%
└── lanes/                         # Thư mục cấu hình từng làn
    ├── _mau.lane.json             # Tệp mẫu kèm chú thích đầy đủ trường cấu hình
    ├── desktop.lane.json          # Cấu hình cho làn Desktop (AIOS WorkLens)
    └── youtube.lane.json          # Cấu hình cho làn YouTube
```

---

## 4. Tùy Chọn Cấu Hình Supabase Theo Làn
Trong tệp `<ten_lan>.lane.json`:
```json
{
  "lane_id": "lan-desktop",
  "realqueue": {
    "enabled": true,
    "supabase_url": null,
    "supabase_key": null,
    "lease_expired_threshold_seconds": 0,
    "dlq_threshold": 0,
    "check_discrepancy": true,
    "silence_threshold_seconds": 1800,
    "heartbeat_interval_seconds": 1800
  }
}
```
*Ghi chú*: Nếu `supabase_url` và `supabase_key` là `null`, thợ canh tự động đọc an toàn từ biến môi trường `AIOS_REALQUEUE_URL` và `AIOS_REALQUEUE_KEY` (hỗ trợ cả `process.env` và `HKCU\Environment`).

---

## 5. Kiểm Thử Tự Động (Deterministic Verification)
Chạy bộ kiểm thử tự động:
```powershell
cd sidecar/watcher-nudge
node test_watcher_standard.js
```
Bộ kiểm thử bao gồm **13 kịch bản toàn diện**:
- Kiểm chứng thêm làn mới 100% qua JSON không sửa mã nguồn lõi.
- Kiểm chứng 4 tín hiệu quét tệp dự phòng (`dong-chua-day`, `hang-can`, `picker-im-lang`, `realqueue-worker-im-lang`).
- Kiểm chứng 2 khoản nợ kỹ thuật (bộ đếm "không tính chính nó" và `tong_so_nudge_da_phat`).
- Kiểm chứng bất biến cách ly lỗi đa làn và bất biến không sửa đè registry của thợ.
- **Kiểm chứng trạng thái hàng chờ Supabase sạch (Clean State)**: Không sinh bất kỳ cảnh báo giả nào.
- **Kiểm chứng 3 tín hiệu Supabase (Stuck States)**: Vé CLAIMED quá hạn lease, DLQ phình lên, lệch trạng thái tickets và registry.
- **Kiểm chứng tính kiên cường & dự phòng tệp**: Khi Supabase mất kết nối mạng, watcher không bị crash và tiếp tục giám sát qua tuyến tệp.
