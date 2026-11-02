/**
 * watcher.js — Module thợ canh chuẩn dùng chung cho đa làn (Multi-Lane Standard Watcher-Nudge)
 * Repository: Nakazasen/agent-mailbox
 * 
 * Tách từ thợ canh máy nhà (aios-dieu-phoi-desktop/sidecar/watcher-nudge/).
 * Chuẩn hóa để mọi dự án/máy trạm (PC0575, máy nhà, làn mới) chỉ cần thêm tệp cấu hình JSON là chạy.
 *
 * Các tính năng chuẩn:
 *  1. Đa làn độc lập (Multi-lane isolation): 1 làn lỗi không kéo sập các làn khác.
 *  2. Bất biến kiến trúc: state/registry chống trùng nằm NGOÀI cây git; không sửa tệp trạng thái của thợ.
 *  3. Bốn sự kiện phát hiện và giục:
 *     (a) dong-chua-day: Vé đã đóng local nhưng chưa có trên kho origin/main.
 *     (b) hang-can: Không còn vé nào đang chạy hoặc chờ slot trong làn.
 *         -> ĐÃ TRẢ NỢ: Ghi rõ ràng "không tính chính nó" vào bộ đếm vé đang chạy.
 *     (c) picker-im-lang: Tiến trình picker/log im lặng bất thường vượt ngưỡng.
 *     (d) realqueue-worker-im-lang: Worker bóng Real Queue chết hoặc im lặng > ngưỡng.
 *  4. Tự cứu hẹp an toàn (Narrow self-rescue):
 *     Fetch + rebase --autostash + push thường. Dừng ngay khi có xung đột, cấm force push.
 *  5. Heartbeat định kỳ:
 *     -> ĐÃ TRẢ NỢ: Sửa bộ đếm tong_so_nudge_da_phat đếm chính xác số tệp giục thực tế trên đĩa,
 *        không bị lệch hay reset về 0 khi khởi động lại tiến trình.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { SupabaseQueueReader } = require('./supabase-reader.js');

// =============================================================================
// 1. Quản lý Trạng thái Bộ nhớ & Hạn mức / Quota theo từng Làn
// =============================================================================
const laneRuntimeStates = new Map(); // lane_id -> state object

/**
 * Lấy hoặc khởi tạo trạng thái runtime cho một làn cụ thể
 * @param {string} laneId 
 * @returns {object}
 */
function getLaneRuntimeState(laneId) {
  if (!laneRuntimeStates.has(laneId)) {
    laneRuntimeStates.set(laneId, {
      lastNudgeTime: {}, // eventType -> timestamp ms
      lastHeartbeatTime: 0,
      lastRealqueueHeartbeatTime: 0,
      totalRealqueueConnectionErrors: 0,
      lastRealqueueDiscrepancyCount: 0,
      lastDlqCount: 0,
      totalRuns: 0
    });
  }
  return laneRuntimeStates.get(laneId);
}

// =============================================================================
// 2. Định dạng Thời gian & Tiện ích Hỗ trợ
// =============================================================================
function getVietnamTime(date = new Date()) {
  const d = new Date(date);
  const offset = 7 * 60; // UTC+7 in minutes
  const local = new Date(d.getTime() + (offset + d.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = local.getFullYear();
  const MM = pad(local.getMonth() + 1);
  const dd = pad(local.getDate());
  const HH = pad(local.getHours());
  const mm = pad(local.getMinutes());
  const ss = pad(local.getSeconds());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss} +07:00`;
}

function getTimestampSlug(date = new Date()) {
  const d = new Date(date);
  const offset = 7 * 60;
  const local = new Date(d.getTime() + (offset + d.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = local.getFullYear();
  const MM = pad(local.getMonth() + 1);
  const dd = pad(local.getDate());
  const HH = pad(local.getHours());
  const mm = pad(local.getMinutes());
  const ss = pad(local.getSeconds());
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

function log(laneConfig, msg) {
  const ts = new Date().toISOString();
  const lanePrefix = laneConfig && laneConfig.lane_id ? `[${laneConfig.lane_id.toUpperCase()}]` : '[WATCHER]';
  const line = `[${ts}] ${lanePrefix} ${msg}`;
  console.log(line);
  if (laneConfig && laneConfig.log_file) {
    try {
      const dir = path.dirname(laneConfig.log_file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(laneConfig.log_file, line + '\n', 'utf-8');
    } catch (e) {}
  }
}

/**
 * Đếm chính xác số lượng tệp giục (.md) thực tế đang có trong thư mục nudges.
 * Cải tiến trả nợ: Giúp chỉ số tong_so_nudge_da_phat luôn đúng tuyệt đối.
 * @param {string} nudgesDir 
 * @returns {number}
 */
function countDispatchedNudges(nudgesDir) {
  if (!nudgesDir || !fs.existsSync(nudgesDir)) {
    return 0;
  }
  try {
    const files = fs.readdirSync(nudgesDir);
    return files.filter(f => f.endsWith('.md')).length;
  } catch (e) {
    return 0;
  }
}

// =============================================================================
// 3. Chuẩn hóa & Nạp Cấu hình Làn (Resolve Lane Configuration)
// =============================================================================
/**
 * Chuẩn hóa cấu hình của một làn, tính toán toàn bộ đường dẫn tuyệt đối
 * @param {object} rawConfig 
 * @param {string} configFilePath
 * @returns {object}
 */
function resolveLaneConfig(rawConfig, configFilePath = null) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Cấu hình làn không hợp lệ (phải là một JSON object).');
  }

  const lane_id = rawConfig.lane_id || rawConfig.id || 'lan-mac-dinh';
  const lane_name = rawConfig.lane_name || rawConfig.name || lane_id;

  // Xác định thư mục repo gốc
  let repo_dir = rawConfig.repo_dir || process.env.AIOS_DIEU_PHOI_DIR || process.cwd();
  if (configFilePath && !path.isAbsolute(repo_dir)) {
    repo_dir = path.resolve(path.dirname(configFilePath), repo_dir);
  } else {
    repo_dir = path.resolve(repo_dir);
  }

  const resolvePath = (p, defaultRel) => {
    const target = p || defaultRel;
    if (!target) return null;
    return path.isAbsolute(target) ? target : path.resolve(repo_dir, target);
  };

  const mailbox_dir = resolvePath(rawConfig.mailbox_dir, path.join('hop-thu', lane_id));
  const nudges_dir = resolvePath(rawConfig.nudges_dir, path.join(mailbox_dir, 'nudges'));
  const heartbeats_dir = resolvePath(rawConfig.heartbeats_dir, path.join(mailbox_dir, 'heartbeats'));
  const heartbeat_file = resolvePath(
    rawConfig.heartbeat_file,
    path.join(heartbeats_dir, `heartbeat-${lane_id}-watcher.json`)
  );
  const ket_qua_dir = resolvePath(rawConfig.ket_qua_dir, path.join(mailbox_dir, 'ket-qua'));
  const prompts_dir = resolvePath(rawConfig.prompts_dir, path.join(mailbox_dir, 'prompts'));
  const registry_file = resolvePath(rawConfig.registry_file, path.join(mailbox_dir, 'registry.json'));
  const picker_log_file = resolvePath(rawConfig.picker_log_file, path.join(mailbox_dir, 'picker.log'));
  const picker_process_pattern = rawConfig.picker_process_pattern || '*picker.js*';

  // Thư mục lưu trạng thái nội bộ ngoài cây git (mặc định khung-state/<lane_id>)
  let state_dir = rawConfig.state_dir;
  if (!state_dir) {
    state_dir = path.resolve(__dirname, '..', '..', 'khung-state', lane_id);
  } else if (!path.isAbsolute(state_dir)) {
    state_dir = path.resolve(repo_dir, state_dir);
  }

  const log_file = resolvePath(rawConfig.log_file, path.join(state_dir, 'watcher.log'));

  // Cấu hình chu kỳ & ngưỡng
  const cycle_seconds = parseInt(rawConfig.cycle_seconds, 10) || 300; // 5 phút
  const silence_threshold_seconds = parseInt(rawConfig.silence_threshold_seconds, 10) || 180; // 3 phút
  const cooldown_seconds = parseInt(rawConfig.cooldown_seconds, 10) || 900; // 15 phút

  // Cấu hình worker RealQueue (nếu bật)
  const rqRaw = rawConfig.realqueue || {};
  const realqueue = {
    enabled: rqRaw.enabled === true,
    worker_process_pattern: rqRaw.worker_process_pattern || '*picker-realqueue*',
    log_file: resolvePath(rqRaw.log_file, path.join(mailbox_dir, 'picker-realqueue.log')),
    heartbeat_file: resolvePath(
      rqRaw.heartbeat_file,
      path.join(heartbeats_dir, 'heartbeat-realqueue-worker.json')
    ),
    silence_threshold_seconds: parseInt(rqRaw.silence_threshold_seconds, 10) || 1800, // 30 phút
    heartbeat_interval_seconds: parseInt(rqRaw.heartbeat_interval_seconds, 10) || 1800, // 30 phút
    supabase_url: rqRaw.supabase_url || null,
    supabase_key: rqRaw.supabase_key || null,
    lease_expired_threshold_seconds: parseInt(rqRaw.lease_expired_threshold_seconds, 10) || 0,
    dlq_threshold: parseInt(rqRaw.dlq_threshold, 10) || 0,
    check_discrepancy: rqRaw.check_discrepancy !== false
  };

  // Cấu hình git
  const gitRaw = rawConfig.git || {};
  const git = {
    remote: gitRaw.remote || 'origin',
    branch: gitRaw.branch || 'main',
    enable_self_rescue: gitRaw.enable_self_rescue !== false
  };

  return {
    lane_id,
    lane_name,
    repo_dir,
    mailbox_dir,
    nudges_dir,
    heartbeats_dir,
    heartbeat_file,
    ket_qua_dir,
    prompts_dir,
    registry_file,
    picker_log_file,
    picker_process_pattern,
    state_dir,
    log_file,
    cycle_seconds,
    silence_threshold_seconds,
    cooldown_seconds,
    realqueue,
    git,
    raw: rawConfig
  };
}

/**
 * Đọc cấu hình làn từ một tệp JSON
 * @param {string} filePath 
 * @returns {object}
 */
function loadLaneConfigFile(filePath) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Tệp cấu hình làn không tồn tại: ${fullPath}`);
  }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const raw = JSON.parse(content);
  return resolveLaneConfig(raw, fullPath);
}

