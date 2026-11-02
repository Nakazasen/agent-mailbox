/**
 * test_watcher_standard.js
 * 
 * Bộ kiểm thử tự động toàn diện cho Module Thợ Canh Chuẩn Đa Làn (agent-mailbox-watcher-nudge)
 * 
 * Mục tiêu kiểm chứng:
 *  1. Chứng minh thêm 1 làn mới HOÀN TOÀN CHỈ BẰNG CẤU HÌNH JSON, KHÔNG SỬA CODE LÕI.
 *  2. Kiểm chứng đầy đủ 4 sự kiện quét tệp dự phòng:
 *     (a) dong-chua-day
 *     (b) hang-can (kèm trả nợ 1: ghi rõ "không tính chính nó" vào bộ đếm)
 *     (c) picker-im-lang
 *     (d) realqueue-worker-im-lang
 *  3. Kiểm chứng trả nợ 2: Bộ đếm tong_so_nudge_da_phat trong heartbeat đếm chính xác số tệp giục thực tế trên đĩa.
 *  4. Kiểm chứng bất biến cô lập: Một làn sập không kéo theo các làn khác.
 *  5. Kiểm chứng bất biến trạng thái: Không sửa đè registry hay tệp của thợ.
 *  6. MỞ RỘNG SUPABASE (Vé DESKTOP-HOME-WATCHER-SUPABASE-01):
 *     - Kiểm chứng hàng chờ Supabase trường hợp SẠCH (Clean State) -> Không kích hoạt giục sai (False Alarm).
 *     - Kiểm chứng Tín hiệu (a): Vé CLAIMED quá hạn lease mà chưa xong (Stuck State) -> Sinh tệp giục ve-claimed-qua-han-lease.
 *     - Kiểm chứng Tín hiệu (b): Hàng lỗi DLQ phình lên (Stuck State) -> Sinh tệp giục dlq-phinh-len.
 *     - Kiểm chứng Tín hiệu (c): Lệch trạng thái giữa bảng tickets và registry -> Sinh tệp giục lech-tickets-registry.
 *     - Kiểm chứng tính kiên cường & dự phòng tệp (Fallback Resilience) khi Supabase mất kết nối mạng.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const watcher = require('./watcher.js');
const { SupabaseQueueReader } = require('./supabase-reader.js');

console.log('======================================================================');
console.log('   BẮT ĐẦU BỘ KIỂM THỬ THỢ CANH CHUẨN ĐA LÀN (AGENT-MAILBOX V2.1.0)   ');
console.log('   Mở rộng 3 tín hiệu Supabase [DESKTOP-HOME-WATCHER-SUPABASE-01]     ');
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

async function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    await fn();
    console.log('PASSED (ĐẠT)');
    testResults.tests.push({ name, status: 'PASSED' });
  } catch (err) {
    console.log(`FAILED (THẤT BẠI): ${err.message}`);
    testResults.tests.push({ name, status: 'FAILED', error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Trình giả lập fetch PostgREST cho các kịch bản kiểm thử hàng chờ Supabase
 * @param {object} mockDb 
 * @returns {Function}
 */
function createMockFetch(mockDb) {
  return async function mockFetch(url, options = {}) {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const searchParams = parsed.searchParams;

    if (pathname.includes('/rest/v1/tickets')) {
      let data = [...(mockDb.tickets || [])];
      const stateParam = searchParams.get('state');
      if (stateParam && stateParam.startsWith('in.')) {
        const allowedStates = stateParam.slice(3).replace(/[()]/g, '').split(',');
        data = data.filter(t => allowedStates.includes(t.state));
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ date: new Date().toUTCString() }),
        json: async () => data,
        text: async () => JSON.stringify(data)
      };
    }

    if (pathname.includes('/rest/v1/ticket_dlq')) {
      let data = [...(mockDb.ticket_dlq || [])];
      const resolvedAtParam = searchParams.get('resolved_at');
      if (resolvedAtParam === 'is.null') {
        data = data.filter(r => r.resolved_at === null || r.resolved_at === undefined);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ date: new Date().toUTCString() }),
        json: async () => data,
        text: async () => JSON.stringify(data)
      };
    }

    return {
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found'
    };
  };
}

