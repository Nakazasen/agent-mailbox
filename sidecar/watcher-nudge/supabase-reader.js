/**
 * supabase-reader.js — Module đọc CSDL Supabase / PostgREST cho Thợ Canh Chuẩn Đa Làn
 * Repository: Nakazasen/agent-mailbox
 * Thư mục: sidecar/watcher-nudge/
 * 
 * Vé thực thi: DESKTOP-HOME-WATCHER-SUPABASE-01
 * Mã trace: TRC-20261102-130223-x3v77o-DESKTOP-HOME-WATCHER-SUPABASE-01
 * 
 * Chức năng:
 *  1. Đọc an toàn khóa anon và URL Supabase qua biến môi trường hoặc Windows Registry HKCU\Environment.
 *  2. Truy vấn PostgREST HTTPS Port 443 tiêu chuẩn không phụ thuộc thư viện ngoài (sử dụng native fetch).
 *  3. Cung cấp 3 phương thức giám sát tín hiệu:
 *     (a) getClaimedExpiredTickets: Phát hiện vé CLAIMED quá hạn lease mà chưa hoàn thành.
 *     (b) getUnresolvedDlqTickets: Phát hiện hàng lỗi DLQ (Dead-Letter Queue) phình lên.
 *     (c) checkTicketsRegistryDiscrepancy: Phát hiện sai lệch trạng thái giữa bảng tickets và registry.json.
 *  4. Hỗ trợ cơ chế Mock / In-Memory Queue Provider phục vụ kiểm thử giả lập không cần kết nối mạng.
 */

'use strict';

const { execSync } = require('child_process');

/**
 * Đọc biến môi trường an toàn: process.env trước, sau đó fallback tới Windows Registry HKCU\Environment
 * @param {string} key
 * @returns {string|null}
 */
