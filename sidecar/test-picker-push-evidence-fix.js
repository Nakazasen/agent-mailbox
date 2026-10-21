/**
 * test-picker-push-evidence-fix.js
 * Bộ kiểm thử toàn diện xác thực vé DESKTOP-PICKER-PUSH-EVIDENCE-FIX-HOME
 *
 * Kiểm tra:
 * - Unit tests:
 *   1. extractDeclaredFilesFromReport: trích xuất chính xác mọi tệp bằng chứng khai trong báo cáo.
 *   2. getSessionCreatedFiles: thu thập tệp tạo/sửa trong phiên kể cả tên không chứa mã vé.
 *   3. getAllowedFilesForTicket: tổng hợp đầy đủ báo cáo + tệp khai + tệp tạo trong phiên.
 *   4. checkSourceCodeCommitOnRemote: kiểm tra commit kho AIOS_habbit đã mở trên remote chưa.
 * - Fault-Injection (3 ca bắt buộc theo mục 2e):
 *   Ca 1: Bằng chứng mang tên riêng không chứa mã vé (chuẩn R2) -> nộp lên remote trọn vẹn.
 *   Ca 2: Remote tiến lên giữa lúc nộp (commit chèn vào) -> fetch + rebase phục hồi, không mất commit khác.
 *   Ca 3: Đẩy thất bại không phục hồi được -> registry KHÔNG đóng, tệp báo động làn và cục bộ tồn tại.
 * Dọn sạch toàn bộ môi trường thử nghiệm sau khi hoàn tất.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const picker = require('./picker.js');
const {
  extractDeclaredFilesFromReport,
  getSessionCreatedFiles,
  getAllowedFilesForTicket,
  checkSourceCodeCommitOnRemote,
  verifyRemoteEvidence,
  createSubmissionAlarm,
  clearSubmissionAlarm,
  commitAndPushWithRetry,
  submitTicket,
  isFileMatchingTicket,
  mergeRegistryWithRemote
} = picker;

console.log('================================================================');
console.log('BẮT ĐẦU KIỂM THỬ: DESKTOP-PICKER-PUSH-EVIDENCE-FIX-HOME');
console.log('================================================================\n');

// =====================================================================
// PHẦN 1: UNIT TESTS
// =====================================================================
console.log('--- PHẦN 1: UNIT TESTS ---');

// Test 1.1: extractDeclaredFilesFromReport
console.log('1.1. Kiểm thử extractDeclaredFilesFromReport...');
const tempTestDir = path.join(__dirname, 'test-temp-' + Date.now());
fs.mkdirSync(tempTestDir, { recursive: true });
const tempKetQua = path.join(tempTestDir, 'ket-qua');
fs.mkdirSync(tempKetQua, { recursive: true });

fs.writeFileSync(path.join(tempKetQua, 'anh-pareto-01.png'), 'fake image', 'utf-8');
fs.writeFileSync(path.join(tempKetQua, 'runner_official_r2_metrics.json'), '{"score": 99}', 'utf-8');
fs.writeFileSync(path.join(tempKetQua, 'browser_run.log'), 'log data', 'utf-8');

const sampleReport = `
# BÁO CÁO NGHIỆM THU
- Ảnh biểu đồ Pareto: ![pareto](anh-pareto-01.png)
- Số liệu runner chính thức: \`runner_official_r2_metrics.json\`
- Bảng log chi tiết:
| Tên tệp | Kích thước |
| \`browser_run.log\` | 1024 B |
- Liên kết web bên ngoài: https://example.com/some-image.png (phải bị bỏ qua)
- Tệp không tồn tại: \`non_existent_file.png\` (phải bị bỏ qua)
`;

const declaredFiles = extractDeclaredFilesFromReport(sampleReport, tempKetQua, tempTestDir);
console.log('  -> Các tệp khai báo phát hiện được:', declaredFiles);

assert.strictEqual(declaredFiles.some(f => f.includes('anh-pareto-01.png')), true, 'Phải nhận diện ảnh markdown');
assert.strictEqual(declaredFiles.some(f => f.includes('runner_official_r2_metrics.json')), true, 'Phải nhận diện tệp trong backtick');
assert.strictEqual(declaredFiles.some(f => f.includes('browser_run.log')), true, 'Phải nhận diện tệp trong bảng biểu');
assert.strictEqual(declaredFiles.some(f => f.includes('non_existent_file.png')), false, 'Không nhận diện tệp không tồn tại');
console.log('✓ 1.1 PASS: extractDeclaredFilesFromReport nhận diện chính xác 100% các tệp có thật.\n');

// Test 1.2: getSessionCreatedFiles
console.log('1.2. Kiểm thử getSessionCreatedFiles...');
const now = Date.now();
const ticketEntry = {
  ma_ve: 'TEST-SESSION-01',
  thoi_diem_tao: new Date(now - 10000).toISOString()
};

const newFile = path.join(tempKetQua, 'new-output-artifact.csv');
fs.writeFileSync(newFile, 'a,b,c', 'utf-8');

const sessionFiles = getSessionCreatedFiles(ticketEntry, tempKetQua, tempTestDir);
console.log('  -> Các tệp tạo trong phiên:', sessionFiles);
assert.strictEqual(sessionFiles.some(f => f.includes('new-output-artifact.csv')), true, 'Phải nhận diện tệp tạo trong phiên');
console.log('✓ 1.2 PASS: getSessionCreatedFiles thu thập tệp tạo trong phiên thành công.\n');

// Test 1.3: getAllowedFilesForTicket
console.log('1.3. Kiểm thử getAllowedFilesForTicket...');
const reportPath = path.join(tempKetQua, 'TEST-SESSION-01.md');
fs.writeFileSync(reportPath, sampleReport, 'utf-8');

const allAllowed = getAllowedFilesForTicket(ticketEntry, tempKetQua, tempTestDir);
console.log('  -> Toàn bộ tệp hợp lệ cho vé:', allAllowed);
assert.strictEqual(allAllowed.some(f => f.includes('TEST-SESSION-01.md')), true, 'Phải có tệp báo cáo');
assert.strictEqual(allAllowed.some(f => f.includes('anh-pareto-01.png')), true, 'Phải có ảnh khai trong báo cáo');
assert.strictEqual(allAllowed.some(f => f.includes('runner_official_r2_metrics.json')), true, 'Phải có tệp json khai trong báo cáo');
assert.strictEqual(allAllowed.some(f => f.includes('new-output-artifact.csv')), true, 'Phải có tệp tạo trong phiên');
console.log('✓ 1.3 PASS: getAllowedFilesForTicket gộp đủ 100% sản phẩm phiên.\n');

try {
  fs.rmSync(tempTestDir, { recursive: true, force: true });
} catch (e) {}

// Test 1.4: checkSourceCodeCommitOnRemote
console.log('1.4. Kiểm thử checkSourceCodeCommitOnRemote...');
if (fs.existsSync('D:/Sandbox/AIOS_habbit/.git')) {
  let pushedCommit = '';
  try {
    pushedCommit = execSync('git -C "D:/Sandbox/AIOS_habbit" rev-parse origin/phieu-viec/rag-fix1', { encoding: 'utf-8' }).trim();
  } catch (e) {
    try {
      pushedCommit = execSync('git -C "D:/Sandbox/AIOS_habbit" rev-parse origin/main', { encoding: 'utf-8' }).trim();
    } catch (e2) {}
  }

  if (pushedCommit) {
    const reportWithPushed = `# Báo cáo\n- Commit mã nguồn: \`${pushedCommit}\`\n`;
    const checkOk = checkSourceCodeCommitOnRemote(reportWithPushed, 'D:/Sandbox/AIOS_habbit');
    assert.strictEqual(checkOk.valid, true, 'Commit đã đẩy lên remote phải hợp lệ');
    console.log(`  -> Đã kiểm tra commit thật ${pushedCommit.slice(0, 8)} trên remote: HỢP LỆ.`);
  }

  const reportWithFake = `# Báo cáo\n- Commit mã nguồn: \`0000000000000000000000000000000000000000\`\n`;
  const checkFake = checkSourceCodeCommitOnRemote(reportWithFake, 'D:/Sandbox/AIOS_habbit');
  assert.strictEqual(checkFake.valid, true, 'SHA không tồn tại trong repo thì bỏ qua');
  console.log('✓ 1.4 PASS: checkSourceCodeCommitOnRemote hoạt động chuẩn xác.\n');
}

// =====================================================================
// PHẦN 2: FAULT-INJECTION TESTS (MỤC 2E)
// =====================================================================
console.log('--- PHẦN 2: FAULT-INJECTION TESTS (MỤC 2E) ---');

const sandboxRoot = path.join(__dirname, 'sandbox-fault-injection-' + Date.now());
fs.mkdirSync(sandboxRoot, { recursive: true });

const bareRemoteDir = path.join(sandboxRoot, 'bare-remote.git');
const localRepoDir = path.join(sandboxRoot, 'local-repo');
const peerRepoDir = path.join(sandboxRoot, 'peer-repo');
const sidecarConfigDir = path.join(sandboxRoot, 'sidecar-config');
fs.mkdirSync(sidecarConfigDir, { recursive: true });

try {
  // 1. Tạo bare remote
  execSync(`git init --bare "${bareRemoteDir}"`, { stdio: 'pipe' });

  // 2. Clone localRepo và khởi tạo nhánh main
  execSync(`git clone "${bareRemoteDir}" "${localRepoDir}"`, { stdio: 'pipe' });
  execSync('git config user.name "Test Runner"', { cwd: localRepoDir });
  execSync('git config user.email "test@runner.local"', { cwd: localRepoDir });

  // Thiết lập cấu trúc thư mục làn
  const laneMailbox = path.join(localRepoDir, 'hop-thu', 'lan-desktop');
  const laneKetQua = path.join(laneMailbox, 'ket-qua');
  const lanePrompts = path.join(laneMailbox, 'prompts');
  [laneMailbox, laneKetQua, lanePrompts].forEach(d => fs.mkdirSync(d, { recursive: true }));

  // Khởi tạo registry.json và commit đầu tiên
  const initialRegistry = [
    {
      ma_ve: 'DESKTOP-EXISTING-CLOSED-01',
      ma_hoi_thoai: 'conv-01',
      trang_thai: 'da-dong',
      thoi_diem_tao: '2026-10-20T00:00:00.000Z',
      thoi_diem_dong: '2026-10-20T01:00:00.000Z',
      tep_ve: 'DESKTOP-EXISTING-CLOSED-01.md'
    }
  ];
  fs.writeFileSync(path.join(laneMailbox, 'registry.json'), JSON.stringify(initialRegistry, null, 2), 'utf-8');
  fs.writeFileSync(path.join(laneKetQua, 'DESKTOP-EXISTING-CLOSED-01.md'), '# Báo cáo vé đã đóng cũ\n', 'utf-8');
  fs.writeFileSync(path.join(laneMailbox, 'picker.log'), `[${new Date().toISOString()}] Khởi tạo test repo\n`, 'utf-8');

  execSync('git add -A', { cwd: localRepoDir });
  execSync('git commit -m "chore: initial lane setup"', { cwd: localRepoDir });
  execSync('git branch -M main', { cwd: localRepoDir });
  execSync('git push -u origin main', { cwd: localRepoDir });

  // 3. Clone peerRepo
  execSync(`git clone -b main "${bareRemoteDir}" "${peerRepoDir}"`, { stdio: 'pipe' });
  execSync('git config user.name "Peer Worker"', { cwd: peerRepoDir });
  execSync('git config user.email "peer@worker.local"', { cwd: peerRepoDir });

  // Thiết lập môi trường chạy cho picker
  process.env.AIOS_DIEU_PHOI_DIR = localRepoDir;
  process.env.AIOS_MAILBOX_DIR = laneMailbox;
  process.env.AIOS_KET_QUA_DIR = laneKetQua;
  process.env.AIOS_PROMPTS_DIR = lanePrompts;
  process.env.AIOS_REPO_REGISTRY = path.join(laneMailbox, 'registry.json');
  process.env.AIOS_LOG_FILE = path.join(laneMailbox, 'picker.log');
  process.env.AIOS_SIDECAR_DIR = sidecarConfigDir;
  process.env.AIOS_AUTH_REGISTRY = path.join(sidecarConfigDir, 'registry-authoritative.json');

  // Khởi tạo authoritative registry
  fs.writeFileSync(process.env.AIOS_AUTH_REGISTRY, JSON.stringify(initialRegistry, null, 2), 'utf-8');

  // -------------------------------------------------------------------
  // CA 1: TIÊM LỖI BẰNG CHỨNG CÓ CHỦ Ý KHÔNG CHỨA MÃ VÉ (CHUẨN R2)
  // -------------------------------------------------------------------
  console.log('\n--- CA 1: Tiêm lỗi bằng chứng mang tên riêng không chứa mã vé (Mẫu hình R2) ---');
  const ticket1 = 'DESKTOP-STRESS-R2-TEST-FI-01';

  const regCa1 = JSON.parse(fs.readFileSync(process.env.AIOS_AUTH_REGISTRY, 'utf-8'));
  regCa1.push({
    ma_ve: ticket1,
    ma_hoi_thoai: 'conv-ca1',
    trang_thai: 'dang-chay',
    thoi_diem_tao: new Date().toISOString(),
    thoi_diem_dong: null,
    tep_ve: `${ticket1}.md`
  });
  fs.writeFileSync(process.env.AIOS_AUTH_REGISTRY, JSON.stringify(regCa1, null, 2), 'utf-8');
  fs.writeFileSync(process.env.AIOS_REPO_REGISTRY, JSON.stringify(regCa1, null, 2), 'utf-8');

  // Tạo các tệp bằng chứng CÓ CHỦ Ý KHÔNG CHỨA MÃ VÉ TRONG TÊN (đúng mẫu hình vòng R2)
  const evidenceFile1 = path.join(laneKetQua, 'runner_official_r2_scoring_metrics.json');
  const evidenceFile2 = path.join(laneKetQua, 'browser-acceptance-r2-viewport.png');
  fs.writeFileSync(evidenceFile1, JSON.stringify({ r2_score: 99, status: 'PASS' }, null, 2), 'utf-8');
  fs.writeFileSync(evidenceFile2, 'fake-png-binary-content-r2', 'utf-8');

  const reportCa1 = path.join(laneKetQua, `${ticket1}.md`);
  const reportContentCa1 = `# BÁO CÁO NGHIỆM THU VÉ ${ticket1}
- Bằng chứng số liệu: \`runner_official_r2_scoring_metrics.json\`
- Ảnh chụp kiểm định: \`browser-acceptance-r2-viewport.png\`
`;
  fs.writeFileSync(reportCa1, reportContentCa1, 'utf-8');

  console.log(`[CA 1] Đã tạo tệp báo cáo và 2 tệp bằng chứng độc lập không chứa mã vé.`);

  const activeEntryCa1 = regCa1.find(r => r.ma_ve === ticket1);
  const closedTicketIdsCa1 = ['DESKTOP-EXISTING-CLOSED-01'];
  const sessionFilesCa1 = getAllowedFilesForTicket(activeEntryCa1, laneKetQua, localRepoDir, closedTicketIdsCa1);
  console.log('[CA 1] Danh sách tệp sản phẩm phiên nhận diện được:', sessionFilesCa1);

  assert.strictEqual(sessionFilesCa1.some(f => f.includes('runner_official_r2_scoring_metrics.json')), true, 'Ca 1: Phải nhận diện metrics json');
  assert.strictEqual(sessionFilesCa1.some(f => f.includes('browser-acceptance-r2-viewport.png')), true, 'Ca 1: Phải nhận diện viewport png');

  // Nộp bài và tự kiểm chứng trên remote
  const submitResultCa1 = commitAndPushWithRetry(ticket1, sessionFilesCa1, regCa1, 4);
  assert.strictEqual(submitResultCa1.success, true, 'Ca 1: commitAndPushWithRetry phải thành công');

  // Kiểm tra trực tiếp trên remote bare repo: cả 3 tệp phải tồn tại trên blob của origin/main!
  const remoteTreeOut = execSync('git ls-tree -r --name-only origin/main', { cwd: localRepoDir, encoding: 'utf-8' });
  console.log('[CA 1] Cây tệp trên remote origin/main sau khi nộp:\n' + remoteTreeOut);

  assert.strictEqual(remoteTreeOut.includes('runner_official_r2_scoring_metrics.json'), true, 'Ca 1: Remote origin/main PHẢI có runner_official_r2_scoring_metrics.json');
  assert.strictEqual(remoteTreeOut.includes('browser-acceptance-r2-viewport.png'), true, 'Ca 1: Remote origin/main PHẢI có browser-acceptance-r2-viewport.png');
  assert.strictEqual(remoteTreeOut.includes(`${ticket1}.md`), true, 'Ca 1: Remote origin/main PHẢI có báo cáo .md');

  // Kiểm tra trạng thái trong authoritative registry: phải là da-dong
  const updatedAuthCa1 = JSON.parse(fs.readFileSync(process.env.AIOS_AUTH_REGISTRY, 'utf-8'));
  const closedTicketEntry1 = updatedAuthCa1.find(r => r.ma_ve === ticket1);
  assert.strictEqual(closedTicketEntry1.trang_thai, 'da-dong', 'Ca 1: Vé phải được đánh dấu da-dong');

  console.log('✓ CA 1 ĐẠT: Bằng chứng mẫu hình R2 không chứa mã vé đã nộp lên kho remote trọn vẹn 100%!\n');

  // -------------------------------------------------------------------
  // CA 2: MÔ PHỎNG REMOTE TIẾN LÊN GIỮA LÚC NỘP (COMMIT KHÁC CHÈN VÀO)
  // -------------------------------------------------------------------
  console.log('--- CA 2: Mô phỏng remote tiến lên giữa lúc nộp (Một commit khác chèn vào) ---');
  const ticket2 = 'DESKTOP-CONCURRENT-R2-TEST-FI-02';

  // 1. Phía peer-repo: kéo mới nhất rồi chèn một commit độc lập lên origin/main
  execSync('git pull origin main', { cwd: peerRepoDir, stdio: 'pipe' });
  const peerFileRel = 'hop-thu/lan-desktop/ket-qua/PEER-SESSION-INDEPENDENT.md';
  fs.writeFileSync(path.join(peerRepoDir, peerFileRel), '# Phiên độc lập từ một worker khác chèn vào\n', 'utf-8');
  execSync('git add -A', { cwd: peerRepoDir });
  execSync('git commit -m "feat(peer): concurrent worker independent commit"', { cwd: peerRepoDir });
  execSync('git push origin main', { cwd: peerRepoDir });
  console.log('[CA 2] Peer worker đã đẩy 1 commit mới lên remote origin/main trước local.');

  // 2. Phía local-repo: chuẩn bị nộp vé ticket2 (lúc này local đang bị behind 1 commit)
  const regCa2 = JSON.parse(fs.readFileSync(process.env.AIOS_AUTH_REGISTRY, 'utf-8'));
  regCa2.push({
    ma_ve: ticket2,
    ma_hoi_thoai: 'conv-ca2',
    trang_thai: 'dang-chay',
    thoi_diem_tao: new Date().toISOString(),
    thoi_diem_dong: null,
    tep_ve: `${ticket2}.md`
  });
  fs.writeFileSync(process.env.AIOS_AUTH_REGISTRY, JSON.stringify(regCa2, null, 2), 'utf-8');

  const reportCa2 = path.join(laneKetQua, `${ticket2}.md`);
  fs.writeFileSync(reportCa2, `# BÁO CÁO NGHIỆM THU VÉ ${ticket2}\n- Trạng thái: Thành công\n`, 'utf-8');

  // Gọi commitAndPushWithRetry: phải tự phát hiện remote tiến lên, pull rebase và đẩy thành công
  const activeEntryCa2 = regCa2.find(r => r.ma_ve === ticket2);
  const closedTicketIdsCa2 = ['DESKTOP-EXISTING-CLOSED-01', ticket1];
  const sessionFilesCa2 = getAllowedFilesForTicket(activeEntryCa2, laneKetQua, localRepoDir, closedTicketIdsCa2);
  const submitResultCa2 = commitAndPushWithRetry(ticket2, sessionFilesCa2, regCa2, 4);

  assert.strictEqual(submitResultCa2.success, true, 'Ca 2: Phải phục hồi rebase và đẩy thành công');

  // Kiểm chứng trên remote: CẢ commit của peer VÀ commit của local đều tồn tại trên origin/main!
  const remoteTreeOutCa2 = execSync('git ls-tree -r --name-only origin/main', { cwd: localRepoDir, encoding: 'utf-8' });
  assert.strictEqual(remoteTreeOutCa2.includes('PEER-SESSION-INDEPENDENT.md'), true, 'Ca 2: Tệp của peer worker KHÔNG ĐƯỢC MẤT');
  assert.strictEqual(remoteTreeOutCa2.includes(`${ticket2}.md`), true, 'Ca 2: Tệp vé ticket2 phải tồn tại trên remote');

  console.log('✓ CA 2 ĐẠT: Phục hồi rebase tự động thành công khi remote tiến lên, không làm mất commit của phiên khác!\n');

  // -------------------------------------------------------------------
  // CA 3: MÔ PHỎNG ĐẨY THẤT BẠI KHÔNG PHỤC HỒI ĐƯỢC
  // -------------------------------------------------------------------
  console.log('--- CA 3: Mô phỏng đẩy thất bại không phục hồi được ---');
  const ticket3 = 'DESKTOP-FAIL-SIMULATION-TEST-FI-03';

  const regCa3 = JSON.parse(fs.readFileSync(process.env.AIOS_AUTH_REGISTRY, 'utf-8'));
  regCa3.push({
    ma_ve: ticket3,
    ma_hoi_thoai: 'conv-ca3',
    trang_thai: 'dang-chay',
    thoi_diem_tao: new Date().toISOString(),
    thoi_diem_dong: null,
    tep_ve: `${ticket3}.md`
  });
  fs.writeFileSync(process.env.AIOS_AUTH_REGISTRY, JSON.stringify(regCa3, null, 2), 'utf-8');

  // Tạo tệp báo cáo
  const reportCa3 = path.join(laneKetQua, `${ticket3}.md`);
  fs.writeFileSync(reportCa3, `# BÁO CÁO NGHIỆM THU VÉ ${ticket3}\n`, 'utf-8');

  // Mô phỏng đẩy thất bại bằng cách trỏ remote origin sang một URL không thể truy cập
  const originalOriginUrl = execSync('git remote get-url origin', { cwd: localRepoDir, encoding: 'utf-8' }).trim();
  execSync('git remote set-url origin "https://invalid-host-unreachable-dead-domain.local/repo.git"', { cwd: localRepoDir });

  console.log('[CA 3] Đã cấu hình remote không thể truy cập để mô phỏng sự cố mạng/kho...');

  const activeEntryCa3 = regCa3.find(r => r.ma_ve === ticket3);
  const closedTicketIdsCa3 = ['DESKTOP-EXISTING-CLOSED-01', ticket1, ticket2];
  const sessionFilesCa3 = getAllowedFilesForTicket(activeEntryCa3, laneKetQua, localRepoDir, closedTicketIdsCa3);
  const submitResultCa3 = commitAndPushWithRetry(ticket3, sessionFilesCa3, regCa3, 2);

  // Khôi phục URL origin ngay sau đó
  execSync(`git remote set-url origin "${originalOriginUrl}"`, { cwd: localRepoDir });

  // Kiểm tra 1: submitResultCa3 phải là thất bại
  assert.strictEqual(submitResultCa3.success, false, 'Ca 3: Nộp bài phải báo thất bại');

  // Kiểm tra 2: Trong registry-authoritative, vé TUYỆT ĐỐI KHÔNG được đánh dấu da-dong!
  const authAfterFail = JSON.parse(fs.readFileSync(process.env.AIOS_AUTH_REGISTRY, 'utf-8'));
  const failedEntryInAuth = authAfterFail.find(r => r.ma_ve === ticket3);
  assert.strictEqual(failedEntryInAuth.trang_thai, 'dang-chay', 'Ca 3: Trạng thái trong authoritative registry PHẢI giữ dang-chay!');

  // Kiểm tra 3: Tệp báo động trong thư mục làn PHẢI TỒN TẠI
  const laneAlarmFile = path.join(laneMailbox, `BAO-DONG-${ticket3}.md`);
  assert.strictEqual(fs.existsSync(laneAlarmFile), true, 'Ca 3: Tệp báo động trong làn BAO-DONG-<MA_VE>.md phải tồn tại');
  const laneAlarmContent = fs.readFileSync(laneAlarmFile, 'utf-8');
  console.log('[CA 3] Nội dung tệp báo động trong làn:\n' + laneAlarmContent.trim());
  assert.strictEqual(laneAlarmContent.includes(ticket3), true, 'Ca 3: Báo động làn phải ghi rõ mã vé');

  // Kiểm tra 4: Tệp báo động cục bộ cạnh picker PHẢI TỒN TẠI
  const localAlarmFile = path.join(sidecarConfigDir, `bao-dong-${ticket3}.json`);
  assert.strictEqual(fs.existsSync(localAlarmFile), true, 'Ca 3: Tệp báo động cục bộ bao-dong-<MA_VE>.json phải tồn tại');
  const localAlarmData = JSON.parse(fs.readFileSync(localAlarmFile, 'utf-8'));
  assert.strictEqual(localAlarmData.ma_ve, ticket3, 'Ca 3: Báo động cục bộ ghi đúng mã vé');
  console.log('[CA 3] Dữ liệu báo động cục bộ:\n', localAlarmData);

  console.log('✓ CA 3 ĐẠT: Đẩy thất bại không bị đóng vé giả; tệp báo động làn và cục bộ được tạo đầy đủ!\n');

} finally {
  // Dọn sạch 100% môi trường sandbox thử nghiệm
  try {
    delete process.env.AIOS_DIEU_PHOI_DIR;
    delete process.env.AIOS_MAILBOX_DIR;
    delete process.env.AIOS_KET_QUA_DIR;
    delete process.env.AIOS_PROMPTS_DIR;
    delete process.env.AIOS_REPO_REGISTRY;
    delete process.env.AIOS_LOG_FILE;
    delete process.env.AIOS_SIDECAR_DIR;
    delete process.env.AIOS_AUTH_REGISTRY;

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    console.log('[DỌN DẸP] Đã dọn sạch 100% môi trường sandbox thử nghiệm.');
  } catch (cleanErr) {
    console.log('[CẢNH BÁO DỌN DẸP]', cleanErr.message);
  }
}

console.log('\n================================================================');
console.log('TOÀN BỘ CÁC BÀI KIỂM THỬ VÀ 3 CA TIÊM LỖI ĐÃ ĐẠT 100% XANH!');
console.log('================================================================');
