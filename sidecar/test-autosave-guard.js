const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const picker = require('./picker.js');
const {
  isFileMatchingTicket,
  stageAllowedChanges,
  REPO_DIR,
  MAILBOX_DIR,
  KET_QUA_DIR,
  REPO_REGISTRY_FILE
} = picker;

console.log('====================================================');
console.log('KIỂM THỬ BẢO VỆ BẰNG CHỨNG AUTOSAVE GUARD CHO PICKER');
console.log('====================================================\n');

// -----------------------------------------------------------------
// TEST 1: Kiểm thử logic khớp tệp vé (isFileMatchingTicket)
// -----------------------------------------------------------------
console.log('--- TEST 1: Unit Test isFileMatchingTicket ---');
const runningMaVe = 'DESKTOP-PICKER-AUTOSAVE-GUARD-HOME';
const closedMaVe = 'DESKTOP-VSS-SHADOW-CAP-HOME';

// Tệp kết quả chính
assert.strictEqual(isFileMatchingTicket('DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md', runningMaVe), true, 'Khớp .md chính xác');
assert.strictEqual(isFileMatchingTicket('hop-thu/lan-desktop/ket-qua/DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md', runningMaVe), true, 'Khớp đường dẫn tương đối');
assert.strictEqual(isFileMatchingTicket('desktop-picker-autosave-guard-home.md', runningMaVe), true, 'Khớp chữ thường');

// Tệp phụ đính kèm mang mã vé
assert.strictEqual(isFileMatchingTicket('server_desktop_picker_autosave_guard_home.log', runningMaVe), true, 'Khớp underscore log');
assert.strictEqual(isFileMatchingTicket('anh-desktop-picker-autosave-guard-home-01.png', runningMaVe), true, 'Khớp ảnh đính kèm');
assert.strictEqual(isFileMatchingTicket('picker-autosave-guard-home-verify.json', runningMaVe), true, 'Khớp lõi sau tiền tố');

// Tệp của vé khác / vé đã đóng
assert.strictEqual(isFileMatchingTicket('DESKTOP-VSS-SHADOW-CAP-HOME.md', runningMaVe), false, 'Không khớp vé đã đóng');
assert.strictEqual(isFileMatchingTicket('T-PAR-A.md', runningMaVe), false, 'Không khớp vé T-PAR-A');
assert.strictEqual(isFileMatchingTicket('server_stress_rerun_fixed_scoring_home.log', runningMaVe), false, 'Không khớp log vé khác');

// Thư mục lưu trữ bằng chứng đã nộp
assert.strictEqual(isFileMatchingTicket('luu-tru-bang-chung/DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md', runningMaVe), false, 'Chặn tệp trong luu-tru-bang-chung');

// Kiểm tra vé đã đóng khớp chính nó
assert.strictEqual(isFileMatchingTicket('DESKTOP-VSS-SHADOW-CAP-HOME.md', closedMaVe), true, 'Khớp vé đã đóng chính nó');
assert.strictEqual(isFileMatchingTicket('vss-shadow-cap-home.log', closedMaVe), true, 'Khớp lõi vé đã đóng');

console.log('✓ TEST 1 PASS: Tất cả các điều kiện khớp/chặn đều chính xác 100%.\n');

// -----------------------------------------------------------------
// TEST 2: Mô phỏng thay đổi giả lên tệp vé đã đóng và kiểm chứng hai chiều
// -----------------------------------------------------------------
console.log('--- TEST 2: Kiểm chứng mô phỏng hai chiều trên kho điều phối ---');

const closedTicketFileRel = 'hop-thu/lan-desktop/ket-qua/DESKTOP-VSS-SHADOW-CAP-HOME.md';
const closedTicketFileAbs = path.join(REPO_DIR, closedTicketFileRel);

const runningTicketFileRel = 'hop-thu/lan-desktop/ket-qua/DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md';
const runningTicketFileAbs = path.join(REPO_DIR, runningTicketFileRel);

assert.strictEqual(fs.existsSync(closedTicketFileAbs), true, 'Tệp vé đã đóng phải tồn tại trên đĩa');

// Đọc nội dung gốc của tệp vé đã đóng
const originalClosedContent = fs.readFileSync(closedTicketFileAbs, 'utf-8');

const unknownFileRel = 'hop-thu/lan-desktop/ket-qua/unknown-random-artifact.log';
const unknownFileAbs = path.join(REPO_DIR, unknownFileRel);

