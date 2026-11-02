/**
 * test_watcher_standard.js
 * 
 * Bộ kiểm thử tự động toàn diện cho Module Thợ Canh Chuẩn Đa Làn (agent-mailbox-watcher-nudge)
 * 
 * Mục tiêu kiểm chứng:
 *  1. Chứng minh thêm 1 làn mới HOÀN TOÀN CHỈ BẰNG CẤU HÌNH JSON, KHÔNG SỬA CODE LÕI.
 *  2. Kiểm chứng đầy đủ 4 sự kiện:
 *     (a) dong-chua-day
 *     (b) hang-can (kèm trả nợ 1: ghi rõ "không tính chính nó" vào bộ đếm)
 *     (c) picker-im-lang
 *     (d) realqueue-worker-im-lang
 *  3. Kiểm chứng trả nợ 2: Bộ đếm tong_so_nudge_da_phat trong heartbeat đếm chính xác số tệp giục thực tế trên đĩa.
 *  4. Kiểm chứng bất biến cô lập: Một làn sập không kéo theo các làn khác.
 *  5. Kiểm chứng bất biến trạng thái: Không sửa đè registry hay tệp của thợ.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const watcher = require('./watcher.js');

console.log('======================================================================');
console.log('   BẮT ĐẦU BỘ KIỂM THỬ THỢ CANH CHUẨN ĐA LÀN (AGENT-MAILBOX V2.0.0)   ');
console.log('======================================================================\n');

const testRunId = `test-lane-sim-${Date.now()}`;
const tempBaseDir = path.resolve(__dirname, '..', '..', 'khung-state', 'test-runs', testRunId);

if (!fs.existsSync(tempBaseDir)) {
  fs.mkdirSync(tempBaseDir, { recursive: true });
}

const testResults = {
  startedAt: new Date().toISOString(),
  testRunId,
  tests: []
};

function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    fn();
    console.log('PASSED (ĐẠT)');
    testResults.tests.push({ name, status: 'PASSED' });
  } catch (err) {
    console.log(`FAILED (THẤT BẠI): ${err.message}`);
    testResults.tests.push({ name, status: 'FAILED', error: err.message, stack: err.stack });
    throw err;
  }
}

try {
  // =========================================================================
  // GIAI ĐOẠN 1: THÊM LÀN MỚI CHỈ BẰNG TỆP CẤU HÌNH JSON
  // =========================================================================
  const simLaneId = 'sim-project-x';
  const simMailboxDir = path.join(tempBaseDir, 'hop-thu', simLaneId);
  const simNudgesDir = path.join(simMailboxDir, 'nudges');
  const simHeartbeatsDir = path.join(simMailboxDir, 'heartbeats');
  const simKetQuaDir = path.join(simMailboxDir, 'ket-qua');
  const simStateDir = path.join(tempBaseDir, 'state', simLaneId);
  const simConfigFile = path.join(tempBaseDir, `${simLaneId}.lane.json`);

  const simConfigJson = {
    lane_id: simLaneId,
    lane_name: 'Simulated Project X Lane',
    repo_dir: path.resolve(__dirname, '..', '..'),
    mailbox_dir: simMailboxDir,
    nudges_dir: simNudgesDir,
    heartbeats_dir: simHeartbeatsDir,
    heartbeat_file: path.join(simHeartbeatsDir, `heartbeat-${simLaneId}-watcher.json`),
    ket_qua_dir: simKetQuaDir,
    prompts_dir: simMailboxDir,
    registry_file: path.join(simMailboxDir, 'registry.json'),
    picker_log_file: path.join(simMailboxDir, 'picker.log'),
    picker_process_pattern: '*picker.js*',
    cycle_seconds: 60,
    silence_threshold_seconds: 10,
    cooldown_seconds: 5,
    realqueue: {
      enabled: true,
      worker_process_pattern: '*picker-realqueue*',
      log_file: path.join(simMailboxDir, 'picker-realqueue.log'),
      heartbeat_file: path.join(simHeartbeatsDir, 'heartbeat-realqueue-worker.json'),
      silence_threshold_seconds: 15,
      heartbeat_interval_seconds: 60
    },
    git: {
      remote: 'origin',
      branch: 'main',
      enable_self_rescue: false // Không đẩy git thật trong test case giả lập
    },
    state_dir: simStateDir
  };

  fs.writeFileSync(simConfigFile, JSON.stringify(simConfigJson, null, 2), 'utf-8');

  let resolvedConfig = null;

  runTest('1. Thêm làn mới chỉ bằng tệp cấu hình JSON (không đụng code lõi)', () => {
    resolvedConfig = watcher.loadLaneConfigFile(simConfigFile);
    assert.strictEqual(resolvedConfig.lane_id, simLaneId);
    assert.strictEqual(resolvedConfig.mailbox_dir, simMailboxDir);
    assert.strictEqual(resolvedConfig.realqueue.enabled, true);
    watcher.ensureLaneDirs(resolvedConfig);
    assert.ok(fs.existsSync(simMailboxDir), 'Thư mục mailbox_dir phải được tự tạo');
    assert.ok(fs.existsSync(simNudgesDir), 'Thư mục nudges_dir phải được tự tạo');
    assert.ok(fs.existsSync(simHeartbeatsDir), 'Thư mục heartbeats_dir phải được tự tạo');
    assert.ok(fs.existsSync(simKetQuaDir), 'Thư mục ket_qua_dir phải được tự tạo');
    assert.ok(fs.existsSync(simStateDir), 'Thư mục state_dir phải được tự tạo');
  });

  // =========================================================================
  // GIAI ĐOẠN 2: KIỂM CHỨNG SỰ KIỆN 1 - DONG-CHUA-DAY
  // =========================================================================
  runTest('2. Phát hiện sự kiện (a) dong-chua-day khi vé đóng local chưa có trên remote', () => {
    const testTicketId = 'VE-SIM-DONG-CHUA-DAY-01';
    const registryData = [
      {
        ma_ve: testTicketId,
        trang_thai: 'da-dong',
        thoi_diem_tao: new Date(Date.now() - 300000).toISOString(),
        thoi_diem_dong: new Date(Date.now() - 120000).toISOString(),
        tep_ve: `${testTicketId}.md`
      }
    ];
    fs.writeFileSync(resolvedConfig.registry_file, JSON.stringify(registryData, null, 2), 'utf-8');

    // Tạo tệp kết quả trên local
    const localReport = path.join(simKetQuaDir, `${testTicketId}.md`);
    fs.writeFileSync(localReport, `# Báo cáo ${testTicketId}\nTrạng thái: Hoàn thành local\n`, 'utf-8');

    const unpushed = watcher.checkUnpushedTickets(resolvedConfig, { ignoreGracePeriod: true });
    assert.ok(unpushed.length > 0, 'Phải phát hiện ít nhất 1 vé chưa đẩy');
    assert.strictEqual(unpushed[0].ma_ve, testTicketId);

    const nudge = watcher.writeNudgeFile(resolvedConfig, 'dong-chua-day', unpushed[0]);
    assert.ok(fs.existsSync(nudge.absPath), 'Tệp giục phải tồn tại trên đĩa');
    const nudgeContent = fs.readFileSync(nudge.absPath, 'utf-8');
    assert.ok(nudgeContent.includes(testTicketId), 'Tệp giục phải chứa mã vé');
    assert.ok(nudgeContent.includes('dong-chua-day'), 'Tệp giục phải chứa mã sự kiện');
  });

  // =========================================================================
  // GIAI ĐOẠN 3: KIỂM CHỨNG SỰ KIỆN 2 - HANG-CAN & TRẢ NỢ 1 ("KHÔNG TÍNH CHÍNH NÓ")
  // =========================================================================
  runTest('3. Phát hiện sự kiện (b) hang-can và TRẢ NỢ 1 (ghi rõ "không tính chính nó" vào bộ đếm)', () => {
    // Đặt registry không còn vé nào đang chạy hoặc chờ slot
    const registryData = [
      {
        ma_ve: 'VE-SIM-DA-XONG-01',
        trang_thai: 'da-dong',
        thoi_diem_tao: new Date(Date.now() - 400000).toISOString(),
        thoi_diem_dong: new Date(Date.now() - 200000).toISOString()
      }
    ];
    fs.writeFileSync(resolvedConfig.registry_file, JSON.stringify(registryData, null, 2), 'utf-8');

    const queueStatus = watcher.checkQueueStatus(resolvedConfig);
    assert.strictEqual(queueStatus.activeCount, 0, 'activeCount phải bằng 0');
    assert.strictEqual(queueStatus.queuedCount, 0, 'queuedCount phải bằng 0');
    assert.strictEqual(queueStatus.pendingNewTickets, 0, 'pendingNewTickets phải bằng 0');
    assert.strictEqual(queueStatus.isDry, true, 'Hàng đợi phải được đánh dấu là cạn (isDry: true)');

    const nudge = watcher.writeNudgeFile(resolvedConfig, 'hang-can', queueStatus);
    assert.ok(fs.existsSync(nudge.absPath), 'Tệp giục hàng cạn phải tồn tại');

    const content = fs.readFileSync(nudge.absPath, 'utf-8');

    // KIỂM CHỨNG NỢ 1: Bắt buộc phải có câu "Không tính chính nó" trong bộ đếm
    const hasKhongTinhChinhNo = content.includes('Không tính chính nó') || content.includes('không tính chính nó');
    assert.ok(
      hasKhongTinhChinhNo,
      'BẮT BUỘC tệp giục hàng cạn phải ghi rõ "không tính chính nó" (tiến trình watcher) vào bộ đếm vé đang chạy!'
    );

    // Kiểm tra ghi chú xác thực
    assert.ok(
      content.includes('Bộ đếm trạng thái hàng đợi chỉ tính các vé nghiệp vụ của thợ/agent'),
      'Phải có ghi chú xác thực phân quyền thợ và watcher'
    );
  });

  // =========================================================================
  // GIAI ĐOẠN 4: KIỂM CHỨNG SỰ KIỆN 3 - PICKER-IM-LANG
  // =========================================================================
  runTest('4. Phát hiện sự kiện (c) picker-im-lang khi log hoặc tiến trình im lặng quá ngưỡng', () => {
    // Ghi một log cũ cách đây 60 giây (ngưỡng test đặt là 10 giây)
    const oldTime = new Date(Date.now() - 60000);
    fs.writeFileSync(resolvedConfig.picker_log_file, '[2026-11-02T12:00:00.000Z] Log cu\n', 'utf-8');
    fs.utimesSync(resolvedConfig.picker_log_file, oldTime, oldTime);

    const pickerHealth = watcher.checkPickerHealth(resolvedConfig, { skipProcessCheck: true });
    assert.strictEqual(pickerHealth.isSilent, true, 'Picker phải được nhận diện là im lặng (isSilent: true)');
    assert.ok(pickerHealth.silenceSeconds >= 10, 'Tuổi log phải vượt ngưỡng 10s');

    const nudge = watcher.writeNudgeFile(resolvedConfig, 'picker-im-lang', pickerHealth);
    assert.ok(fs.existsSync(nudge.absPath), 'Tệp giục picker im lặng phải được tạo');
    const content = fs.readFileSync(nudge.absPath, 'utf-8');
    assert.ok(content.includes('picker-im-lang'), 'Nội dung tệp giục phải có mã sự kiện');
  });

  // =========================================================================
  // GIAI ĐOẠN 5: KIỂM CHỨNG SỰ KIỆN 4 - REALQUEUE-WORKER-IM-LANG & HEARTBEAT
  // =========================================================================
  runTest('5. Giám sát sức khỏe Worker RealQueue và ghi nhận sự kiện (d) realqueue-worker-im-lang', () => {
    const oldRqTime = new Date(Date.now() - 80000);
    const rqLogContent = `
[2026-11-02T12:00:00.000Z] [REALQUEUE-WORKER] Worker ID: PC-PID9999 khởi động
[2026-11-02T12:00:01.000Z] [REALQUEUE-WORKER] Lỗi kết nối Supabase: fetch failed ECONNREFUSED
[2026-11-02T12:00:02.000Z] [REALQUEUE-WORKER] Cảnh báo: lệch registry mirror mismatch
`;
    fs.writeFileSync(resolvedConfig.realqueue.log_file, rqLogContent.trim(), 'utf-8');
    fs.utimesSync(resolvedConfig.realqueue.log_file, oldRqTime, oldRqTime);

    const rqHealth = watcher.checkRealqueueHealth(resolvedConfig, { skipProcessCheck: true });
    assert.strictEqual(rqHealth.enabled, true);
    assert.strictEqual(rqHealth.isSilent, true);
    assert.strictEqual(rqHealth.processId, 9999);
    assert.ok(rqHealth.connectionErrorsCount >= 1, 'Phải phát hiện lỗi kết nối');
    assert.ok(rqHealth.mirrorDiscrepancyCount >= 1, 'Phải phát hiện lệch mirror');

    const rqNudge = watcher.writeNudgeFile(resolvedConfig, 'realqueue-worker-im-lang', rqHealth);
    assert.ok(fs.existsSync(rqNudge.absPath), 'Tệp giục worker RealQueue im lặng phải được tạo');

    const rqHeartbeat = watcher.writeRealqueueHeartbeat(resolvedConfig, rqHealth);
    assert.ok(fs.existsSync(resolvedConfig.realqueue.heartbeat_file), 'Tệp heartbeat RealQueue phải tồn tại');
    assert.strictEqual(rqHeartbeat.pid, 9999);
    assert.strictEqual(rqHeartbeat.worker_song_chet, 'CHET');
  });

  // =========================================================================
  // GIAI ĐOẠN 6: KIỂM CHỨNG TRẢ NỢ 2 - SỬA BỘ ĐẾM TONG_SO_NUDGE_DA_PHAT
  // =========================================================================
  runTest('6. TRẢ NỢ 2: Bộ đếm tong_so_nudge_da_phat đếm chính xác số tệp giục trên đĩa', () => {
    // Đếm số tệp giục hiện có trong thư mục nudges của làn
    const currentFilesOnDisk = fs.readdirSync(simNudgesDir).filter(f => f.endsWith('.md')).length;
    assert.ok(currentFilesOnDisk >= 4, `Số tệp giục trên đĩa phải >= 4 (thực tế: ${currentFilesOnDisk})`);

    // Ghi heartbeat và đọc lại
    const hb1 = watcher.writeHeartbeat(resolvedConfig, {
      totalRegistry: 1,
      activeCount: 0,
      queuedCount: 0,
      pendingNewTickets: 0
    });

    assert.strictEqual(
      hb1.thong_ke.tong_so_nudge_da_phat,
      currentFilesOnDisk,
      `tong_so_nudge_da_phat (${hb1.thong_ke.tong_so_nudge_da_phat}) phải bằng đúng số tệp giục trên đĩa (${currentFilesOnDisk})`
    );

    // Mô phỏng tạo thêm 2 tệp giục nữa
    watcher.writeNudgeFile(resolvedConfig, 'hang-can', { totalClosed: 10 });
    watcher.writeNudgeFile(resolvedConfig, 'picker-im-lang', { silenceSeconds: 50 });

    const newFilesOnDisk = fs.readdirSync(simNudgesDir).filter(f => f.endsWith('.md')).length;
    assert.strictEqual(newFilesOnDisk, currentFilesOnDisk + 2);

    // Giả lập watcher bị tắt và bật lại (khởi động lại process) -> gọi writeHeartbeat trong phiên mới
    const hb2 = watcher.writeHeartbeat(resolvedConfig, {
      totalRegistry: 1,
      activeCount: 0,
      queuedCount: 0,
      pendingNewTickets: 0
    });

    assert.strictEqual(
      hb2.thong_ke.tong_so_nudge_da_phat,
      newFilesOnDisk,
      `Sau khi restart, tong_so_nudge_da_phat (${hb2.thong_ke.tong_so_nudge_da_phat}) vẫn phải bằng chính xác số tệp trên đĩa (${newFilesOnDisk}), không được reset về 0!`
    );
  });

  // =========================================================================
  // GIAI ĐOẠN 7: KIỂM CHỨNG BẤT BIẾN CÁCH LY LỖI ĐA LÀN
  // =========================================================================
  runTest('7. Bất biến cách ly lỗi đa làn: Một làn gặp lỗi/sập KHÔNG kéo theo làn khác', () => {
    // Tạo cấu hình Làn Lỗi (Broken Lane) với đường dẫn hỏng
    const brokenLaneConfig = {
      lane_id: 'lane-broken-test',
      lane_name: 'Broken Lane',
      repo_dir: path.resolve(__dirname, '..', '..'),
      mailbox_dir: 'C:/NonExistentPath_TestBroken/InvalidDir',
      nudges_dir: 'C:/NonExistentPath_TestBroken/InvalidDir/nudges',
      heartbeats_dir: 'C:/NonExistentPath_TestBroken/InvalidDir/heartbeats',
      heartbeat_file: 'C:/NonExistentPath_TestBroken/InvalidDir/heartbeat.json',
      ket_qua_dir: 'C:/NonExistentPath_TestBroken/InvalidDir/ket-qua',
      registry_file: 'C:/NonExistentPath_TestBroken/InvalidDir/registry.json',
      picker_log_file: 'C:/NonExistentPath_TestBroken/InvalidDir/picker.log',
      picker_process_pattern: '*nonexistent*',
      cycle_seconds: 60,
      silence_threshold_seconds: 10,
      cooldown_seconds: 5,
      git: { remote: 'origin', branch: 'main', enable_self_rescue: false }
    };

    // Chạy đồng thời cả 2 làn qua scanAllLanes
    const results = watcher.scanAllLanes([brokenLaneConfig, resolvedConfig], {
      skipProcessCheck: true,
      forceNudge: false
    });

    assert.strictEqual(results.length, 2, 'Cả 2 làn đều phải được thực thi');

    // Làn khỏe mạnh (resolvedConfig) vẫn phải hoàn tất chu kỳ trơn tru
    const normalResult = results.find(r => r.lane_id === simLaneId);
    assert.ok(normalResult, 'Làn bình thường phải có kết quả quét');
    assert.ok(normalResult.heartbeat, 'Làn bình thường phải ghi được heartbeat');
    assert.strictEqual(normalResult.heartbeat.trang_thai, 'ALIVE');
  });

  // =========================================================================
  // GIAI ĐOẠN 8: KIỂM CHỨNG BẤT BIẾN TRẠNG THÁI (KHÔNG SỬA REGISTRY CỦA THỢ)
  // =========================================================================
  runTest('8. Bất biến trạng thái: Watcher tuyệt đối KHÔNG sửa đè hay xóa registry của thợ', () => {
    const origRegistry = fs.readFileSync(resolvedConfig.registry_file, 'utf-8');
    watcher.scanLaneCycle(resolvedConfig, { skipProcessCheck: true });
    const postRegistry = fs.readFileSync(resolvedConfig.registry_file, 'utf-8');
    assert.strictEqual(origRegistry, postRegistry, 'Tệp registry.json của thợ phải giữ nguyên 100%');
  });

  console.log('\n======================================================================');
  console.log('   KẾT QUẢ: TOÀN BỘ 8/8 BÀI TEST CHUẨN ĐẠT 100% (ALL TESTS PASSED)   ');
  console.log('======================================================================\n');
  testResults.status = 'ALL_PASSED';
  testResults.completedAt = new Date().toISOString();
} finally {
  // Dọn dẹp an toàn thư mục kiểm thử tạm
  try {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  } catch (e) {}
}

const reportPath = path.join(__dirname, 'test_standard_results.json');
fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2), 'utf-8');
console.log(`Đã lưu kết quả kiểm thử vào: ${reportPath}`);