/**
 * Đảm bảo các thư mục cần thiết của làn tồn tại trên đĩa
 * @param {object} laneConfig 
 */
function ensureLaneDirs(laneConfig) {
  const dirs = [
    laneConfig.mailbox_dir,
    laneConfig.nudges_dir,
    laneConfig.heartbeats_dir,
    laneConfig.ket_qua_dir,
    laneConfig.state_dir
  ];
  for (const dir of dirs) {
    if (dir && !fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
  }
}

// =============================================================================
// 4. Kiểm tra Sức khỏe Picker Truyền Thống (Sự kiện c: picker-im-lang)
// =============================================================================
function checkPickerHealth(laneConfig, options = {}) {
  const silenceThresholdSec = options.silenceThresholdSec || laneConfig.silence_threshold_seconds;
  const result = {
    alive: false,
    processId: null,
    silenceSeconds: null,
    lastModifiedIso: null,
    tailLines: [],
    isSilent: false,
    reason: null
  };

  // 1. Kiểm tra tiến trình OS
  if (!options.skipProcessCheck) {
    try {
      const pattern = laneConfig.picker_process_pattern;
      if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('node.exe', 'Antigravity.exe')) -and ($_.CommandLine -like '${pattern}') } | Select-Object -First 1 -ExpandProperty ProcessId"`;
        const pidOut = execSync(cmd, { encoding: 'utf-8', timeout: 8000 }).trim();
        if (pidOut && !isNaN(parseInt(pidOut, 10))) {
          result.alive = true;
          result.processId = parseInt(pidOut, 10);
        }
      } else {
        const cmd = `pgrep -f "${pattern.replace(/\*/g, '')}" | head -n 1`;
        const pidOut = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (pidOut && !isNaN(parseInt(pidOut, 10))) {
          result.alive = true;
          result.processId = parseInt(pidOut, 10);
        }
      }
    } catch (e) {
      log(laneConfig, `[CANH BÁO] Kiểm tra tiến trình picker thất bại: ${e.message}`);
    }
  }

  // 2. Kiểm tra tệp picker.log
  if (laneConfig.picker_log_file && fs.existsSync(laneConfig.picker_log_file)) {
    try {
      const stat = fs.statSync(laneConfig.picker_log_file);
      result.lastModifiedIso = stat.mtime.toISOString();
      const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      result.silenceSeconds = ageSec;

      if (ageSec > silenceThresholdSec) {
        result.isSilent = true;
        result.reason = `picker.log không ghi log mới trong ${ageSec}s (ngưỡng: ${silenceThresholdSec}s)`;
      }

      const content = fs.readFileSync(laneConfig.picker_log_file, 'utf-8');
      const lines = content.trim().split('\n');
      result.tailLines = lines.slice(-20);
    } catch (e) {
      log(laneConfig, `[LỖI] Đọc picker.log thất bại: ${e.message}`);
    }
  } else {
    result.isSilent = true;
    result.reason = 'Tệp picker.log không tồn tại trên đĩa';
  }

  if (!result.alive && !options.skipProcessCheck) {
    result.isSilent = true;
    result.reason = (result.reason ? result.reason + ' & ' : '') + 'Không tìm thấy tiến trình picker đang chạy';
  }

  return result;
}

// =============================================================================
// 5. Kiểm tra Sức khỏe Worker RealQueue (Sự kiện d: realqueue-worker-im-lang)
// =============================================================================
function checkRealqueueHealth(laneConfig, options = {}) {
  const rqConfig = laneConfig.realqueue;
  if (!rqConfig || !rqConfig.enabled) {
    return { enabled: false, alive: true, isSilent: false };
  }

  const silenceThresholdSec = options.realqueueSilenceSec || rqConfig.silence_threshold_seconds;
  const result = {
    enabled: true,
    alive: false,
    processId: null,
    silenceSeconds: null,
    lastModifiedIso: null,
    tailLines: [],
    isSilent: false,
    reason: null,
    lastScanHasError: false,
    connectionErrorsCount: 0,
    mirrorDiscrepancyCount: 0
  };

  // 1. Kiểm tra tiến trình worker RealQueue
  if (!options.skipProcessCheck) {
    try {
      const pattern = rqConfig.worker_process_pattern;
      if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('node.exe', 'Antigravity.exe')) -and ($_.CommandLine -like '${pattern}') } | Select-Object -First 1 -ExpandProperty ProcessId"`;
        const pidOut = execSync(cmd, { encoding: 'utf-8', timeout: 8000 }).trim();
        if (pidOut && !isNaN(parseInt(pidOut, 10))) {
          result.alive = true;
          result.processId = parseInt(pidOut, 10);
        }
      } else {
        const cmd = `pgrep -f "${pattern.replace(/\*/g, '')}" | head -n 1`;
        const pidOut = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (pidOut && !isNaN(parseInt(pidOut, 10))) {
          result.alive = true;
          result.processId = parseInt(pidOut, 10);
        }
      }
    } catch (e) {
      log(laneConfig, `[CANH BÁO] Kiểm tra tiến trình RealQueue thất bại: ${e.message}`);
    }
  }

  // 2. Kiểm tra log RealQueue
  if (rqConfig.log_file && fs.existsSync(rqConfig.log_file)) {
    try {
      const stat = fs.statSync(rqConfig.log_file);
      result.lastModifiedIso = stat.mtime.toISOString();
      const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      result.silenceSeconds = ageSec;

      if (ageSec > silenceThresholdSec) {
        result.isSilent = true;
        result.reason = `picker-realqueue.log không có log mới trong ${ageSec}s (ngưỡng: ${silenceThresholdSec}s)`;
      }

      const content = fs.readFileSync(rqConfig.log_file, 'utf-8');
      const lines = content.trim().split('\n');
      result.tailLines = lines.slice(-20);

      // Phân tích PID và lỗi từ log
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        const line = lines[i];
        if (!result.processId) {
          const matchPid = line.match(/PID[:\s]*(\d+)/i) || line.match(/Worker ID:.*PID(\d+)/i);
          if (matchPid) {
            result.processId = parseInt(matchPid[1], 10);
          }
        }
      }

      // Đếm lỗi kết nối và lệch mirror
      const errKeywords = ['lỗi kết nối', 'econnrefused', 'etimedout', '50x', 'fetch failed', 'network error'];
      const mirrorKeywords = ['lỗi đồng bộ audit', 'lệch registry', 'mirror mismatch'];

      lines.forEach(l => {
        const lower = l.toLowerCase();
        if (errKeywords.some(k => lower.includes(k))) result.connectionErrorsCount++;
        if (mirrorKeywords.some(k => lower.includes(k))) result.mirrorDiscrepancyCount++;
      });

      const last10 = lines.slice(-10).join(' ').toLowerCase();
      result.lastScanHasError = errKeywords.some(k => last10.includes(k));
    } catch (e) {
      log(laneConfig, `[LỖI] Đọc log RealQueue thất bại: ${e.message}`);
    }
  } else {
    result.isSilent = true;
    result.reason = 'Tệp picker-realqueue.log không tồn tại trên đĩa';
  }

  if (!result.alive && !options.skipProcessCheck) {
    result.isSilent = true;
    result.reason = (result.reason ? result.reason + ' & ' : '') + 'Không tìm thấy tiến trình worker RealQueue đang chạy';
  }

  return result;
}