function getEnv(key) {
  if (process.env[key] && process.env[key].trim()) {
    return process.env[key].trim();
  }
  if (process.platform === 'win32') {
    try {
      const cmd = `reg query "HKCU\\Environment" /v ${key}`;
      const output = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const match = output.match(new RegExp(`${key}\\s+REG_\\w+\\s+(.+)`, 'i'));
      if (match && match[1]) {
        const val = match[1].trim();
        process.env[key] = val;
        return val;
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Lấy URL Supabase từ cấu hình làn hoặc môi trường
 * @param {object} [config]
 * @returns {string|null}
 */
function resolveSupabaseUrl(config = {}) {
  return (config && config.supabase_url) || getEnv('AIOS_REALQUEUE_URL') || null;
}

/**
 * Lấy API Key Supabase từ cấu hình làn hoặc môi trường
 * @param {object} [config]
 * @returns {string|null}
 */
function resolveSupabaseKey(config = {}) {
  return (config && config.supabase_key) || getEnv('AIOS_REALQUEUE_KEY') || null;
}

class SupabaseQueueReader {
  /**
   * @param {object} [options]
   * @param {string} [options.url]
   * @param {string} [options.key]
   * @param {Function} [options.fetchFn]
   */
  constructor(options = {}) {
    this.url = (options.url || resolveSupabaseUrl(options) || '').replace(/\/+$/, '');
    this.key = options.key || resolveSupabaseKey(options) || '';
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.clockOffset = 0; // Độ lệch ms giữa client cục bộ và server Supabase
  }

  /**
   * Kiểm tra xem cấu hình kết nối có hợp lệ không
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.url && this.key);
  }

  /**
   * Đồng bộ độ lệch đồng hồ từ HTTP header 'Date'
   * @param {Response} res 
   */
  syncClock(res) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') {
        const serverDate = res.headers.get('date');
        if (serverDate) {
          this.clockOffset = new Date(serverDate).getTime() - Date.now();
        }
      }
    } catch (e) {}
  }

  /**
   * Lấy thời gian đồng bộ với máy chủ
   * @returns {Date}
   */
  getServerTime() {
    return new Date(Date.now() + (this.clockOffset || 0));
  }

  /**
   * Tiêu đề HTTP chuẩn gọi PostgREST
   * @param {object} [extra]
   * @returns {object}
   */
  getHeaders(extra = {}) {
    return {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  /**
   * Kiểm tra kết nối HTTPS tới Supabase
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async testConnection() {
    if (!this.isConfigured()) {
      return { success: false, message: 'Chưa cấu hình AIOS_REALQUEUE_URL hoặc AIOS_REALQUEUE_KEY' };
    }
    try {
      const endpoint = `${this.url}/rest/v1/tickets?select=ticket_id&limit=1`;
      const res = await this.fetchFn(endpoint, {
        method: 'GET',
        headers: this.getHeaders()
      });
      this.syncClock(res);
      if (!res.ok) {
        const errText = await res.text();
        return { success: false, message: `HTTP ${res.status}: ${errText}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  /**
   * TÍN HIỆU (a): Phát hiện các vé bị CLAIMED quá hạn lease mà chưa xong
   * @param {object} [params]
   * @param {string} [params.lane] Lọc theo làn đích (ví dụ: 'lan-desktop', 'youtube')
   * @param {number} [params.thresholdSeconds] Ngưỡng trễ sau khi lease hết hạn (giây, mặc định 0)
   * @param {Date|string} [params.now] Mốc thời gian đối chiếu (dùng cho kiểm thử)
   * @returns {Promise<Array<object>>}
   */
  async getClaimedExpiredTickets(params = {}) {
    if (!this.isConfigured()) {
      return [];
    }
    const lane = params.lane || null;
    const thresholdSec = Number(params.thresholdSeconds) || 0;
    const refTime = params.now ? new Date(params.now) : this.getServerTime();
    const refMs = refTime.getTime();

    const endpoint = `${this.url}/rest/v1/tickets?select=ticket_id,trace_id,target_lane,state,worker_id,claimed_at,lease_expires_at,last_heartbeat_at,retry_count,updated_at&state=in.(CLAIMED,EXECUTING)`;
    const res = await this.fetchFn(endpoint, {
      method: 'GET',
      headers: this.getHeaders()
    });
    this.syncClock(res);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Lỗi truy vấn vé CLAIMED: HTTP ${res.status}: ${errText}`);
    }

    const tickets = await res.json();
    if (!Array.isArray(tickets)) {
      return [];
    }

    const expired = [];
    for (const t of tickets) {
      // Lọc làn: Khớp với lane cụ thể, 'any' hoặc không xác định
      if (lane && t.target_lane && t.target_lane !== lane && t.target_lane !== 'any') {
        continue;
      }

      if (!t.lease_expires_at) {
        continue;
      }

      const leaseMs = new Date(t.lease_expires_at).getTime();
      const expiredMs = refMs - leaseMs;
      const expiredSec = Math.floor(expiredMs / 1000);

      // Quá hạn nếu chênh lệch vượt ngưỡng cấu hình
      if (expiredSec >= thresholdSec) {
        expired.push({
          ticket_id: t.ticket_id,
          ma_ve: t.ticket_id,
          trace_id: t.trace_id,
          target_lane: t.target_lane,
          state: t.state,
          worker_id: t.worker_id,
          claimed_at: t.claimed_at,
          lease_expires_at: t.lease_expires_at,
          last_heartbeat_at: t.last_heartbeat_at,
          expired_seconds: Math.max(0, expiredSec),
          threshold_seconds: thresholdSec,
          retry_count: t.retry_count || 0
        });
      }
    }

    return expired;
  }

  /**
   * TÍN HIỆU (b): Giám sát hàng lỗi DLQ phình lên (Unresolved Dead-Letter Queue records)
   * @param {object} [params]
   * @param {string} [params.lane] Lọc theo làn thất bại (failed_lane)
   * @param {number} [params.threshold] Ngưỡng số lượng vé trong DLQ để kích hoạt cảnh báo (mặc định 0)
   * @returns {Promise<{dlqCount: number, dlqTickets: Array<object>, threshold: number}>}
   */
  async getUnresolvedDlqTickets(params = {}) {
    if (!this.isConfigured()) {
      return { dlqCount: 0, dlqTickets: [], threshold: 0 };
    }
    const lane = params.lane || null;
    const threshold = Number(params.threshold) || 0;

    const endpoint = `${this.url}/rest/v1/ticket_dlq?select=dlq_id,ticket_id,trace_id,failed_lane,total_retries,final_error,isolated_at,resolved_at&resolved_at=is.null`;
    const res = await this.fetchFn(endpoint, {
      method: 'GET',
      headers: this.getHeaders()
    });
    this.syncClock(res);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Lỗi truy vấn ticket_dlq: HTTP ${res.status}: ${errText}`);
    }

    const records = await res.json();
    if (!Array.isArray(records)) {
      return { dlqCount: 0, dlqTickets: [], threshold };
    }

    const filtered = records.filter(r => {
      if (!lane) return true;
      return !r.failed_lane || r.failed_lane === lane || r.failed_lane === 'any';
    });

    return {
      dlqCount: filtered.length,
      dlqTickets: filtered,
      threshold
    };
  }

  /**
   * TÍN HIỆU (c): Đối chiếu phát hiện sai lệch giữa bảng tickets và registry.json
   * @param {object} params
   * @param {string} [params.lane] Làn cần đối chiếu
   * @param {Array<object>} params.registry Danh sách các bản ghi từ registry.json
   * @param {Array<object>} [params.tickets] Tùy chọn truyền trước danh sách tickets (cho test mock)
   * @returns {Promise<{hasDiscrepancy: boolean, discrepancyCount: number, discrepancies: Array<object>}>}
   */
  async checkTicketsRegistryDiscrepancy(params = {}) {
    const lane = params.lane || null;
    const registry = Array.isArray(params.registry) ? params.registry : [];
    let tickets = params.tickets;

    if (!tickets) {
      if (!this.isConfigured()) {
        return { hasDiscrepancy: false, discrepancyCount: 0, discrepancies: [] };
      }
      const endpoint = `${this.url}/rest/v1/tickets?select=ticket_id,trace_id,target_lane,state,worker_id,claimed_at,completed_at,updated_at`;
      const res = await this.fetchFn(endpoint, {
        method: 'GET',
        headers: this.getHeaders()
      });
      this.syncClock(res);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Lỗi truy vấn tickets để đối chiếu registry: HTTP ${res.status}: ${errText}`);
      }

      tickets = await res.json();
    }

    if (!Array.isArray(tickets)) {
      tickets = [];
    }

    // Lọc vé Supabase theo làn nếu cần
    const relevantTickets = tickets.filter(t => {
      if (!lane) return true;
      return !t.target_lane || t.target_lane === lane || t.target_lane === 'any';
    });

    const registryMap = new Map();
    for (const r of registry) {
      if (r && r.ma_ve) {
        registryMap.set(r.ma_ve, r);
      }
    }

    const ticketsMap = new Map();
    for (const t of relevantTickets) {
      if (t && t.ticket_id) {
        ticketsMap.set(t.ticket_id, t);
      }
    }

    const discrepancies = [];
    const processedTicketIds = new Set();

    // 1. Kiểm tra từ phía Supabase tickets sang Registry
    for (const t of relevantTickets) {
      processedTicketIds.add(t.ticket_id);
      const regEntry = registryMap.get(t.ticket_id);

      // (a) Vé đang CLAIMED hoặc EXECUTING trong Supabase
      if (t.state === 'CLAIMED' || t.state === 'EXECUTING') {
        if (!regEntry) {
          discrepancies.push({
            ticket_id: t.ticket_id,
            trace_id: t.trace_id,
            type: 'CLAIMED_MISSING_IN_REGISTRY',
            supabase_state: t.state,
            registry_state: 'KHÔNG_CÓ_TRONG_REGISTRY',
            detail: `Vé ${t.ticket_id} đang ${t.state} trong CSDL Supabase nhưng chưa được ghi nhận vào registry.json.`
          });
        } else if (regEntry.trang_thai === 'da-dong') {
          discrepancies.push({
            ticket_id: t.ticket_id,
            trace_id: t.trace_id,
            type: 'REGISTRY_CLOSED_BUT_SUPABASE_NOT_COMPLETED',
            supabase_state: t.state,
            registry_state: regEntry.trang_thai,
            detail: `Registry cục bộ đã đóng vé '${t.ticket_id}' (da-dong), nhưng CSDL Supabase vẫn ở trạng thái '${t.state}' (chưa completeTicket).`
          });
        } else if (regEntry.trang_thai !== 'dang-chay') {
          discrepancies.push({
            ticket_id: t.ticket_id,
            trace_id: t.trace_id,
            type: 'CLAIMED_BUT_NOT_RUNNING_IN_REGISTRY',
            supabase_state: t.state,
            registry_state: regEntry.trang_thai,
            detail: `Vé ${t.ticket_id} đang ${t.state} trong CSDL Supabase nhưng registry lại ghi nhận trạng thái '${regEntry.trang_thai}'.`
          });
        }
      }

      // (b) Vé đã COMPLETED trong Supabase nhưng registry vẫn còn dang-chay
      if (t.state === 'COMPLETED' && regEntry && regEntry.trang_thai === 'dang-chay') {
        discrepancies.push({
          ticket_id: t.ticket_id,
          trace_id: t.trace_id,
          type: 'COMPLETED_IN_SUPABASE_BUT_RUNNING_IN_REGISTRY',
          supabase_state: t.state,
          registry_state: regEntry.trang_thai,
          detail: `Vé ${t.ticket_id} đã COMPLETED trên CSDL Supabase nhưng sổ cái registry cục bộ vẫn đang để 'dang-chay'.`
        });
      }
    }

    // 2. Kiểm tra từ phía Registry sang Supabase tickets (chỉ các vé chưa được xử lý ở vòng 1)
    for (const reg of registry) {
      if (!reg || !reg.ma_ve || processedTicketIds.has(reg.ma_ve)) {
        continue;
      }

      // Nếu vé đang chạy trong registry nhưng hoàn toàn không có trong danh sách Supabase tickets
      if (reg.trang_thai === 'dang-chay') {
        discrepancies.push({
          ticket_id: reg.ma_ve,
          trace_id: reg.ma_trace,
          type: 'REGISTRY_RUNNING_BUT_MISSING_IN_SUPABASE',
          supabase_state: 'KHÔNG_CÓ_TRÊN_CSDL',
          registry_state: reg.trang_thai,
          detail: `Registry cục bộ ghi nhận '${reg.ma_ve}' đang chạy, nhưng không tìm thấy vé trên CSDL Supabase.`
        });
      }
    }

    return {
      hasDiscrepancy: discrepancies.length > 0,
      discrepancyCount: discrepancies.length,
      discrepancies
    };
  }
}

module.exports = {
  getEnv,
  resolveSupabaseUrl,
  resolveSupabaseKey,
  SupabaseQueueReader
};