try {
  // BƯỚC A: Tạo thay đổi giả trên tệp vé đã đóng
  const fakeAppend = '\n\n<!-- FAKE MODIFICATION FOR AUTOSAVE GUARD TEST 2026-10-16 -->\n';
  fs.writeFileSync(closedTicketFileAbs, originalClosedContent + fakeAppend, 'utf-8');
  console.log(`[TẠO THAY ĐỔI GIẢ] Đã sửa tệp vé đã đóng: ${closedTicketFileRel}`);

  // BƯỚC B: Tạo tệp kết quả bản nháp cho vé đang chạy
  const runningDraft = '# BẢN NHÁP VÉ ĐANG CHẠY DESKTOP-PICKER-AUTOSAVE-GUARD-HOME\n';
  fs.writeFileSync(runningTicketFileAbs, runningDraft, 'utf-8');
  console.log(`[TẠO TỆP HỢP LỆ] Đã tạo tệp kết quả của vé đang chạy: ${runningTicketFileRel}`);

  // BƯỚC B2: Tạo một tệp rác/không xác định trong ket-qua/
  fs.writeFileSync(unknownFileAbs, 'some rogue log content\n', 'utf-8');
  console.log(`[TẠO TỆP RÁC] Đã tạo tệp không xác định: ${unknownFileRel}`);

  // BƯỚC C: Nạp registry thực tế (chứa vé đang chạy và vé đã đóng)
  const registry = JSON.parse(fs.readFileSync(REPO_REGISTRY_FILE, 'utf-8'));
  const isRunningPresent = registry.some(r => r.ma_ve === runningMaVe && r.trang_thai === 'dang-chay');
  const isClosedPresent = registry.some(r => r.ma_ve === closedMaVe && r.trang_thai === 'da-dong');
  assert.strictEqual(isRunningPresent, true, `Vé ${runningMaVe} phải ở trạng thái dang-chay trong registry`);
  assert.strictEqual(isClosedPresent, true, `Vé ${closedMaVe} phải ở trạng thái da-dong trong registry`);

  // BƯỚC D: Chạy cơ chế stageAllowedChanges mô phỏng auto-save trước git pull
  console.log('[CHẠY AUTO-SAVE] Gọi stageAllowedChanges("auto-save", registry)...');
  stageAllowedChanges('auto-save', registry);

  // BƯỚC E: Kiểm tra git diff --cached (những gì đã được stage vào commit)
  const stagedFilesOut = execSync('git -c core.quotepath=false diff --cached --name-only', {
    cwd: REPO_DIR,
    encoding: 'utf-8'
  });
  const stagedFiles = stagedFilesOut.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  console.log('[CÁC TỆP ĐƯỢC STAGE CHO AUTO-SAVE]:', stagedFiles);

  // KIỂM CHỨNG CHIỀU 1: Tệp của vé đã đóng PHẢI BỊ CHẶN (KHÔNG ĐƯỢC STAGE)
  const isClosedStaged = stagedFiles.some(f => f.includes('DESKTOP-VSS-SHADOW-CAP-HOME.md'));
  assert.strictEqual(isClosedStaged, false, 'TỆP CỦA VÉ ĐÃ ĐÓNG TUYỆT ĐỐI KHÔNG ĐƯỢC STAGE VÀO AUTO-SAVE COMMIT');
  console.log('✓ CHIỀU 1 ĐẠT: Tệp của vé đã đóng bị CHẶN HOÀN TOÀN khỏi git stage.');

  // KIỂM CHỨNG CHIỀU 1B: Tệp rác/không xác định PHẢI BỊ CHẶN (KHÔNG ĐƯỢC STAGE)
  const isUnknownStaged = stagedFiles.some(f => f.includes('unknown-random-artifact.log'));
  assert.strictEqual(isUnknownStaged, false, 'TỆP RÁC/KHÔNG XÁC ĐỊNH TUYỆT ĐỐI KHÔNG ĐƯỢC STAGE VÀO AUTO-SAVE COMMIT');
  console.log('✓ CHIỀU 1B ĐẠT: Tệp rác/không xác định bị CHẶN theo nguyên tắc an toàn bằng chứng.');

  // KIỂM CHỨNG CHIỀU 2: Tệp của vé đang chạy ĐƯỢC PHÉP STAGE VÀ NỘP BÌNH THƯỜNG
  const isRunningStaged = stagedFiles.some(f => f.includes('DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md'));
  assert.strictEqual(isRunningStaged, true, 'TỆP CỦA VÉ ĐANG CHẠY PHẢI ĐƯỢC STAGE THÀNH CÔNG VÀO AUTO-SAVE');
  console.log('✓ CHIỀU 2 ĐẠT: Tệp của vé đang chạy được STAGE HỢP LỆ.');

  // KIỂM CHỨNG CHIỀU 3: Kiểm tra luồng đóng vé bình thường (pushStatus với action dong-ve)
  console.log('\n--- Kiểm tra luồng đóng vé bình thường (dong-ve) ---');
  stageAllowedChanges(`dong-ve-${runningMaVe}`, registry);

  const closingStagedOut = execSync('git -c core.quotepath=false diff --cached --name-only', {
    cwd: REPO_DIR,
    encoding: 'utf-8'
  });
  const closingStaged = closingStagedOut.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  console.log('[CÁC TỆP ĐƯỢC STAGE KHI ĐÓNG VÉ]:', closingStaged);

  assert.strictEqual(closingStaged.some(f => f.includes('DESKTOP-VSS-SHADOW-CAP-HOME.md')), false, 'Tệp vé đã đóng vẫn bị chặn khi đóng vé khác');
  assert.strictEqual(closingStaged.some(f => f.includes('DESKTOP-PICKER-AUTOSAVE-GUARD-HOME.md')), true, 'Tệp của vé được đóng được nộp bình thường');
  console.log('✓ CHIỀU 3 ĐẠT: Luồng đóng vé bình thường không bị gãy.');

} finally {
  // Dọn dẹp trạng thái mô phỏng: khôi phục nguyên trạng tệp vé đã đóng
  fs.writeFileSync(closedTicketFileAbs, originalClosedContent, 'utf-8');
  execSync(`git checkout HEAD -- "${closedTicketFileRel}"`, { cwd: REPO_DIR, stdio: 'pipe' });

  // Xóa tệp nháp và tệp rác, reset stage
  if (fs.existsSync(runningTicketFileAbs)) {
    fs.unlinkSync(runningTicketFileAbs);
  }
  if (fs.existsSync(unknownFileAbs)) {
    fs.unlinkSync(unknownFileAbs);
  }
  execSync('git reset HEAD', { cwd: REPO_DIR, stdio: 'pipe' });
  console.log('\n[DỌN DẸP] Đã khôi phục nguyên trạng workspace và git index.');
}

console.log('\n====================================================');
console.log('TOÀN BỘ CÁC BÀI KIỂM THỬ ĐÃ ĐẠT 100%!');
console.log('====================================================');