// =============================================================================
// 5.1. Khởi tạo & Lấy Client Supabase Reader cho Làn
// =============================================================================
function getSupabaseReader(laneConfig, options = {}) {
  if (options.supabaseReader) {
    return options.supabaseReader;
  }
  const rq = (laneConfig && laneConfig.realqueue) || {};
  return new SupabaseQueueReader({
    url: options.supabaseUrl || rq.supabase_url,
    key: options.supabaseKey || rq.supabase_key,
    fetchFn: options.fetchFn
  });
}

/**
 * TÍN HIỆU (a): Kiểm tra các vé bị CLAIMED quá hạn lease mà chưa xong
 * @param {object} laneConfig 
 * @param {object} options 
 * @returns {Promise<Array<object>>}
 */
async function checkClaimedExpiredLeases(laneConfig, options = {}) {
  if (!laneConfig.realqueue || !laneConfig.realqueue.enabled) {
    return [];
  }
  try {
    const reader = getSupabaseReader(laneConfig, options);
    if (!reader.isConfigured() && !options.mockTickets) {
      return [];
    }
    const thresholdSec = options.leaseThresholdSec !== undefined
      ? options.leaseThresholdSec
      : laneConfig.realqueue.lease_expired_threshold_seconds;

    return await reader.getClaimedExpiredTickets({
      lane: laneConfig.lane_id,
      thresholdSeconds: thresholdSec,
      now: options.now
    });
  } catch (err) {
    log(laneConfig, `[CANH BÁO] Kiểm tra vé CLAIMED quá hạn lease thất bại: ${err.message}`);
    const state = getLaneRuntimeState(laneConfig.lane_id);
    state.totalRealqueueConnectionErrors++;
    return [];
  }
}

/**
 * TÍN HIỆU (b): Giám sát hàng lỗi DLQ phình lên (Unresolved DLQ Records)
 * @param {object} laneConfig 
 * @param {object} options 
 * @returns {Promise<{isSwelling: boolean, dlqCount: number, dlqTickets: Array<object>, threshold: number, reason: string|null}>}
 */
async function checkDlqStatus(laneConfig, options = {}) {
  const result = {
    isSwelling: false,
    dlqCount: 0,
    dlqTickets: [],
    threshold: 0,
    reason: null
  };
  if (!laneConfig.realqueue || !laneConfig.realqueue.enabled) {
    return result;
  }
  try {
    const reader = getSupabaseReader(laneConfig, options);
    if (!reader.isConfigured() && !options.mockDlq) {
      return result;
    }
    const threshold = options.dlqThreshold !== undefined
      ? options.dlqThreshold
      : (laneConfig.realqueue.dlq_threshold || 0);

    const data = await reader.getUnresolvedDlqTickets({
      lane: laneConfig.lane_id,
      threshold
    });

    result.dlqCount = data.dlqCount;
    result.dlqTickets = data.dlqTickets;
    result.threshold = threshold;

    const state = getLaneRuntimeState(laneConfig.lane_id);
    const prevCount = state.lastDlqCount || 0;
    state.lastDlqCount = data.dlqCount;

    if (data.dlqCount > threshold || data.dlqCount > prevCount) {
      result.isSwelling = true;
      result.reason = `Phát hiện ${data.dlqCount} vé lỗi trong DLQ chưa giải quyết (ngưỡng: ${threshold}, số lần trước: ${prevCount})`;
    }
  } catch (err) {
    log(laneConfig, `[CANH BÁO] Kiểm tra DLQ thất bại: ${err.message}`);
    const state = getLaneRuntimeState(laneConfig.lane_id);
    state.totalRealqueueConnectionErrors++;
  }
  return result;
}

/**
 * TÍN HIỆU (c): Đối chiếu phát hiện sai lệch giữa bảng tickets và registry.json
 * @param {object} laneConfig 
 * @param {object} options 
 * @returns {Promise<{hasDiscrepancy: boolean, discrepancyCount: number, discrepancies: Array<object>}>}
 */
async function checkTicketsRegistryDiscrepancy(laneConfig, options = {}) {
  const result = {
    hasDiscrepancy: false,
    discrepancyCount: 0,
    discrepancies: []
  };
  if (!laneConfig.realqueue || !laneConfig.realqueue.enabled) {
    return result;
  }
  if (laneConfig.realqueue.check_discrepancy === false) {
    return result;
  }
  try {
    let registry = [];
    if (fs.existsSync(laneConfig.registry_file)) {
      try {
        registry = JSON.parse(fs.readFileSync(laneConfig.registry_file, 'utf-8'));
      } catch (e) {
        log(laneConfig, `[LỖI] Đọc registry.json để đối chiếu thất bại: ${e.message}`);
      }
    }
    const reader = getSupabaseReader(laneConfig, options);
    if (!reader.isConfigured() && !options.tickets) {
      return result;
    }
    const data = await reader.checkTicketsRegistryDiscrepancy({
      lane: laneConfig.lane_id,
      registry,
      tickets: options.tickets
    });

    result.hasDiscrepancy = data.hasDiscrepancy;
    result.discrepancyCount = data.discrepancyCount;
    result.discrepancies = data.discrepancies;

    const state = getLaneRuntimeState(laneConfig.lane_id);
    state.lastRealqueueDiscrepancyCount = data.discrepancyCount;
  } catch (err) {
    log(laneConfig, `[CANH BÁO] Kiểm tra sai lệch tickets và registry thất bại: ${err.message}`);
    const state = getLaneRuntimeState(laneConfig.lane_id);
    state.totalRealqueueConnectionErrors++;
  }
  return result;
}

// =============================================================================
// 6. Kiểm tra Vé Đã Đóng nhưng Chưa Đẩy (Sự kiện a: dong-chua-day)
// =============================================================================
function checkUnpushedTickets(laneConfig, options = {}) {
  const unpushed = [];
  if (!fs.existsSync(laneConfig.registry_file)) {
    return unpushed;
  }

  let registry = [];
  try {
    registry = JSON.parse(fs.readFileSync(laneConfig.registry_file, 'utf-8'));
  } catch (e) {
    log(laneConfig, `[LỖI] Đọc registry.json thất bại: ${e.message}`);
    return unpushed;
  }

  const repoDir = laneConfig.repo_dir;
  const remote = laneConfig.git.remote;
  const branch = laneConfig.git.branch;

  let aheadCount = 0;
  try {
    const aheadOut = execSync(`git rev-list ${remote}/${branch}..HEAD --count`, {
      cwd: repoDir,
      encoding: 'utf-8'
    }).trim();
    aheadCount = parseInt(aheadOut, 10) || 0;
  } catch (e) {
    log(laneConfig, `[CANH BÁO] Kiểm tra git rev-list ahead thất bại: ${e.message}`);
  }

  // Quét danh sách tệp kết quả trên remote origin/main qua git ls-tree
  const remoteFilesSet = new Set();
  const relKetQua = path.relative(repoDir, laneConfig.ket_qua_dir).replace(/\\/g, '/');
  try {
    const lsTreeOut = execSync(`git ls-tree -r ${remote}/${branch} --name-only "${relKetQua}"`, {
      cwd: repoDir,
      encoding: 'utf-8'
    });
    lsTreeOut.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => remoteFilesSet.add(f));
  } catch (e) {
    log(laneConfig, `[CANH BÁO] Không lấy được ls-tree từ remote ${remote}/${branch}: ${e.message}`);
  }

  for (const entry of registry) {
    if (entry.trang_thai === 'da-dong') {
      const maVe = entry.ma_ve;
      const reportName = `${maVe}.md`;
      const absReport = path.join(laneConfig.ket_qua_dir, reportName);
      const relReport = path.relative(repoDir, absReport).replace(/\\/g, '/');

      if (fs.existsSync(absReport)) {
        const existsOnRemote = remoteFilesSet.has(relReport);
        if (!existsOnRemote) {
          const closedAt = entry.thoi_diem_dong ? new Date(entry.thoi_diem_dong).getTime() : 0;
          const ageMs = Date.now() - closedAt;
          if (ageMs > 60000 || options.ignoreGracePeriod) {
            unpushed.push({
              ma_ve: maVe,
              trang_thai_local: 'da-dong',
              thoi_diem_dong: entry.thoi_diem_dong,
              absReport,
              relReport,
              existsOnRemote: false,
              aheadCount
            });
          }
        }
      }
    }
  }

  return unpushed;
}