async function main() {
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
        heartbeat_interval_seconds: 60,
        supabase_url: 'https://mock.supabase.co',
        supabase_key: 'mock-anon-key-valid',
        lease_expired_threshold_seconds: 0,
        dlq_threshold: 0,
        check_discrepancy: true
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

    await runTest('1. Thêm làn mới chỉ bằng tệp cấu hình JSON (không đụng code lõi)', async () => {
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
    await runTest('2. Phát hiện sự kiện (a) dong-chua-day khi vé đóng local chưa có trên remote', async () => {
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
    await runTest('3. Phát hiện sự kiện (b) hang-can và TRẢ NỢ 1 (ghi rõ "không tính chính nó" vào bộ đếm)', async () => {
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
      const hasKhongTinhChinhNo = content.includes('Không tính chính nó') || content.includes('không tính chính nó');
      assert.ok(
        hasKhongTinhChinhNo,
        'BẮT BUỘC tệp giục hàng cạn phải ghi rõ "không tính chính nó" (tiến trình watcher) vào bộ đếm vé đang chạy!'
      );
      assert.ok(
        content.includes('Bộ đếm trạng thái hàng đợi chỉ tính các vé nghiệp vụ của thợ/agent'),
        'Phải có ghi chú xác thực phân quyền thợ và watcher'
      );
    });

    // =========================================================================
    // GIAI ĐOẠN 4: KIỂM CHỨNG SỰ KIỆN 3 - PICKER-IM-LANG
    // =========================================================================
    await runTest('4. Phát hiện sự kiện (c) picker-im-lang khi log hoặc tiến trình im lặng quá ngưỡng', async () => {
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
    await runTest('5. Giám sát sức khỏe Worker RealQueue và ghi nhận sự kiện (d) realqueue-worker-im-lang', async () => {
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
    await runTest('6. TRẢ NỢ 2: Bộ đếm tong_so_nudge_da_phat đếm chính xác số tệp giục trên đĩa', async () => {
      const currentFilesOnDisk = fs.readdirSync(simNudgesDir).filter(f => f.endsWith('.md')).length;
      assert.ok(currentFilesOnDisk >= 4, `Số tệp giục trên đĩa phải >= 4 (thực tế: ${currentFilesOnDisk})`);

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

      watcher.writeNudgeFile(resolvedConfig, 'hang-can', { totalClosed: 10 });
      watcher.writeNudgeFile(resolvedConfig, 'picker-im-lang', { silenceSeconds: 50 });

      const newFilesOnDisk = fs.readdirSync(simNudgesDir).filter(f => f.endsWith('.md')).length;
      assert.strictEqual(newFilesOnDisk, currentFilesOnDisk + 2);

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
    await runTest('7. Bất biến cách ly lỗi đa làn: Một làn gặp lỗi/sập KHÔNG kéo theo làn khác', async () => {
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

      const results = await watcher.scanAllLanes([brokenLaneConfig, resolvedConfig], {
        skipProcessCheck: true,
        forceNudge: false
      });

      assert.strictEqual(results.length, 2, 'Cả 2 làn đều phải được thực thi');

      const normalResult = results.find(r => r.lane_id === simLaneId);
      assert.ok(normalResult, 'Làn bình thường phải có kết quả quét');
      assert.ok(normalResult.heartbeat, 'Làn bình thường phải ghi được heartbeat');
      assert.strictEqual(normalResult.heartbeat.trang_thai, 'ALIVE');
    });

    // =========================================================================
    // GIAI ĐOẠN 8: KIỂM CHỨNG BẤT BIẾN TRẠNG THÁI (KHÔNG SỬA REGISTRY CỦA THỢ)
    // =========================================================================
    await runTest('8. Bất biến trạng thái: Watcher tuyệt đối KHÔNG sửa đè hay xóa registry của thợ', async () => {
      const origRegistry = fs.readFileSync(resolvedConfig.registry_file, 'utf-8');
      await watcher.scanLaneCycle(resolvedConfig, { skipProcessCheck: true });
      const postRegistry = fs.readFileSync(resolvedConfig.registry_file, 'utf-8');
      assert.strictEqual(origRegistry, postRegistry, 'Tệp registry.json của thợ phải giữ nguyên 100%');
    });

    // =========================================================================
    // GIAI ĐOẠN 9: KIỂM CHỨNG HÀNG CHỜ SUPABASE Ở TRẠNG THÁI SẠCH (CLEAN STATE)
    // CÓ KHẢ NĂNG FAIL: Nếu có lỗi kích hoạt sai, test sẽ ném AssertionError
    // =========================================================================
    await runTest('9. Hàng chờ Supabase trạng thái SẠCH (Clean State): Không sinh bất kỳ tệp giục Supabase nào', async () => {
      const cleanDb = {
        tickets: [
          {
            ticket_id: 'VE-SIM-CLEAN-01',
            trace_id: 'TRC-SIM-CLEAN-01',
            target_lane: simLaneId,
            state: 'QUEUED',
            priority: 3
          },
          {
            ticket_id: 'VE-SIM-CLEAN-02',
            trace_id: 'TRC-SIM-CLEAN-02',
            target_lane: simLaneId,
            state: 'CLAIMED',
            worker_id: 'home-worker-pid1234',
            claimed_at: new Date(Date.now() - 30000).toISOString(),
            lease_expires_at: new Date(Date.now() + 90000).toISOString(), // Còn hạn 90 giây!
            last_heartbeat_at: new Date(Date.now() - 10000).toISOString()
          },
          {
            ticket_id: 'VE-SIM-CLEAN-03',
            trace_id: 'TRC-SIM-CLEAN-03',
            target_lane: simLaneId,
            state: 'COMPLETED',
            completed_at: new Date(Date.now() - 60000).toISOString()
          }
        ],
        ticket_dlq: [] // Không có vé lỗi nào trong DLQ
      };

      // Đồng bộ registry đúng trạng thái: 02 đang chạy, 03 đã đóng
      const cleanRegistry = [
        { ma_ve: 'VE-SIM-CLEAN-02', trang_thai: 'dang-chay', thoi_diem_tao: new Date().toISOString() },
        { ma_ve: 'VE-SIM-CLEAN-03', trang_thai: 'da-dong', thoi_diem_tao: new Date().toISOString() }
      ];
      fs.writeFileSync(resolvedConfig.registry_file, JSON.stringify(cleanRegistry, null, 2), 'utf-8');

      const mockFetchClean = createMockFetch(cleanDb);
      const cycleRes = await watcher.scanLaneCycle(resolvedConfig, {
        fetchFn: mockFetchClean,
        skipProcessCheck: true,
        forceNudge: true
      });

      // Khẳng định không có bất kỳ sự kiện giục Supabase nào bị phát sai!
      assert.ok(!cycleRes.eventsDetected.includes('ve-claimed-qua-han-lease'), 'Hàng sạch: Không được giục vé hết hạn lease');
      assert.ok(!cycleRes.eventsDetected.includes('dlq-phinh-len'), 'Hàng sạch: Không được giục DLQ phình lên');
      assert.ok(!cycleRes.eventsDetected.includes('lech-tickets-registry'), 'Hàng sạch: Không được giục lệch tickets và registry');

      // Khẳng định bộ đếm thống kê heartbeat phản ánh đúng
      assert.strictEqual(cycleRes.heartbeat.thong_ke.realqueue_claimed_expired_count, 0);
      assert.strictEqual(cycleRes.heartbeat.thong_ke.realqueue_dlq_count, 0);
      assert.strictEqual(cycleRes.heartbeat.thong_ke.realqueue_discrepancy_count, 0);
    });

    // =========================================================================
    // GIAI ĐOẠN 10: TÍN HIỆU SUPABASE (a) - VÉ CLAIMED QUÁ HẠN LEASE MÀ CHƯA XONG
    // =========================================================================
    await runTest('10. TÍN HIỆU (a): Phát hiện vé CLAIMED quá hạn lease và sinh tệp giục ve-claimed-qua-han-lease', async () => {
      const expiredTicketId = 'VE-SIM-EXPIRED-LEASE-01';
      const expiredDb = {
        tickets: [
          {
            ticket_id: expiredTicketId,
            trace_id: 'TRC-SIM-EXPIRED-LEASE-01',
            target_lane: simLaneId,
            state: 'CLAIMED',
            worker_id: 'home-worker-hung-pid7777',
            claimed_at: new Date(Date.now() - 300000).toISOString(),
            lease_expires_at: new Date(Date.now() - 150000).toISOString(), // Đã hết hạn 150 giây trước!
            last_heartbeat_at: new Date(Date.now() - 250000).toISOString(),
            retry_count: 1
          },
          {
            ticket_id: 'VE-SIM-HEALTHY-01',
            trace_id: 'TRC-SIM-HEALTHY-01',
            target_lane: simLaneId,
            state: 'CLAIMED',
            worker_id: 'home-worker-pid1234',
            claimed_at: new Date(Date.now() - 20000).toISOString(),
            lease_expires_at: new Date(Date.now() + 100000).toISOString(), // Còn hạn
            last_heartbeat_at: new Date(Date.now() - 5000).toISOString(),
            retry_count: 0
          }
        ],
        ticket_dlq: []
      };

      const mockFetchExpired = createMockFetch(expiredDb);

      // 1. Kiểm thử trực tiếp hàm checkClaimedExpiredLeases
      const expiredList = await watcher.checkClaimedExpiredLeases(resolvedConfig, {
        fetchFn: mockFetchExpired
      });
      assert.strictEqual(expiredList.length, 1, 'Phải phát hiện chính xác 1 vé hết hạn');
      assert.strictEqual(expiredList[0].ticket_id, expiredTicketId);
      assert.ok(expiredList[0].expired_seconds >= 140, 'Thời gian quá hạn phải >= 140s');

      // 2. Chạy chu kỳ hoàn chỉnh và kiểm tra tệp giục được sinh ra
      const cycleRes = await watcher.scanLaneCycle(resolvedConfig, {
        fetchFn: mockFetchExpired,
        skipProcessCheck: true,
        forceNudge: true
      });

      assert.ok(cycleRes.eventsDetected.includes('ve-claimed-qua-han-lease'), 'Chu kỳ phải phát hiện sự kiện ve-claimed-qua-han-lease');

      // Kiểm tra tệp giục trên đĩa
      const targetNudge = cycleRes.nudgesCreated.find(n => n.filename.includes('ve-claimed-qua-han-lease'));
      assert.ok(targetNudge, `Tệp giục ve-claimed-qua-han-lease cho vé ${expiredTicketId} phải tồn tại`);
      assert.ok(fs.existsSync(targetNudge.absPath), `Tệp ${targetNudge.absPath} phải có trên đĩa`);

      const content = fs.readFileSync(targetNudge.absPath, 'utf-8');
      assert.ok(content.includes('ve-claimed-qua-han-lease'), 'Nội dung tệp giục phải có mã sự kiện');
      assert.ok(content.includes(expiredTicketId), 'Nội dung tệp giục phải có mã vé');
      assert.ok(content.includes('home-worker-hung-pid7777'), 'Nội dung tệp giục phải có worker ID');
      assert.ok(content.includes('reap_expired_leases'), 'Nội dung tệp giục phải có đề xuất reap_expired_leases');
    });

    // =========================================================================
    // GIAI ĐOẠN 11: TÍN HIỆU SUPABASE (b) - HÀNG LỖI DLQ PHÌNH LÊN
    // =========================================================================
    await runTest('11. TÍN HIỆU (b): Phát hiện hàng lỗi DLQ phình lên và sinh tệp giục dlq-phinh-len', async () => {
      const dlqDb = {
        tickets: [],
        ticket_dlq: [
          {
            dlq_id: 101,
            ticket_id: 'VE-SIM-DLQ-FAIL-01',
            trace_id: 'TRC-SIM-DLQ-01',
            failed_lane: simLaneId,
            total_retries: 4,
            final_error: 'Lỗi biên dịch SyntaxError trong mã nguồn',
            isolated_at: new Date(Date.now() - 60000).toISOString(),
            resolved_at: null
          },
          {
            dlq_id: 102,
            ticket_id: 'VE-SIM-DLQ-FAIL-02',
            trace_id: 'TRC-SIM-DLQ-02',
            failed_lane: simLaneId,
            total_retries: 4,
            final_error: 'Lỗi bộ nhớ Out of Memory heap exhausted',
            isolated_at: new Date(Date.now() - 30000).toISOString(),
            resolved_at: null
          }
        ]
      };

      const mockFetchDlq = createMockFetch(dlqDb);

      // 1. Kiểm tra trực tiếp hàm checkDlqStatus
      const dlqStatus = await watcher.checkDlqStatus(resolvedConfig, {
        fetchFn: mockFetchDlq,
        dlqThreshold: 0
      });
      assert.strictEqual(dlqStatus.isSwelling, true, 'DLQ phải được đánh dấu là phình lên');
      assert.strictEqual(dlqStatus.dlqCount, 2, 'Số lượng vé DLQ phải là 2');

      // 2. Chạy chu kỳ hoàn chỉnh và kiểm tra tệp giục
      const cycleRes = await watcher.scanLaneCycle(resolvedConfig, {
        fetchFn: mockFetchDlq,
        skipProcessCheck: true,
        forceNudge: true
      });

      assert.ok(cycleRes.eventsDetected.includes('dlq-phinh-len'), 'Chu kỳ phải phát hiện sự kiện dlq-phinh-len');

      const targetNudge = cycleRes.nudgesCreated.find(n => n.filename.includes('dlq-phinh-len'));
      assert.ok(targetNudge, 'Tệp giục dlq-phinh-len phải tồn tại trong nudgesCreated');
      assert.ok(fs.existsSync(targetNudge.absPath), 'Tệp giục dlq-phinh-len phải tồn tại trên đĩa');

      const content = fs.readFileSync(targetNudge.absPath, 'utf-8');
      assert.ok(content.includes('dlq-phinh-len'), 'Nội dung tệp giục phải có mã sự kiện');
      assert.ok(content.includes('VE-SIM-DLQ-FAIL-01'), 'Phải liệt kê vé lỗi 01');
      assert.ok(content.includes('VE-SIM-DLQ-FAIL-02'), 'Phải liệt kê vé lỗi 02');
      assert.ok(content.includes('Lỗi biên dịch SyntaxError'), 'Phải có chi tiết final_error');
    });

    // =========================================================================
    // GIAI ĐOẠN 12: TÍN HIỆU SUPABASE (c) - LỆCH GIỮA BẢNG TICKETS VÀ REGISTRY
    // =========================================================================
    await runTest('12. TÍN HIỆU (c): Phát hiện sai lệch giữa bảng tickets và registry.json sinh tệp giục lech-tickets-registry', async () => {
      const driftDb = {
        tickets: [
          // Lệch 1: Supabase CLAIMED nhưng không có trong registry
          {
            ticket_id: 'VE-SIM-DRIFT-MISSING-REG',
            trace_id: 'TRC-SIM-DRIFT-01',
            target_lane: simLaneId,
            state: 'CLAIMED'
          },
          // Lệch 2: Supabase COMPLETED nhưng registry vẫn ghi dang-chay
          {
            ticket_id: 'VE-SIM-DRIFT-STUCK-REG',
            trace_id: 'TRC-SIM-DRIFT-02',
            target_lane: simLaneId,
            state: 'COMPLETED'
          },
          // Lệch 3: Registry đã da-dong nhưng Supabase vẫn CLAIMED
          {
            ticket_id: 'VE-SIM-DRIFT-UNCOMPLETED-DB',
            trace_id: 'TRC-SIM-DRIFT-03',
            target_lane: simLaneId,
            state: 'CLAIMED'
          }
        ],
        ticket_dlq: []
      };

      const driftRegistry = [
        { ma_ve: 'VE-SIM-DRIFT-STUCK-REG', trang_thai: 'dang-chay', thoi_diem_tao: new Date().toISOString() },
        { ma_ve: 'VE-SIM-DRIFT-UNCOMPLETED-DB', trang_thai: 'da-dong', thoi_diem_tao: new Date().toISOString() }
      ];
      fs.writeFileSync(resolvedConfig.registry_file, JSON.stringify(driftRegistry, null, 2), 'utf-8');

      const mockFetchDrift = createMockFetch(driftDb);

      // 1. Kiểm tra trực tiếp hàm checkTicketsRegistryDiscrepancy
      const discResult = await watcher.checkTicketsRegistryDiscrepancy(resolvedConfig, {
        fetchFn: mockFetchDrift
      });
      assert.strictEqual(discResult.hasDiscrepancy, true, 'Phải phát hiện sai lệch');
      assert.strictEqual(discResult.discrepancyCount, 3, 'Phải phát hiện đủ 3 loại sai lệch');

      // 2. Chạy chu kỳ hoàn chỉnh và kiểm tra tệp giục
      const cycleRes = await watcher.scanLaneCycle(resolvedConfig, {
        fetchFn: mockFetchDrift,
        skipProcessCheck: true,
        forceNudge: true
      });

      assert.ok(cycleRes.eventsDetected.includes('lech-tickets-registry'), 'Chu kỳ phải phát hiện sự kiện lech-tickets-registry');

      const targetNudge = cycleRes.nudgesCreated.find(n => n.filename.includes('lech-tickets-registry'));
      assert.ok(targetNudge, 'Tệp giục lech-tickets-registry phải có trong nudgesCreated');
      assert.ok(fs.existsSync(targetNudge.absPath), 'Tệp giục lech-tickets-registry phải tồn tại trên đĩa');

      const content = fs.readFileSync(targetNudge.absPath, 'utf-8');
      assert.ok(content.includes('lech-tickets-registry'), 'Nội dung tệp giục phải có mã sự kiện');
      assert.ok(content.includes('VE-SIM-DRIFT-MISSING-REG'), 'Phải có vé lệch 1');
      assert.ok(content.includes('VE-SIM-DRIFT-STUCK-REG'), 'Phải có vé lệch 2');
      assert.ok(content.includes('VE-SIM-DRIFT-UNCOMPLETED-DB'), 'Phải có vé lệch 3');
      assert.ok(content.includes('CLAIMED_MISSING_IN_REGISTRY'), 'Phải có phân loại sai lệch 1');
    });

    // =========================================================================
    // GIAI ĐOẠN 13: BẤT BIẾN DỰ PHÒNG TỆP KHI SUPABASE MẤT KẾT NỐI MẠNG
    // =========================================================================
    await runTest('13. Bất biến dự phòng tệp khi Supabase mất kết nối mạng (Resilience & File Fallback)', async () => {
      // Giả lập kết nối mạng tới Supabase bị đứt hoàn toàn (ECONNREFUSED)
      const brokenFetch = async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
      };

      // Đặt một vé đóng cục bộ chưa đẩy để kiểm chứng luồng quét tệp dự phòng vẫn chạy
      const unpushedId = 'VE-SIM-FALLBACK-UNPUSHED-01';
      const regFallback = [
        {
          ma_ve: unpushedId,
          trang_thai: 'da-dong',
          thoi_diem_tao: new Date(Date.now() - 200000).toISOString(),
          thoi_diem_dong: new Date(Date.now() - 100000).toISOString(),
          tep_ve: `${unpushedId}.md`
        }
      ];
      fs.writeFileSync(resolvedConfig.registry_file, JSON.stringify(regFallback, null, 2), 'utf-8');
      fs.writeFileSync(path.join(simKetQuaDir, `${unpushedId}.md`), '# Report Fallback\n', 'utf-8');

      // Chạy chu kỳ: Thợ canh KHÔNG ĐƯỢC CRASH dù Supabase sập
      const cycleRes = await watcher.scanLaneCycle(resolvedConfig, {
        fetchFn: brokenFetch,
        skipProcessCheck: true,
        ignoreGracePeriod: true,
        forceNudge: true
      });

      // Kiểm tra: Bộ đếm lỗi kết nối tăng lên
      const runtimeState = watcher.getLaneRuntimeState(resolvedConfig.lane_id);
      assert.ok(runtimeState.totalRealqueueConnectionErrors >= 1, 'Phải ghi nhận lỗi kết nối Supabase vào runtime state');

      // Kiểm tra: Tuyến dự phòng tệp vẫn phát hiện được vé chưa đẩy
      assert.ok(cycleRes.eventsDetected.includes('dong-chua-day'), 'Tuyến dự phòng tệp vẫn phải phát hiện vé chưa đẩy');
      assert.ok(cycleRes.heartbeat, 'Heartbeat vẫn phải được ghi nhận đầy đủ');
      assert.strictEqual(cycleRes.heartbeat.trang_thai, 'ALIVE');
    });

    console.log('\n======================================================================');
    console.log('   KẾT QUẢ: TOÀN BỘ 13/13 BÀI TEST CHUẨN ĐẠT 100% (ALL TESTS PASSED)   ');
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
}

main().catch(err => {
  console.error('\n[CHẾT KIỂM THỬ]:', err);
  process.exit(1);
});
