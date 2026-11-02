# BỘ THỢ CANH CHUẨN ĐA LÀN (MULTI-LANE WATCHER NUDGE)
**Repository**: `Nakazasen/agent-mailbox`  
**Đường dẫn**: `sidecar/watcher-nudge/`  
**Phiên bản**: `2.0.0-standard`  

---

## 1. Mục đích
Module thợ canh chuẩn hóa dùng chung cho toàn bộ hệ thống Agent Mailbox trên mọi máy trạm (Máy nhà, PC0575, VM).
Nó giám sát trạng thái cục bộ thực tế của từng làn (hộp thư, tiến trình bốc vé, log, git commit ahead), phát hiện các điểm nghẽn và tự động giục điều phối viên qua các tệp Markdown kèm thời gian và bằng chứng thực tế.

## 2. Điểm Khác Biệt So Với Bản V1 (aios-dieu-phoi-desktop)
1. **Kiến trúc đa làn hướng cấu hình (Config-Driven Multi-Lane)**:
   - Một lõi `watcher.js` duy nhất cho toàn bộ các làn.
   - Thêm làn mới chỉ bằng cách tạo tệp cấu hình JSON trong thư mục `lanes/`. Không cần copy-paste hay sửa code lõi.
2. **Cách ly lỗi tuyệt đối (Fault Isolation)**:
   - Các làn chạy độc lập; ngoại lệ hoặc lỗi tại 1 làn không ảnh hưởng đến các làn khác.
3. **Đã trả 2 khoản nợ kỹ thuật từ 31/10**:
   - **Nợ 1**: Tệp giục `hang-can` ghi nhận rõ ràng "không tính chính nó" (tiến trình watcher) vào bộ đếm vé đang chạy.
   - **Nợ 2**: Bộ đếm `tong_so_nudge_da_phat` trong tệp nhịp tim (heartbeat) đếm trực tiếp số tệp giục `.md` trên đĩa, không bị lệch hoặc reset khi khởi động lại.
4. **Tích hợp giám sát Worker bóng RealQueue (Supabase)**:
   - Tùy chọn cấu hình `realqueue.enabled` theo từng làn, kiểm tra sức khỏe worker, độ tươi của log, lỗi kết nối và lệch mirror registry.

## 3. Cấu Trúc Thư Mục
```text
sidecar/watcher-nudge/
├── watcher.js                     # Động cơ thợ canh chuẩn hóa
├── package.json                   # Cấu hình gói và kịch bản chạy
├── sidecar.json                   # Định nghĩa sidecar cho Antigravity Desktop
├── README.md                      # Tài liệu tổng quan
├── HUONG-DAN-THEM-LAN-MOI.md      # Hướng dẫn chi tiết cách thêm làn mới bằng cấu hình
├── test_watcher_standard.js       # Bộ kiểm thử tự động chứng minh thêm làn không sửa code lõi
└── lanes/                         # Thư mục chứa cấu hình từng làn
    ├── _mau.lane.json             # Tệp mẫu đầy đủ các trường
    ├── desktop.lane.json          # Cấu hình cho làn Desktop (AIOS WorkLens)
    └── youtube.lane.json          # Cấu hình cho làn YouTube
```

## 4. Kiểm Thử
Chạy bộ kiểm thử tự động:
```powershell
node sidecar/watcher-nudge/test_watcher_standard.js
```
Bộ kiểm thử sẽ tự động tạo một làn giả lập hoàn toàn mới qua cấu hình JSON, kích hoạt và kiểm chứng toàn bộ 4 sự kiện, 2 cải tiến trả nợ và cơ chế cách ly lỗi mà không hề sửa code lõi.