// =============================================================================
// 7. Kiểm tra Trạng thái Hàng đợi Làn (Sự kiện b: hang-can)
//    ĐÃ TRẢ NỢ: Ghi nhận minh bạch và không tính chính tiến trình thợ canh
// =============================================================================
function checkQueueStatus(laneConfig, options = {}) {
  const result = {
    isDry: false,
    activeCount: 0,
    queuedCount: 0,
    pendingNewTickets: 0,
    totalClosed: 0,
    activeTickets: [],
    queuedTickets: [],
    note: 'Bộ đếm chỉ tính vé nghiệp vụ của thợ, không tính chính tiến trình watcher'
  };

  let registry = [];
  if (fs.existsSync(laneConfig.registry_file)) {
    try {
      registry = JSON.parse(fs.readFileSync(laneConfig.registry_file, 'utf-8'));
      for (const r of registry) {
        if (r.trang_thai === 'dang-chay') {
          result.activeCount++;
          result.activeTickets.push(r.ma_ve);
        } else if (r.trang_thai === 'cho-slot') {
          result.queuedCount++;
          result.queuedTickets.push(r.ma_ve);
        } else if (r.trang_thai === 'da-dong') {
          result.totalClosed++;
        }
      }
    } catch (e) {
      log(laneConfig, `[LỖI] Đọc registry.json: ${e.message}`);
    }
  }

  const knownTicketIds = new Set(registry.map(r => r.ma_ve));

  // Quét thư mục hộp thư và prompts tìm vé mới
  const scanFolders = [laneConfig.mailbox_dir];
  if (laneConfig.prompts_dir && laneConfig.prompts_dir !== laneConfig.mailbox_dir) {
    scanFolders.push(laneConfig.prompts_dir);
  }

  for (const folder of scanFolders) {
    if (!fs.existsSync(folder)) continue;
    try {
      const files = fs.readdirSync(folder);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        if (f.startsWith('BAO-DONG') || f.startsWith('T-') || f.startsWith('backup') ||
            f === 'README.md' || f === 'QUY-UOC.md' || f === 'trang-thai.md') {
          continue;
        }

        const full = path.join(folder, f);
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const matchMaVe = content.match(/Ma ve:\s*([^\r\n]+)/i);
          const maVe = matchMaVe ? matchMaVe[1].trim() : path.basename(f, '.md');

          if (!knownTicketIds.has(maVe)) {
            const ketQuaPath = path.join(laneConfig.ket_qua_dir, `${maVe}.md`);
            if (!fs.existsSync(ketQuaPath)) {
              if (content.includes('Trang thai: moi') || content.includes('Trạng thái: mới')) {
                result.pendingNewTickets++;
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  if (result.activeCount === 0 && result.queuedCount === 0 && result.pendingNewTickets === 0) {
    result.isDry = true;
  }

  return result;
}

// =============================================================================
// 8. Tự Cứu Hẹp (Narrow Self-Rescue) An Toàn
// =============================================================================
function attemptSafeSelfRescue(laneConfig, options = {}) {
  const repoDir = laneConfig.repo_dir;
  const remote = laneConfig.git.remote;
  const branch = laneConfig.git.branch;

  log(laneConfig, '[TỰ CỨU HẸP] Bắt đầu kiểm tra chuỗi đẩy an toàn...');
  const result = {
    attempted: false,
    success: false,
    pushedCommits: 0,
    error: null
  };

  try {
    execSync(`git fetch ${remote} ${branch}`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
    const aheadOut = execSync(`git rev-list ${remote}/${branch}..HEAD --count`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    const aheadCount = parseInt(aheadOut, 10) || 0;

    if (aheadCount === 0) {
      log(laneConfig, '[TỰ CỨU HẸP] Local không dẫn trước remote, không cần tự cứu.');
      return result;
    }

    result.attempted = true;
    log(laneConfig, `[TỰ CỨU HẸP] Phát hiện ${aheadCount} commit cục bộ chưa đẩy. Bắt đầu rebase ${remote}/${branch}...`);

    try {
      execSync(`git rebase --autostash ${remote}/${branch}`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
    } catch (rebaseErr) {
      const isRebasing = fs.existsSync(path.join(repoDir, '.git', 'rebase-merge')) ||
                         fs.existsSync(path.join(repoDir, '.git', 'rebase-apply'));
      if (isRebasing) {
        try {
          execSync('git rebase --abort', { cwd: repoDir, stdio: 'pipe' });
        } catch (abortErr) {}
      }
      log(laneConfig, `[CẢNH BÁO TỰ CỨU] Rebase có xung đột hoặc lỗi! Đã huỷ rebase an toàn: ${rebaseErr.message}`);
      result.error = 'Rebase bi xung dot hoac loi, da xu ly an toan. Can can thiep thu cong.';
      return result;
    }

    log(laneConfig, `[TỰ CỨU HẸP] Rebase thành công sạch sẽ. Đẩy lên ${remote}/${branch}...`);
    execFileSync('git', ['push', remote, `HEAD:${branch}`], { cwd: repoDir, stdio: 'pipe', timeout: 30000 });

    result.success = true;
    result.pushedCommits = aheadCount;
    log(laneConfig, `[TỰ CỨU HẸP] Thành công! Đã đẩy ${aheadCount} commit lên ${remote}/${branch}.`);
  } catch (e) {
    log(laneConfig, `[LỖI TỰ CỨU] Thất bại: ${e.message}`);
    result.error = e.message;
  }

  return result;
}

// =============================================================================
// 9. Sinh Tệp Giục (Nudges)
//    CẢI TIẾN TRẢ NỢ 1: Tệp giục ghi rõ "không tính chính nó" vào bộ đếm
// =============================================================================
function writeNudgeFile(laneConfig, eventType, data = {}) {
  ensureLaneDirs(laneConfig);
  const date = new Date();
  const slug = getTimestampSlug(date);
  const vTime = getVietnamTime(date);
  const isoTime = date.toISOString();

  let ticketSuffix = '';
  if (data.ma_ve) {
    ticketSuffix = `-${data.ma_ve}`;
  }
  let filename = `${slug}-${eventType}${ticketSuffix}.md`;
  let absPath = path.join(laneConfig.nudges_dir, filename);
  if (fs.existsSync(absPath)) {
    let counter = 1;
    while (fs.existsSync(absPath)) {
      filename = `${slug}-${eventType}${ticketSuffix}-${counter}.md`;
      absPath = path.join(laneConfig.nudges_dir, filename);
      counter++;
    }
  }
  const relPath = path.relative(laneConfig.repo_dir, absPath).replace(/\\/g, '/');

  let title = '';
  let content = '';

  if (eventType === 'dong-chua-day') {
    title = `VÉ ĐÃ ĐÓNG LOCAL NHƯNG CHƯA ĐẨY LÊN KHO [${data.ma_ve || 'CHƯA_RÕ'}]`;
    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`dong-chua-day\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Mã vé**: \`${data.ma_ve || 'N/A'}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng cục bộ (Local Evidence)
- **Tệp kết quả local**: \`${data.absReport || 'N/A'}\`
- **Tồn tại trên remote origin/main**: \`${data.existsOnRemote ? 'CÓ' : 'KHÔNG'}\`
- **Số commit local ahead origin/main**: \`${data.aheadCount || 0}\` commit
- **Thời điểm đóng trong registry**: \`${data.thoi_diem_dong || 'N/A'}\`
- **Tự cứu hẹp**: \`${JSON.stringify(data.selfRescue || {})}\`

## 2. Phân tích nguyên nhân
- Phiên thực thi của thợ đã hoàn thành và lưu báo cáo kết quả trên máy nhà.
- Tuy nhiên commit kết quả chưa thể đẩy lên remote origin/main.
- Hậu quả: Điều phối viên ở xa qua vòng poll kho không nhìn thấy tiến độ và coi phiên bị kẹt.

## 3. Hành động đề xuất cho Điều phối viên
- Nếu tự cứu hẹp đã giải quyết: Xác nhận commit đã xuất hiện trên remote.
- Nếu chưa đẩy được: Kiểm tra nhánh và hướng dẫn thợ rebase / đồng bộ.
`;
  } else if (eventType === 'hang-can') {
    title = `HÀNG ĐỢI LÀN ${laneConfig.lane_name.toUpperCase()} ĐÃ CẠN (IDLE)`;
    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`hang-can\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng cục bộ (Local Evidence)
- **Số vé đang chạy (\`dang-chay\`)**: \`0\` *(Lưu ý: Không tính chính nó - tức tiến trình watcher/sidecar - vào bộ đếm vé đang chạy)*
- **Số vé chờ slot (\`cho-slot\`)**: \`0\`
- **Số vé mới trong hộp thư (\`moi\`)**: \`0\`
- **Tổng số vé đã hoàn thành trong registry**: \`${data.totalClosed || 0}\` vé
- **Tình trạng thợ**: Máy nhà rảnh rỗi 100%, sẵn sàng nhận nhiệm vụ mới.

## 2. Phân tích & Đề xuất cho Điều phối viên
- Toàn bộ công việc trong làn \`${laneConfig.lane_id}\` đã hoàn tất sạch sẽ.
- Hàng đợi hiện đang rỗng, không có vé nào chờ xử lý.
- **Ghi chú xác thực**: Bộ đếm trạng thái hàng đợi chỉ tính các vé nghiệp vụ của thợ/agent, hoàn toàn không tính chính tiến trình watcher vào bộ đếm.
- **Hành động đề xuất**: Điều phối viên tiếp tục phát vé mới vào \`${laneConfig.mailbox_dir}\` để tận dụng tối đa năng lực máy nhà.
`;
  } else if (eventType === 'picker-im-lang') {
    title = `PICKER / LOG IM LẶNG BẤT THƯỜNG [${laneConfig.lane_id}]`;
    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`picker-im-lang\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng cục bộ (Local Evidence)
- **Thời gian im lặng**: \`${data.silenceSeconds || 'N/A'}\` giây (ngưỡng cảnh báo: \`${data.threshold || laneConfig.silence_threshold_seconds}\`s)
- **Trạng thái tiến trình picker**: \`${data.alive ? 'ĐANG CHẠY (PID: ' + data.processId + ')' : 'ĐÃ DỪNG / KHÔNG TÌM THẤY'}\`
- **Lý do kích hoạt**: \`${data.reason || 'N/A'}\`
- **Mốc ghi log cuối**: \`${data.lastModifiedIso || 'N/A'}\`

### Trích đoạn 20 dòng cuối từ picker.log:
\`\`\`text
${(data.tailLines || []).join('\n')}
\`\`\`

## 2. Phân tích & Đề xuất cho Điều phối viên
- Tiến trình picker của làn ${laneConfig.lane_id} không cập nhật log theo chu kỳ định kỳ hoặc đã bị gián đoạn.
- **Hành động đề xuất**: Kiểm tra/khởi động lại sidecar picker của làn hoặc kiểm tra tài nguyên máy trạm.
`;
  } else if (eventType === 'realqueue-worker-im-lang') {
    title = `REALQUEUE WORKER IM LẶNG HOẶC TIẾN TRÌNH ĐÃ DỪNG [${laneConfig.lane_id}]`;
    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`realqueue-worker-im-lang\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng cục bộ (Local Evidence)
- **Thời gian im lặng của log**: \`${data.silenceSeconds || 'N/A'}\` giây (ngưỡng: \`${data.threshold || 1800}\`s)
- **Trạng thái tiến trình worker**: \`${data.alive ? 'ĐANG CHẠY (PID: ' + data.processId + ')' : 'ĐÃ DỪNG / KHÔNG TÌM THẤY'}\`
- **Lý do kích hoạt**: \`${data.reason || 'N/A'}\`
- **Mốc ghi log cuối**: \`${data.lastModifiedIso || 'N/A'}\`
- **Số lần mất kết nối ghi nhận**: \`${data.connectionErrorsCount || 0}\`
- **Số vé mirror lệch registry**: \`${data.mirrorDiscrepancyCount || 0}\`

### Trích đoạn 20 dòng cuối từ picker-realqueue.log:
\`\`\`text
${(data.tailLines || []).join('\n')}
\`\`\`

## 2. Phân tích & Đề xuất cho Điều phối viên
- Worker RealQueue của làn ${laneConfig.lane_id} không có hoạt động mới vượt ngưỡng hoặc tiến trình đã ngừng.
- **Hành động đề xuất**: Điều phối viên ghi nhận và đưa ra phán quyết can thiệp thích hợp.
`;
  } else if (eventType === 've-claimed-qua-han-lease') {
    const ticketId = data.ticket_id || data.ma_ve || 'CHƯA_RÕ';
    title = `VÉ CLAIMED QUÁ HẠN LEASE CHƯA XONG [${ticketId}]`;
    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`ve-claimed-qua-han-lease\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Mã vé**: \`${ticketId}\`
- **Mã trace**: \`${data.trace_id || 'N/A'}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng CSDL Supabase (Database Evidence)
- **Trạng thái vé (\`state\`)**: \`${data.state || 'CLAIMED'}\`
- **Worker ID đang giữ lease**: \`${data.worker_id || 'N/A'}\`
- **Thời điểm claim**: \`${data.claimed_at || 'N/A'}\`
- **Hạn lease (\`lease_expires_at\`)**: \`${data.lease_expires_at || 'N/A'}\`
- **Thời gian quá hạn**: \`${data.expired_seconds || 0}\` giây (ngưỡng trễ cho phép: \`${data.threshold_seconds || 0}\`s)
- **Heartbeat cuối cùng**: \`${data.last_heartbeat_at || 'N/A'}\`
- **Số lần thử lại (\`retry_count\`)**: \`${data.retry_count || 0}\`

## 2. Phân tích nguyên nhân
- Vé đã được worker bốc (CLAIMED / EXECUTING) nhưng đã vượt quá hạn hợp đồng thuê (lease) mà chưa có báo cáo hoàn thành.
- Nguyên nhân có thể do worker bị đột tử, mất mạng hoặc phiên Antigravity bị treo ngầm không phát nhịp tim gia hạn.
- Hậu quả: Vé bị chiếm giữ đơn quyền khiến các worker khác không thể bốc lại.

## 3. Hành động đề xuất cho Điều phối viên
- Kiểm tra tiến trình worker hoặc gọi stored procedure RPC \`reap_expired_leases\` để thu hồi quyền giữ vé đưa về \`QUEUED\` / \`FAILED\`.
- Kiểm tra nhật ký phiên làm việc của worker ID \`${data.worker_id || 'N/A'}\`.
`;
  } else if (eventType === 'dlq-phinh-len') {
    title = `HÀNG ĐỢI LỖI DLQ PHÌNH LÊN [${laneConfig.lane_name.toUpperCase()}]`;
    const dlqRows = (data.dlqTickets || []).map((t, idx) => {
      const errSnippet = (t.final_error || '').replace(/\r?\n/g, ' ').slice(0, 100);
      return `| ${idx + 1} | \`${t.ticket_id}\` | \`${t.trace_id || 'N/A'}\` | \`${t.failed_lane || 'N/A'}\` | ${t.total_retries || 0} | \`${t.isolated_at || 'N/A'}\` | ${errSnippet} |`;
    }).join('\n');

    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`dlq-phinh-len\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng CSDL Supabase (DLQ Evidence)
- **Tổng số vé trong Dead-Letter Queue**: \`${data.dlqCount || 0}\` vé (ngưỡng cảnh báo: \`${data.threshold || 0}\`)
- **Lý do kích hoạt**: \`${data.reason || 'DLQ có vé lỗi chưa được giải quyết'}\`

### Danh sách vé bị cách ly trong DLQ:
| STT | Mã vé | Mã trace | Làn lỗi | Số lần retry | Thời điểm cách ly | Lỗi cuối |
|:---:|:---|:---|:---:|:---:|:---|:---|
${dlqRows || '| - | Không có chi tiết vé | - | - | - | - | - |'}

## 2. Phân tích nguyên nhân
- Các vé trong danh sách đã thất bại quá số lần cho phép (mặc định 4 lần) và bị cô lập vào bảng \`ticket_dlq\`.
- Số lượng vé trong DLQ tăng lên báo hiệu sự cố lặp lại mang tính hệ thống (lỗi cú pháp, sai lệch tài nguyên, hoặc dịch vụ ngoài từ chối).

## 3. Hành động đề xuất cho Điều phối viên
- Rà soát nguyên nhân gốc rễ (\`final_error\`) của các vé trong bảng trên.
- Sửa lỗi trong codebase hoặc môi trường, sau đó cập nhật \`resolved_at\` và nạp lại vé nếu cần.
`;
  } else if (eventType === 'lech-tickets-registry') {
    title = `LỆCH TRẠNG THÁI GIỮA BẢNG TICKETS VÀ REGISTRY [${laneConfig.lane_name.toUpperCase()}]`;
    const discRows = (data.discrepancies || []).map((d, idx) => {
      return `| ${idx + 1} | \`${d.ticket_id}\` | \`${d.supabase_state}\` | \`${d.registry_state}\` | \`${d.type}\` | ${d.detail} |`;
    }).join('\n');

    content = `# GIỤC ĐIỀU PHỐI: ${title}

- **Mã sự kiện**: \`lech-tickets-registry\`
- **Mã làn**: \`${laneConfig.lane_id}\`
- **Thời điểm phát hiện**: \`${isoTime}\` (\`${vTime}\`)
- **Máy phát**: Máy nhà (\`${laneConfig.lane_id}\`)

## 1. Bằng chứng đối chiếu (Discrepancy Evidence)
- **Tổng số vé sai lệch**: \`${data.discrepancyCount || (data.discrepancies && data.discrepancies.length) || 0}\` vé

### Bảng chi tiết sai lệch giữa CSDL Supabase và Sổ cái Registry:
| STT | Mã vé | Supabase State | Registry State | Loại sai lệch | Chi tiết |
|:---:|:---|:---:|:---:|:---|:---|
${discRows || '| - | Không có sai lệch | - | - | - | - |'}

## 2. Phân tích nguyên nhân
- Xuất hiện sự không đồng nhất giữa Tuyến Điều phối Thời gian thực (Supabase PostgREST) và Tuyến Lưu trữ Kiểm toán cục bộ (registry.json).
- Tình trạng này có thể xảy ra khi worker bốc vé hoặc đóng vé thành công trên một tuyến nhưng bị đứt kết nối hoặc gặp lỗi khi cập nhật tuyến còn lại.

## 3. Hành động đề xuất cho Điều phối viên
- Đối chiếu lại tệp kết quả nghiệm thu (\`ket-qua/<MA_VE>.md\`) trên đĩa.
- Nếu vé đã hoàn tất: Gọi \`completeTicket\` trên Supabase hoặc cập nhật \`registry.json\` về \`da-dong\` để đồng bộ hai tuyến.
`;
  }

  fs.writeFileSync(absPath, content, 'utf-8');
  log(laneConfig, `[GIỤC ĐIỀU PHỐI] Đã tạo tệp giục: ${relPath}`);

  const runtimeState = getLaneRuntimeState(laneConfig.lane_id);
  runtimeState.lastNudgeTime[eventType] = Date.now();

  return { absPath, relPath, filename };
}

// =============================================================================
// 10. Ghi Heartbeat Chuẩn
//     CẢI TIẾN TRẢ NỢ 2: Sửa bộ đếm tong_so_nudge_da_phat đếm chính xác tệp trên đĩa
// =============================================================================
function writeHeartbeat(laneConfig, stats = {}) {
  ensureLaneDirs(laneConfig);
  const date = new Date();
  const isoTime = date.toISOString();
  const vTime = getVietnamTime(date);

  let gitHead = 'unknown';
  let gitAhead = 0;
  try {
    gitHead = execSync('git rev-parse --short HEAD', { cwd: laneConfig.repo_dir, encoding: 'utf-8' }).trim();
    const aheadOut = execSync(`git rev-list ${laneConfig.git.remote}/${laneConfig.git.branch}..HEAD --count`, {
      cwd: laneConfig.repo_dir,
      encoding: 'utf-8'
    }).trim();
    gitAhead = parseInt(aheadOut, 10) || 0;
  } catch (e) {}

  // Đếm chính xác tổng số tệp giục đã phát đang có trên đĩa
  const totalNudgesDispatched = countDispatchedNudges(laneConfig.nudges_dir);

  const payload = {
    watcher: `WATCHER-NUDGE-${laneConfig.lane_id.toUpperCase()}`,
    phien_ban: '2.0.0-standard',
    lane_id: laneConfig.lane_id,
    trang_thai: 'ALIVE',
    thoi_diem_iso: isoTime,
    gio_dia_phuong: vTime,
    chu_ky_giay: Math.round((stats.cycleSeconds || laneConfig.cycle_seconds)),
    may_thuc_thi: `may-nha-${laneConfig.lane_id}`,
    thong_ke: {
      tong_ve_registry: stats.totalRegistry || 0,
      ve_dang_chay: stats.activeCount || 0,
      ve_cho_slot: stats.queuedCount || 0,
      ve_moi_hop_thu: stats.pendingNewTickets || 0,
      picker_alive: stats.pickerAlive !== false,
      picker_pid: stats.pickerPid || null,
      picker_silence_seconds: stats.pickerSilenceSec || 0,
      git_head: gitHead,
      git_ahead_count: gitAhead,
      tong_so_nudge_da_phat: totalNudgesDispatched
    }
  };

  if (laneConfig.realqueue && laneConfig.realqueue.enabled) {
    payload.thong_ke.realqueue_worker_alive = stats.realqueueAlive !== false;
    payload.thong_ke.realqueue_worker_pid = stats.realqueuePid || null;
    payload.thong_ke.realqueue_log_silence_seconds = stats.realqueueSilenceSec || 0;
    payload.thong_ke.realqueue_claimed_expired_count = stats.realqueueClaimedExpiredCount || 0;
    payload.thong_ke.realqueue_dlq_count = stats.realqueueDlqCount || 0;
    payload.thong_ke.realqueue_discrepancy_count = stats.realqueueDiscrepancyCount || 0;
  }

  const tempPath = laneConfig.heartbeat_file + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  if (fs.existsSync(laneConfig.heartbeat_file)) {
    try { fs.unlinkSync(laneConfig.heartbeat_file); } catch (e) {}
  }
  fs.renameSync(tempPath, laneConfig.heartbeat_file);

  const runtimeState = getLaneRuntimeState(laneConfig.lane_id);
  runtimeState.lastHeartbeatTime = Date.now();

  return payload;
}

function writeRealqueueHeartbeat(laneConfig, healthData = {}) {
  const rqConfig = laneConfig.realqueue;
  if (!rqConfig || !rqConfig.enabled || !rqConfig.heartbeat_file) {
    return null;
  }
  ensureLaneDirs(laneConfig);
  const date = new Date();
  const isoTime = date.toISOString();
  const vTime = getVietnamTime(date);

  const payload = {
    lane_id: laneConfig.lane_id,
    moc_ghi: isoTime,
    gio_dia_phuong: vTime,
    worker_song_chet: healthData.alive ? 'SONG' : 'CHET',
    worker_alive: !!healthData.alive,
    pid: healthData.processId || null,
    tuoi_log_giay: healthData.silenceSeconds || 0,
    so_lan_mat_ket_noi: healthData.connectionErrorsCount || 0,
    so_ve_mirror_lech_registry: healthData.mirrorDiscrepancyCount ?? healthData.discrepancyCount ?? 0,
    so_ve_claimed_qua_han_lease: healthData.claimedExpiredCount || 0,
    so_ve_dlq_chua_xu_ly: healthData.dlqCount || 0
  };

  const tempPath = rqConfig.heartbeat_file + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  if (fs.existsSync(rqConfig.heartbeat_file)) {
    try { fs.unlinkSync(rqConfig.heartbeat_file); } catch (e) {}
  }
  fs.renameSync(tempPath, rqConfig.heartbeat_file);

  const runtimeState = getLaneRuntimeState(laneConfig.lane_id);
  runtimeState.lastRealqueueHeartbeatTime = Date.now();

  return payload;
}

// =============================================================================
// 11. Đẩy Tệp Giục & Heartbeat lên Kho An Toàn
// =============================================================================
function pushNudgeToRepo(laneConfig, relNudgePath, extraFiles = []) {
  const repoDir = laneConfig.repo_dir;
  const remote = laneConfig.git.remote;
  const branch = laneConfig.git.branch;

  try {
    execSync(`git add "${relNudgePath}"`, { cwd: repoDir, stdio: 'pipe' });

    const relHb = path.relative(repoDir, laneConfig.heartbeat_file).replace(/\\/g, '/');
    if (fs.existsSync(laneConfig.heartbeat_file)) {
      execSync(`git add "${relHb}"`, { cwd: repoDir, stdio: 'pipe' });
    }

    if (laneConfig.realqueue && laneConfig.realqueue.enabled && fs.existsSync(laneConfig.realqueue.heartbeat_file)) {
      const relRqHb = path.relative(repoDir, laneConfig.realqueue.heartbeat_file).replace(/\\/g, '/');
      execSync(`git add "${relRqHb}"`, { cwd: repoDir, stdio: 'pipe' });
    }

    for (const extra of extraFiles) {
      if (fs.existsSync(path.resolve(repoDir, extra))) {
        execSync(`git add "${extra}"`, { cwd: repoDir, stdio: 'pipe' });
      }
    }

    let hasDiff = false;
    try {
      execSync('git diff --cached --quiet', { cwd: repoDir, stdio: 'pipe' });
    } catch (e) {
      hasDiff = true;
    }

    if (hasDiff) {
      const nudgeBaseName = path.basename(relNudgePath);
      execFileSync('git', ['commit', '-m', `chore(${laneConfig.lane_id}-watcher): giuc dieu phoi [${nudgeBaseName}]`], {
        cwd: repoDir,
        stdio: 'pipe'
      });

      execSync(`git fetch ${remote} ${branch}`, { cwd: repoDir, stdio: 'pipe', timeout: 25000 });
      try {
        execSync(`git rebase --autostash ${remote}/${branch}`, { cwd: repoDir, stdio: 'pipe', timeout: 25000 });
      } catch (rebaseErr) {
        const isRebasing = fs.existsSync(path.join(repoDir, '.git', 'rebase-merge')) ||
                           fs.existsSync(path.join(repoDir, '.git', 'rebase-apply'));
        if (isRebasing) {
          try {
            execSync('git rebase --abort', { cwd: repoDir, stdio: 'pipe' });
          } catch (abortErr) {}
        }
        log(laneConfig, `[CẢNH BÁO ĐẨY] Rebase có xung đột: ${rebaseErr.message}`);
        return false;
      }

      execFileSync('git', ['push', remote, `HEAD:${branch}`], { cwd: repoDir, stdio: 'pipe', timeout: 25000 });
      log(laneConfig, `[THÀNH CÔNG] Đã đẩy tệp giục ${relNudgePath} lên ${remote}/${branch}.`);
      return true;
    }
  } catch (e) {
    log(laneConfig, `[LỖI ĐẨY GIỤC] ${e.message}`);
    return false;
  }
  return false;
}

// =============================================================================
// 12. Quét Chu Kỳ Hoàn Chỉnh Cho Một Làn (Scan Cycle For A Single Lane)
// =============================================================================
async function scanLaneCycle(laneConfig, options = {}) {
  log(laneConfig, `================ BẮT ĐẦU CHU KỲ QUÉT LÀN: ${laneConfig.lane_id} ================`);
  ensureLaneDirs(laneConfig);

  const runtimeState = getLaneRuntimeState(laneConfig.lane_id);
  runtimeState.totalRuns++;

  const cycleResults = {
    lane_id: laneConfig.lane_id,
    timestamp: new Date().toISOString(),
    eventsDetected: [],
    nudgesCreated: [],
    selfRescue: null,
    heartbeat: null,
    realqueueHeartbeat: null
  };

  const cooldownMs = (options.cooldownSeconds || laneConfig.cooldown_seconds) * 1000;

  // 1. Kiểm tra sức khỏe picker (Event c)
  const pickerHealth = checkPickerHealth(laneConfig, options);
  log(laneConfig, `Sức khỏe picker: alive=${pickerHealth.alive}, silence=${pickerHealth.silenceSeconds}s, reason=${pickerHealth.reason || 'OK'}`);

  if (pickerHealth.isSilent) {
    cycleResults.eventsDetected.push('picker-im-lang');
    const now = Date.now();
    const lastSent = runtimeState.lastNudgeTime['picker-im-lang'] || 0;
    if (now - lastSent > cooldownMs || options.forceNudge) {
      const nudge = writeNudgeFile(laneConfig, 'picker-im-lang', {
        silenceSeconds: pickerHealth.silenceSeconds,
        threshold: options.silenceThresholdSec || laneConfig.silence_threshold_seconds,
        alive: pickerHealth.alive,
        processId: pickerHealth.processId,
        reason: pickerHealth.reason,
        lastModifiedIso: pickerHealth.lastModifiedIso,
        tailLines: pickerHealth.tailLines
      });
      cycleResults.nudgesCreated.push(nudge);
      if (options.autoPush) {
        pushNudgeToRepo(laneConfig, nudge.relPath);
      }
    } else {
      log(laneConfig, '[BỎ QUA GIỤC] Sự kiện picker-im-lang đang trong thời gian cooldown.');
    }
  }

  // 2. Kiểm tra sức khỏe RealQueue (Event d)
  let rqHealth = { enabled: false };
  if (laneConfig.realqueue && laneConfig.realqueue.enabled) {
    rqHealth = checkRealqueueHealth(laneConfig, options);
    log(laneConfig, `Sức khỏe RealQueue: alive=${rqHealth.alive}, silence=${rqHealth.silenceSeconds}s, errors=${rqHealth.connectionErrorsCount}`);

    if (rqHealth.isSilent) {
      cycleResults.eventsDetected.push('realqueue-worker-im-lang');
      const now = Date.now();
      const lastSent = runtimeState.lastNudgeTime['realqueue-worker-im-lang'] || 0;
      if (now - lastSent > cooldownMs || options.forceNudge) {
        const nudge = writeNudgeFile(laneConfig, 'realqueue-worker-im-lang', {
          silenceSeconds: rqHealth.silenceSeconds,
          threshold: laneConfig.realqueue.silence_threshold_seconds,
          alive: rqHealth.alive,
          processId: rqHealth.processId,
          reason: rqHealth.reason,
          lastModifiedIso: rqHealth.lastModifiedIso,
          connectionErrorsCount: rqHealth.connectionErrorsCount,
          mirrorDiscrepancyCount: rqHealth.mirrorDiscrepancyCount,
          tailLines: rqHealth.tailLines
        });
        cycleResults.nudgesCreated.push(nudge);
        if (options.autoPush) {
          pushNudgeToRepo(laneConfig, nudge.relPath);
        }
      }
    }

    // Ghi Heartbeat RealQueue định kỳ
    const now = Date.now();
    const rqHbIntervalMs = laneConfig.realqueue.heartbeat_interval_seconds * 1000;
    const timeSinceLastRqHb = now - runtimeState.lastRealqueueHeartbeatTime;
    if (timeSinceLastRqHb >= rqHbIntervalMs || !fs.existsSync(laneConfig.realqueue.heartbeat_file) || options.forceHeartbeat) {
      cycleResults.realqueueHeartbeat = writeRealqueueHeartbeat(laneConfig, rqHealth);
    }
  }

  // 3. Kiểm tra vé đóng nhưng chưa đẩy (Event a)
  const unpushed = checkUnpushedTickets(laneConfig, options);
  if (unpushed.length > 0) {
    log(laneConfig, `Phát hiện ${unpushed.length} vé đã đóng local nhưng chưa có trên remote origin/main!`);
    cycleResults.eventsDetected.push('dong-chua-day');

    for (const t of unpushed) {
      let rescueResult = null;
      if (laneConfig.git.enable_self_rescue && options.enableSelfRescue !== false) {
        rescueResult = attemptSafeSelfRescue(laneConfig, options);
        cycleResults.selfRescue = rescueResult;
      }

      const now = Date.now();
      const lastSent = runtimeState.lastNudgeTime[`dong-chua-day-${t.ma_ve}`] || 0;
      if (now - lastSent > cooldownMs || options.forceNudge) {
        t.selfRescue = rescueResult;
        const nudge = writeNudgeFile(laneConfig, 'dong-chua-day', t);
        cycleResults.nudgesCreated.push(nudge);
        runtimeState.lastNudgeTime[`dong-chua-day-${t.ma_ve}`] = now;
        if (options.autoPush) {
          pushNudgeToRepo(laneConfig, nudge.relPath);
        }
      }
    }
  }

  // 4. Kiểm tra hàng đợi cạn (Event b)
  const queueStatus = checkQueueStatus(laneConfig, options);
  log(laneConfig, `Trạng thái hàng đợi: active=${queueStatus.activeCount}, queued=${queueStatus.queuedCount}, pending=${queueStatus.pendingNewTickets}, isDry=${queueStatus.isDry}`);

  if (queueStatus.isDry) {
    cycleResults.eventsDetected.push('hang-can');
    const now = Date.now();
    const lastSent = runtimeState.lastNudgeTime['hang-can'] || 0;
    if (now - lastSent > cooldownMs || options.forceNudge) {
      const nudge = writeNudgeFile(laneConfig, 'hang-can', queueStatus);
      cycleResults.nudgesCreated.push(nudge);
      if (options.autoPush) {
        pushNudgeToRepo(laneConfig, nudge.relPath);
      }
    } else {
      log(laneConfig, '[BỎ QUA GIỤC] Sự kiện hang-can đang trong thời gian cooldown.');
    }
  }

  // 5. TÍN HIỆU SUPABASE (a): Kiểm tra vé CLAIMED quá hạn lease mà chưa xong
  let expiredTickets = [];
  try {
    expiredTickets = await checkClaimedExpiredLeases(laneConfig, options);
  } catch (err) {
    log(laneConfig, `[LỖI] checkClaimedExpiredLeases: ${err.message}`);
  }
  if (expiredTickets.length > 0) {
    log(laneConfig, `Phát hiện ${expiredTickets.length} vé CLAIMED quá hạn lease trên Supabase!`);
    cycleResults.eventsDetected.push('ve-claimed-qua-han-lease');
    for (const t of expiredTickets) {
      const now = Date.now();
      const lastSent = runtimeState.lastNudgeTime[`ve-claimed-qua-han-lease-${t.ticket_id}`] || 0;
      if (now - lastSent > cooldownMs || options.forceNudge) {
        const nudge = writeNudgeFile(laneConfig, 've-claimed-qua-han-lease', t);
        cycleResults.nudgesCreated.push(nudge);
        runtimeState.lastNudgeTime[`ve-claimed-qua-han-lease-${t.ticket_id}`] = now;
        if (options.autoPush) {
          pushNudgeToRepo(laneConfig, nudge.relPath);
        }
      } else {
        log(laneConfig, `[BỎ QUA GIỤC] Vé ${t.ticket_id} quá hạn lease đang trong thời gian cooldown.`);
      }
    }
  }

  // 6. TÍN HIỆU SUPABASE (b): Kiểm tra hàng lỗi DLQ phình lên
  let dlqStatus = { isSwelling: false, dlqCount: 0, dlqTickets: [] };
  try {
    dlqStatus = await checkDlqStatus(laneConfig, options);
  } catch (err) {
    log(laneConfig, `[LỖI] checkDlqStatus: ${err.message}`);
  }
  if (dlqStatus.isSwelling) {
    log(laneConfig, `Cảnh báo: DLQ phình lên với ${dlqStatus.dlqCount} vé lỗi!`);
    cycleResults.eventsDetected.push('dlq-phinh-len');
    const now = Date.now();
    const lastSent = runtimeState.lastNudgeTime['dlq-phinh-len'] || 0;
    if (now - lastSent > cooldownMs || options.forceNudge) {
      const nudge = writeNudgeFile(laneConfig, 'dlq-phinh-len', dlqStatus);
      cycleResults.nudgesCreated.push(nudge);
      runtimeState.lastNudgeTime['dlq-phinh-len'] = now;
      if (options.autoPush) {
        pushNudgeToRepo(laneConfig, nudge.relPath);
      }
    } else {
      log(laneConfig, '[BỎ QUA GIỤC] Sự kiện dlq-phinh-len đang trong thời gian cooldown.');
    }
  }

  // 7. TÍN HIỆU SUPABASE (c): Kiểm tra lệch giữa bảng tickets và registry
  let discrepancyStatus = { hasDiscrepancy: false, discrepancyCount: 0, discrepancies: [] };
  try {
    discrepancyStatus = await checkTicketsRegistryDiscrepancy(laneConfig, options);
  } catch (err) {
    log(laneConfig, `[LỖI] checkTicketsRegistryDiscrepancy: ${err.message}`);
  }
  if (discrepancyStatus.hasDiscrepancy) {
    log(laneConfig, `Cảnh báo: Phát hiện ${discrepancyStatus.discrepancyCount} sai lệch giữa tickets và registry!`);
    cycleResults.eventsDetected.push('lech-tickets-registry');
    const now = Date.now();
    const lastSent = runtimeState.lastNudgeTime['lech-tickets-registry'] || 0;
    if (now - lastSent > cooldownMs || options.forceNudge) {
      const nudge = writeNudgeFile(laneConfig, 'lech-tickets-registry', discrepancyStatus);
      cycleResults.nudgesCreated.push(nudge);
      runtimeState.lastNudgeTime['lech-tickets-registry'] = now;
      if (options.autoPush) {
        pushNudgeToRepo(laneConfig, nudge.relPath);
      }
    } else {
      log(laneConfig, '[BỎ QUA GIỤC] Sự kiện lech-tickets-registry đang trong thời gian cooldown.');
    }
  }

  // 8. Ghi heartbeat định kỳ của watcher
  const hb = writeHeartbeat(laneConfig, {
    cycleSeconds: options.cycleSeconds || laneConfig.cycle_seconds,
    totalRegistry: queueStatus.totalClosed + queueStatus.activeCount + queueStatus.queuedCount,
    activeCount: queueStatus.activeCount,
    queuedCount: queueStatus.queuedCount,
    pendingNewTickets: queueStatus.pendingNewTickets,
    pickerAlive: pickerHealth.alive,
    pickerPid: pickerHealth.processId,
    pickerSilenceSec: pickerHealth.silenceSeconds,
    realqueueAlive: rqHealth.alive,
    realqueuePid: rqHealth.processId,
    realqueueSilenceSec: rqHealth.silenceSeconds,
    realqueueClaimedExpiredCount: expiredTickets.length,
    realqueueDlqCount: dlqStatus.dlqCount,
    realqueueDiscrepancyCount: discrepancyStatus.discrepancyCount
  });
  cycleResults.heartbeat = hb;

  // Cập nhật thống kê vào RealQueue heartbeat nếu có
  if (laneConfig.realqueue && laneConfig.realqueue.enabled && cycleResults.realqueueHeartbeat) {
    rqHealth.discrepancyCount = discrepancyStatus.discrepancyCount;
    rqHealth.claimedExpiredCount = expiredTickets.length;
    rqHealth.dlqCount = dlqStatus.dlqCount;
    writeRealqueueHeartbeat(laneConfig, rqHealth);
  }

  log(laneConfig, `================ HOÀN TẤT CHU KỲ QUÉT LÀN: ${laneConfig.lane_id} ================`);
  return cycleResults;
}

// =============================================================================
// 13. Quét Đa Làn An Toàn (Multi-Lane Batch Scan with Isolation)
//     Bất biến: Một làn sập không kéo sập các làn khác
// =============================================================================
async function scanAllLanes(lanesConfigList, options = {}) {
  const allResults = [];
  for (const cfg of lanesConfigList) {
    try {
      const res = await scanLaneCycle(cfg, options);
      allResults.push(res);
    } catch (err) {
      // Cách ly lỗi tuyệt đối: Ghi nhận lỗi và tiếp tục các làn còn lại
      console.error(`[LỖI CÁCH LY] Làn ${cfg.lane_id} gặp ngoại lệ nhưng không làm gián đoạn hệ thống: ${err.message}`);
      allResults.push({
        lane_id: cfg.lane_id,
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }
  return allResults;
}

// =============================================================================
// 14. CLI Runner
// =============================================================================
async function main() {
  const args = process.argv.slice(2);
  const isOnce = args.includes('--once');
  const autoPush = args.includes('--push');
  const forceNudge = args.includes('--force');

  // Tìm tệp cấu hình qua --config=<path> hoặc --lane=<id>
  let configPath = null;
  const configArg = args.find(a => a.startsWith('--config='));
  if (configArg) {
    configPath = configArg.split('=')[1];
  }

  const laneArg = args.find(a => a.startsWith('--lane='));
  let laneId = null;
  if (laneArg) {
    laneId = laneArg.split('=')[1];
  }

  const lanesDir = path.resolve(__dirname, 'lanes');
  let lanesToRun = [];

  if (configPath) {
    lanesToRun.push(loadLaneConfigFile(configPath));
  } else if (laneId) {
    const laneFile = path.join(lanesDir, `${laneId}.lane.json`);
    if (fs.existsSync(laneFile)) {
      lanesToRun.push(loadLaneConfigFile(laneFile));
    } else {
      console.error(`[LỖI] Không tìm thấy cấu hình làn tại: ${laneFile}`);
      process.exit(1);
    }
  } else if (args.includes('--all')) {
    if (fs.existsSync(lanesDir)) {
      const files = fs.readdirSync(lanesDir).filter(f => f.endsWith('.lane.json') && !f.startsWith('_'));
      for (const f of files) {
        lanesToRun.push(loadLaneConfigFile(path.join(lanesDir, f)));
      }
    }
  } else {
    // Mặc định nạp desktop.lane.json hoặc _mau.lane.json
    const defaultDesktop = path.join(lanesDir, 'desktop.lane.json');
    if (fs.existsSync(defaultDesktop)) {
      lanesToRun.push(loadLaneConfigFile(defaultDesktop));
    } else {
      console.log('Chưa chỉ định cấu hình làn. Sử dụng cấu hình mặc định cục bộ.');
      lanesToRun.push(resolveLaneConfig({ lane_id: 'lan-desktop' }));
    }
  }

  if (lanesToRun.length === 0) {
    console.error('[LỖI] Không có làn nào được chỉ định để chạy.');
    process.exit(1);
  }

  console.log(`Đã nạp ${lanesToRun.length} làn: ${lanesToRun.map(l => l.lane_id).join(', ')}`);

  const runOptions = {
    autoPush,
    forceNudge,
    forceHeartbeat: true,
    ignoreGracePeriod: args.includes('--ignore-grace')
  };

  if (isOnce) {
    const results = await scanAllLanes(lanesToRun, runOptions);
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  // Chế độ DAEMON
  await scanAllLanes(lanesToRun, { ...runOptions, autoPush: true });

  // Thiết lập chu kỳ quét cho từng làn độc lập
  for (const cfg of lanesToRun) {
    const intervalMs = cfg.cycle_seconds * 1000;
    setInterval(async () => {
      try {
        await scanLaneCycle(cfg, { autoPush: true });
      } catch (e) {
        log(cfg, `[LỖI CHU KỲ] ${e.message}`);
      }
    }, intervalMs);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[LỖI KHỞI ĐỘNG] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  resolveLaneConfig,
  loadLaneConfigFile,
  ensureLaneDirs,
  getLaneRuntimeState,
  countDispatchedNudges,
  checkPickerHealth,
  checkRealqueueHealth,
  checkUnpushedTickets,
  checkQueueStatus,
  checkClaimedExpiredLeases,
  checkDlqStatus,
  checkTicketsRegistryDiscrepancy,
  attemptSafeSelfRescue,
  writeNudgeFile,
  writeHeartbeat,
  writeRealqueueHeartbeat,
  pushNudgeToRepo,
  scanLaneCycle,
  scanAllLanes,
  SupabaseQueueReader
};
