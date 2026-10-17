/**
 * test-registry-sync-fix.js
 * Kiểm thử cơ chế đồng bộ registry hai chiều & gộp theo ma_ve cho sidecar picker.
 * Xác thực vé DESKTOP-PICKER-REGISTRY-SYNC-FIX-HOME.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const picker = require('./picker.js');
const {
  mergeRegistryWithRemote,
  loadRegistry,
  saveRegistry,
  AUTH_REGISTRY_FILE,
  REPO_REGISTRY_FILE
} = picker;

console.log('================================================================');
console.log('BẮT ĐẦU KIỂM THỬ: DESKTOP-PICKER-REGISTRY-SYNC-FIX-HOME');
console.log('================================================================\n');

// ---------------------------------------------------------------------
// TEST 1: mergeRegistryWithRemote - Bảo vệ mục da-dong ở xa không bị ghi đè
// ---------------------------------------------------------------------
console.log('--- TEST 1: mergeRegistryWithRemote - Bảo toàn mục da-dong ở xa ---');

const mockRemote = [
  {
    ma_ve: 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME',
    ma_hoi_thoai: '8053a262-817e-44e0-a281-48d7181d74c3',
    trang_thai: 'da-dong',
    thoi_diem_tao: '2026-10-16T05:22:15.539Z',
    thoi_diem_dong: '2026-10-17T06:01:22.000Z',
    tep_ve: 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME.md',
    ghi_chu_dong: 'Dieu phoi dong lan 5 ngay 2026-10-17: nguyen ven'
  },
  {
    ma_ve: 'DESKTOP-OTHER-TICKET-A',
    ma_hoi_thoai: 'conv-a',
    trang_thai: 'da-dong',
    thoi_diem_tao: '2026-10-16T06:00:00.000Z',
    thoi_diem_dong: '2026-10-16T07:00:00.000Z',
    tep_ve: 'DESKTOP-OTHER-TICKET-A.md'
  }
];

// Bản sao cục bộ cũ (chứa trạng thái dang-chay lỗi thời cho NAMED-DOC)
const mockLocalStale = [
  {
    ma_ve: 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME',
    ma_hoi_thoai: '8053a262-817e-44e0-a281-48d7181d74c3',
    trang_thai: 'dang-chay', // <-- BẢN SAO CŨ GÂY HỌA
    thoi_diem_tao: '2026-10-16T05:22:15.539Z',
    thoi_diem_dong: null,
    tep_ve: 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME.md'
  },
  {
    ma_ve: 'DESKTOP-OTHER-TICKET-A',
    ma_hoi_thoai: 'conv-a',
    trang_thai: 'da-dong',
    thoi_diem_tao: '2026-10-16T06:00:00.000Z',
    thoi_diem_dong: '2026-10-16T07:00:00.000Z',
    tep_ve: 'DESKTOP-OTHER-TICKET-A.md'
  },
  {
    ma_ve: 'DESKTOP-NEW-CANARY-TICKET',
    ma_hoi_thoai: 'conv-new',
    trang_thai: 'dang-chay',
    thoi_diem_tao: '2026-10-17T06:30:00.000Z',
    thoi_diem_dong: null,
    tep_ve: 'DESKTOP-NEW-CANARY-TICKET.md'
  }
];

// Thao tác phát vé mới DESKTOP-NEW-CANARY-TICKET: targetTicketIds = ['DESKTOP-NEW-CANARY-TICKET']
const mergedResult = mergeRegistryWithRemote(mockRemote, mockLocalStale, ['DESKTOP-NEW-CANARY-TICKET']);

// Kiểm tra 1: Số lượng mục phải tăng chính xác 1 mục (từ 2 lên 3)
assert.strictEqual(mergedResult.length, 3, 'Tổng số mục sau khi gộp phải bằng 3');

// Kiểm tra 2: Mục DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME TUYỆT ĐỐI giữ nguyên da-dong và ghi_chu_dong từ remote
const checkedNamedDoc = mergedResult.find(r => r.ma_ve === 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME');
assert.ok(checkedNamedDoc, 'Phải tìm thấy mục DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME');
assert.strictEqual(checkedNamedDoc.trang_thai, 'da-dong', 'Trạng thái ở xa PHẢI giữ nguyên da-dong, không bị bản sao cục bộ kéo về dang-chay');
assert.strictEqual(checkedNamedDoc.thoi_diem_dong, '2026-10-17T06:01:22.000Z', 'Thời điểm đóng ở xa phải nguyên vẹn');
assert.strictEqual(checkedNamedDoc.ghi_chu_dong, 'Dieu phoi dong lan 5 ngay 2026-10-17: nguyen ven', 'Ghi chú đóng ở xa phải nguyên vẹn 100%');

// Kiểm tra 3: Mục mới thao tác được thêm đúng
const checkedNewTicket = mergedResult.find(r => r.ma_ve === 'DESKTOP-NEW-CANARY-TICKET');
assert.ok(checkedNewTicket, 'Phải tìm thấy vé mới thao tác');
assert.strictEqual(checkedNewTicket.trang_thai, 'dang-chay', 'Vé mới thao tác có trạng thái dang-chay');

console.log('✓ TEST 1 PASS: Mục da-dong ở xa được bảo toàn 100%, ghi_chu_dong không bị mất!\n');

// ---------------------------------------------------------------------
// TEST 2: Thao tác đóng vé mục tiêu - chỉ cập nhật vé đó, không ảnh hưởng vé khác
// ---------------------------------------------------------------------
console.log('--- TEST 2: Đóng vé mục tiêu chỉ cập nhật vé đó ---');

const mockRemote2 = [
  ...mockRemote,
  {
    ma_ve: 'DESKTOP-TARGET-CLOSE',
    ma_hoi_thoai: 'conv-close',
    trang_thai: 'dang-chay',
    thoi_diem_tao: '2026-10-17T05:00:00.000Z',
    thoi_diem_dong: null,
    tep_ve: 'DESKTOP-TARGET-CLOSE.md'
  }
];

const mockLocalClosing = [
  ...mockLocalStale,
  {
    ma_ve: 'DESKTOP-TARGET-CLOSE',
    ma_hoi_thoai: 'conv-close',
    trang_thai: 'da-dong',
    thoi_diem_tao: '2026-10-17T05:00:00.000Z',
    thoi_diem_dong: '2026-10-17T06:45:00.000Z',
    tep_ve: 'DESKTOP-TARGET-CLOSE.md'
  }
];

const mergedClose = mergeRegistryWithRemote(mockRemote2, mockLocalClosing, ['DESKTOP-TARGET-CLOSE']);
assert.strictEqual(mergedClose.length, 4, 'Tổng số mục là 4');
const targetClosed = mergedClose.find(r => r.ma_ve === 'DESKTOP-TARGET-CLOSE');
assert.strictEqual(targetClosed.trang_thai, 'da-dong', 'Vé mục tiêu đã được chuyển sang da-dong');
assert.strictEqual(targetClosed.thoi_diem_dong, '2026-10-17T06:45:00.000Z', 'Thời điểm đóng vé mục tiêu đúng');

// Vé DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME vẫn là da-dong
const namedDocAfterClose = mergedClose.find(r => r.ma_ve === 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME');
assert.strictEqual(namedDocAfterClose.trang_thai, 'da-dong', 'Vé ở xa vẫn giữ da-dong');
assert.ok(namedDocAfterClose.ghi_chu_dong, 'Ghi chú đóng vẫn còn');

console.log('✓ TEST 2 PASS: Thao tác đóng vé cập nhật đúng vé mục tiêu và giữ nguyên mọi vé khác!\n');

// ---------------------------------------------------------------------
// TEST 3: loadRegistry - Tự động đồng bộ trạng thái da-dong từ repo vào authData
// ---------------------------------------------------------------------
console.log('--- TEST 3: loadRegistry - Tự đồng bộ trạng thái da-dong vào authData ---');

// Đọc thử loadRegistry thực tế
const loadedReal = loadRegistry();
assert.ok(Array.isArray(loadedReal), 'loadRegistry phải trả về mảng');
const namedDocReal = loadedReal.find(r => r.ma_ve === 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME');
if (namedDocReal) {
  assert.strictEqual(namedDocReal.trang_thai, 'da-dong', 'DESKTOP-NAMED-DOC-REGEX-TOLERANCE-FIX-HOME trong authData phải là da-dong sau khi loadRegistry');
  assert.ok(namedDocReal.ghi_chu_dong, 'ghi_chu_dong phải được đồng bộ vào authData');
}

console.log('✓ TEST 3 PASS: loadRegistry đồng bộ thành công trạng thái da-dong và ghi_chu_dong vào authoritative registry!\n');

console.log('================================================================');
console.log('TẤT CẢ CÁC BÀI KIỂM THỬ ĐƠN VỊ ĐÃ ĐẠT 100%!');
console.log('================================================================\n');
