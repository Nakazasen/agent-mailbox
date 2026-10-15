/**
 * picker.js — Sidecar nhặt vé cho Antigravity Desktop (Làn desktop)
 * Thuộc nhiệm vụ AGY-PAR-001 & DESKTOP-PICKER-AUTOPULL-HOME & DESKTOP-PROTECT-REPORT-PUSH-FIX-HOME & DESKTOP-PICKER-MODEL-FOLLOW-UI-HOME.
 *
 * Tính năng chính:
 * 1. Tự động đồng bộ clone kho điều phối (git pull) trước mỗi vòng quét.
 * 2. Tự động đẩy registry.json, picker.log VÀ toàn bộ tệp kết quả (ket-qua/) lên kho điều phối khi trạng thái thay đổi.
 * 3. Trí nhớ chống trùng Authoritative độc lập nằm ngoài cây git (registry-authoritative.json),
 *    không bao giờ bị git ghi đè hay mất trạng thái khi pull/rebase/stash.
 * 4. Kiểm chứng độc lập 2 lớp:
 *    - Lớp 1: Sự tồn tại của tệp kết quả ket-qua/<MÃ VÉ>.md là bằng chứng tuyệt đối vé đã đóng.
 *    - Lớp 2: Kiểm tra registry authoritative (dang-chay, da-dong, cho-slot).
 * 5. Duy trì nghiêm ngặt các quy ước:
 *    - Ghi trước khi phát (trang_thai: dang-chay).
 *    - Mỗi vé một hội thoại mới.
 *    - Trần 3 cửa sổ đồng thời (vé thứ 4 trở đi vào cho-slot; riêng PC0575 giới hạn trần 2).
 *    - Tạo tệp prompt riêng biệt trong prompts/.
 * 6. Tự động đẩy kết quả phiên lên kho khi vé hoàn thành, bảo toàn toàn bộ bằng chứng (ảnh, log, json, md).
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const REPO_DIR = process.env.AIOS_DIEU_PHOI_DIR || 'D:/Sandbox/aios-dieu-phoi';

// Hỗ trợ cấu hình qua env hoặc tự động nhận diện máy công ty PC0575 vs máy nhà
function resolveMailboxDir() {
  if (process.env.AIOS_MAILBOX_DIR) {
    return process.env.AIOS_MAILBOX_DIR;
  }
  const pc0575Dir = path.join(REPO_DIR, 'hop-thu', 'lan-desktop-pc0575');
  if (process.env.COMPUTERNAME === 'KDTVN-PC0575' && fs.existsSync(pc0575Dir)) {
    return pc0575Dir;
  }
  return path.join(REPO_DIR, 'hop-thu', 'lan-desktop');
}

const MAILBOX_DIR = resolveMailboxDir();
const KET_QUA_DIR = path.join(MAILBOX_DIR, 'ket-qua');
const PROMPTS_DIR = path.join(MAILBOX_DIR, 'prompts');
const REPO_REGISTRY_FILE = path.join(MAILBOX_DIR, 'registry.json');
const LOG_FILE = path.join(MAILBOX_DIR, 'picker.log');

// Trí nhớ chống trùng độc lập nằm ngoài cây git của clone (tại thư mục cấu hình sidecar)
const SIDECAR_DIR = __dirname;
const AUTH_REGISTRY_FILE = path.join(SIDECAR_DIR, 'registry-authoritative.json');

const MAX_CONCURRENT = (process.env.COMPUTERNAME === 'KDTVN-PC0575') ? 2 : 3;
const POLL_INTERVAL_MS = 5000; // 5 giây một vòng quét

// Đảm bảo các thư mục tồn tại
[MAILBOX_DIR, KET_QUA_DIR, PROMPTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function getRelativeRepoPaths() {
  return {
    relMailboxDir: path.relative(REPO_DIR, MAILBOX_DIR).replace(/\\/g, '/'),
    relRegistryFile: path.relative(REPO_DIR, REPO_REGISTRY_FILE).replace(/\\/g, '/'),
    relLogFile: path.relative(REPO_DIR, LOG_FILE).replace(/\\/g, '/'),
    relKetQuaDir: path.relative(REPO_DIR, KET_QUA_DIR).replace(/\\/g, '/'),
    relPromptsDir: path.relative(REPO_DIR, PROMPTS_DIR).replace(/\\/g, '/'),
  };
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch (e) {
    // Ignore logging errors
  }
}

// Khám phá thông tin xác thực từ tiến trình language_server nếu chưa có sẵn trong env
function discoverCredentials() {
  try {
    const cmd = `powershell -NoProfile -Command "
      $ls = Get-CimInstance Win32_Process -Filter \\"name = 'language_server.exe'\\" | Select-Object -First 1
      if (!$ls) { exit 1 }
      $token = ''
      if ($ls.CommandLine -match '--csrf_token\\s+([^\\s]+)') { $token = $matches[1] }
      $conn = Get-NetTCPConnection -OwningProcess $ls.ProcessId -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | Sort-Object LocalPort -Descending | Select-Object -First 1
      if (!$conn -or !$token) { exit 1 }
      Write-Output \\"$($conn.LocalPort)|$token|$($ls.ExecutablePath)\\"
    "`;
    const out = execSync(cmd, { encoding: 'utf-8' }).trim();
    const parts = out.split('|');
    if (parts.length >= 3) {
      return { port: parts[0].trim(), token: parts[1].trim(), exe: parts[2].trim() };
    }
  } catch (err) {
    // Không tìm thấy
  }
  return null;
}

function loadRegistry() {
  let authData = [];
  if (fs.existsSync(AUTH_REGISTRY_FILE)) {
    try {
      const raw = fs.readFileSync(AUTH_REGISTRY_FILE, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          authData = parsed;
        }
      }
    } catch (err) {
      log(`[CẢNH BÁO] Không đọc được registry-authoritative.json: ${err.message}.`);
    }
  } else if (fs.existsSync(REPO_REGISTRY_FILE)) {
    // Khởi tạo lần đầu từ repo registry nếu chưa có authoritative file
    try {
      const raw = fs.readFileSync(REPO_REGISTRY_FILE, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          authData = parsed;
          saveRegistry(authData);
        }
      }
    } catch (err) {
      log(`[CẢNH BÁO] Không đọc được repo registry.json: ${err.message}.`);
    }
  }

  // Hợp nhất an toàn với REPO_REGISTRY_FILE (nếu repo có mục mới mà authoritative chưa có)
  if (fs.existsSync(REPO_REGISTRY_FILE)) {
    try {
      const rawRepo = fs.readFileSync(REPO_REGISTRY_FILE, 'utf-8').trim();
      if (rawRepo) {
        const repoData = JSON.parse(rawRepo);
        if (Array.isArray(repoData)) {
          let merged = false;
          for (const item of repoData) {
            const existing = authData.find(r => r.ma_ve === item.ma_ve);
            if (!existing) {
              authData.push(item);
              merged = true;
            }
          }
          if (merged) {
            saveRegistry(authData);
          }
        }
      }
    } catch (err) {
      // Bỏ qua lỗi đọc repo registry
    }
  }

  return authData;
}

function saveRegistry(registry) {
  try {
    const content = JSON.stringify(registry, null, 2);
    // 1. Lưu vào registry authoritative (ngoài cây git)
    fs.writeFileSync(AUTH_REGISTRY_FILE, content, 'utf-8');
    // 2. Phản chiếu vào repo registry (trong cây git)
    fs.writeFileSync(REPO_REGISTRY_FILE, content, 'utf-8');
  } catch (err) {
    log(`[LỖI] Không ghi được registry: ${err.message}`);
  }
}

function parseTicket(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const maVeMatch = content.match(/^[ \t]*Ma ve:[ \t]*([^\r\n]+)/m);
    const trangThaiMatch = content.match(/^[ \t]*Trang thai:[ \t]*([^\r\n]+)/m);
    if (maVeMatch && trangThaiMatch) {
      return {
        maVe: maVeMatch[1].trim(),
        trangThai: trangThaiMatch[1].trim().toLowerCase(),
        rawContent: content,
        fileName: path.basename(filePath),
        filePath: filePath
      };
    }
  } catch (err) {
    log(`[LỖI] Không đọc được tệp vé ${filePath}: ${err.message}`);
  }
  return null;
}

function callAgentApiNewConversation(promptText, title) {
  let exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  let env = { ...process.env };

  if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN || !exe) {
    const creds = discoverCredentials();
    if (creds) {
      if (!env.ANTIGRAVITY_LS_ADDRESS) env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${creds.port}`;
      if (!env.ANTIGRAVITY_CSRF_TOKEN) env.ANTIGRAVITY_CSRF_TOKEN = creds.token;
      if (!exe) exe = creds.exe;
    }
  }

  const binary = exe || 'agentapi';

  const args = exe
    ? ['agentapi', 'new-conversation', `--title=${title}`, promptText]
    : ['new-conversation', `--title=${title}`, promptText];

  const out = execFileSync(binary, args, {
    encoding: 'utf-8',
    env,
    windowsHide: true,
    timeout: 30000
  });

  const jsonLine = String(out || '')
    .trim()
    .split(/\r?\n/)
    .find(line => line.trim().startsWith('{')) || out;
  const parsed = JSON.parse(jsonLine);
  if (parsed.response && parsed.response.newConversation) {
    return parsed.response.newConversation;
  }
  return parsed;
}

// Đồng bộ clone kho điều phối trước mỗi vòng quét
function syncRemote() {
  try {
    const { relRegistryFile, relLogFile, relKetQuaDir } = getRelativeRepoPaths();

    // 1. Fetch remote changes (không ảnh hưởng working directory)
    execSync('git fetch origin main', {
      cwd: REPO_DIR,
      stdio: 'pipe',
      timeout: 20000
    });

    const localHead = execSync('git rev-parse HEAD', { cwd: REPO_DIR, encoding: 'utf-8', timeout: 5000 }).trim();
    const remoteHead = execSync('git rev-parse origin/main', { cwd: REPO_DIR, encoding: 'utf-8', timeout: 5000 }).trim();

    if (localHead === remoteHead) {
      log(`[ĐỒNG BỘ KHO] Clone đã khớp với kho điều phối (HEAD: ${localHead.slice(0, 7)}).`);
      return true;
    }

    // Kiểm tra xem remote có commit mới chưa được merge vào local không
    const behindCount = parseInt(
      execSync('git rev-list HEAD..origin/main --count', { cwd: REPO_DIR, encoding: 'utf-8', timeout: 5000 }).trim(),
      10
    );

    if (behindCount > 0) {
      log(`[ĐỒNG BỘ KHO] Phát hiện ${behindCount} commit mới trên kho điều phối. Bắt đầu kéo về...`);

      // Tự commit thay đổi cục bộ ở registry.json, picker.log VÀ thư mục kết quả trước khi kéo để tránh kẹt và bảo toàn tệp kết quả
      execSync(`git add "${relRegistryFile}" "${relLogFile}" "${relKetQuaDir}"`, {
        cwd: REPO_DIR,
        stdio: 'pipe',
        timeout: 15000
      });

      let hasStaged = false;
      try {
        execSync('git diff --cached --quiet', { cwd: REPO_DIR, stdio: 'pipe', timeout: 5000 });
      } catch (e) {
        hasStaged = true;
      }

      if (hasStaged) {
        execFileSync('git', ['commit', '-m', 'chore(picker): auto-save desktop lane status and results before merge [skip ci]'], {
          cwd: REPO_DIR,
          stdio: 'pipe',
          timeout: 10000
        });
      }

      // Kéo bằng git pull --no-rebase --no-edit origin main
      try {
        const pullOut = execSync('git pull --no-rebase --no-edit origin main', {
          cwd: REPO_DIR,
          encoding: 'utf-8',
          timeout: 25000
        });
        const newHead = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf-8', timeout: 5000 }).trim();
        log(`[ĐỒNG BỘ KHO] Đã kéo thành công bản mới từ kho điều phối (HEAD: ${newHead}). Kết quả: ${pullOut.trim()}`);
      } catch (mergeErr) {
        log(`[CẢNH BÁO ĐỒNG BỘ] Xung đột khi kéo, giải quyết bằng bản local của làn desktop...`);
        try {
          execSync(`git checkout --ours "${relRegistryFile}" "${relLogFile}"`, { cwd: REPO_DIR, stdio: 'pipe' });
          execSync(`git add "${relRegistryFile}" "${relLogFile}" "${relKetQuaDir}"`, { cwd: REPO_DIR, stdio: 'pipe' });
          execSync('git commit -m "chore(picker): resolve merge conflict using local desktop state [skip ci]"', { cwd: REPO_DIR, stdio: 'pipe' });
        } catch (resolveErr) {
          log(`[CẢNH BÁO ĐỒNG BỘ] Không thể tự giải quyết xung đột: ${resolveErr.message}`);
        }
      }
    } else {
      log(`[ĐỒNG BỘ KHO] Local đang dẫn trước origin/main (${localHead.slice(0, 7)}), không có commit mới từ kho.`);
    }

    return true;
  } catch (err) {
    log(`[CẢNH BÁO ĐỒNG BỘ] Lỗi khi đồng bộ từ kho: ${err.message}`);
    return false;
  }
}

// Tự động đẩy registry.json, picker.log VÀ toàn bộ tệp kết quả trong ket-qua/ lên kho điều phối khi có thay đổi trạng thái
function pushStatus(action) {
  try {
    // Đảm bảo repo registry phản chiếu chính xác authoritative registry
    const registry = loadRegistry();
    fs.writeFileSync(REPO_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');

    const { relRegistryFile, relLogFile, relKetQuaDir, relPromptsDir } = getRelativeRepoPaths();

    // Luôn stage registry.json, picker.log và toàn bộ thư mục ket-qua/ của làn
    const stageItems = [relRegistryFile, relLogFile, relKetQuaDir];
    if (action.startsWith('phat-ve-')) {
      stageItems.push(relPromptsDir);
    }
    const stageArg = stageItems.map(p => `"${p}"`).join(' ');

    execSync(`git add ${stageArg}`, {
      cwd: REPO_DIR,
      stdio: 'pipe',
      timeout: 15000
    });

    let hasDiff = false;
    try {
      execSync('git diff --cached --quiet', { cwd: REPO_DIR, stdio: 'pipe', timeout: 5000 });
    } catch (e) {
      hasDiff = true;
    }

    if (hasDiff) {
      const isClosing = action.startsWith('dong-ve-');
      const commitMsg = isClosing
        ? `feat(picker): cap nhat ket qua va dong ve [${action}]`
        : `chore(picker): cap nhat trang thai [${action}]`;
      execFileSync('git', ['commit', '-m', commitMsg], {
        cwd: REPO_DIR,
        stdio: 'pipe',
        timeout: 10000
      });
    }

    // Push lên origin main
    try {
      execFileSync('git', ['push', 'origin', 'main'], {
        cwd: REPO_DIR,
        stdio: 'pipe',
        timeout: 25000
      });
      log(`[TỰ ĐẨY TRẠNG THÁI] Đã đẩy trạng thái và kết quả lên kho thành công (${action}).`);
    } catch (pushErr) {
      log(`[TỰ ĐẨY TRẠNG THÁI] Push gặp lỗi, kéo rebase và đẩy lại: ${pushErr.message}`);
      execSync('git pull --rebase origin main', { cwd: REPO_DIR, stdio: 'pipe', timeout: 25000 });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_DIR, stdio: 'pipe', timeout: 25000 });
      log(`[TỰ ĐẨY TRẠNG THÁI] Đã rebase và đẩy trạng thái/kết quả lên kho thành công (${action}).`);
    }
  } catch (err) {
    log(`[CẢNH BÁO TỰ ĐẨY] Không thể đẩy trạng thái (${action}): ${err.message}`);
  }
}

function dispatchTicket(ticket, registry) {
  const maVe = ticket.maVe;
  log(`[CHUẨN BỊ PHÁT VÉ] Bắt đầu phát vé ${maVe}...`);

  // 1. LUẬT: GHI TRƯỚC KHI PHÁT
  let entry = registry.find(r => r.ma_ve === maVe);
  if (!entry) {
    entry = {
      ma_ve: maVe,
      ma_hoi_thoai: null,
      trang_thai: 'dang-chay',
      thoi_diem_tao: new Date().toISOString(),
      thoi_diem_dong: null,
      tep_ve: ticket.fileName
    };
    registry.push(entry);
  } else {
    entry.trang_thai = 'dang-chay';
    entry.thoi_diem_tao = new Date().toISOString();
    entry.thoi_diem_dong = null;
  }
  saveRegistry(registry);
  log(`[GHI TRƯỚC KHI PHÁT] Đã ghi vé ${maVe} vào registry với trạng thái dang-chay (thời điểm: ${entry.thoi_diem_tao}).`);

  // 2. LUẬT: PROMPT TRUYỀN QUA TỆP (không nhét toàn văn vào dòng lệnh)
  const promptFileName = `prompt-${maVe}.md`;
  const promptFilePath = path.join(PROMPTS_DIR, promptFileName);
  const promptContent = `# NHIỆM VỤ THỰC THI VÉ ${maVe}

Bạn là hội thoại desktop Antigravity được giao thực thi vé ${maVe}.
Thực hiện ĐÚNG 100% nội dung yêu cầu trong vé dưới đây:

---
${ticket.rawContent}
---

## HƯỚNG DẪN BẮT BUỘC CHO HỘI THOẠI THỰC THI:
1. Đọc kỹ nội dung vé ở trên và thực hiện chính xác các yêu cầu đó.
2. Tuyệt đối không làm ẩu, không dùng placeholder (không TODO, pass, ...).
3. Khi hoàn tất toàn bộ yêu cầu của vé, BẮT BUỘC ghi tệp kết quả vào:
   \`${path.join(KET_QUA_DIR, `${maVe}.md`)}\`
4. Trong tệp kết quả \`${maVe}.md\`, ngoài nội dung kết quả thực thi theo yêu cầu của vé, ở CUỐI TỆP BẮT BUỘC phải có một khối JSON theo đúng mẫu sau:
\`\`\`json
{
  "ma_ve": "${maVe}",
  "trang_thai": "HOAN_THANH",
  "thoi_diem": "${new Date().toISOString()}",
  "ghi_chu": "Hoan thanh boi hoi thoai con Antigravity"
}
\`\`\`
`;
  fs.writeFileSync(promptFilePath, promptContent, 'utf-8');
  log(`[TỆP PROMPT] Đã tạo tệp prompt tại: ${promptFilePath}`);

  // 3. GỌI AGENTAPI MỞ HỘI THOẠI
  try {
    const promptArg = `Đọc tệp prompt tại "${promptFilePath}" và thực hiện toàn bộ nội dung trong tệp.`;
    const res = callAgentApiNewConversation(promptArg, `Ticket-${maVe}`);
    if (res && res.conversationId) {
      entry.ma_hoi_thoai = res.conversationId;
      saveRegistry(registry);
      log(`[PHÁT VÉ THÀNH CÔNG] Vé ${maVe} -> Hội thoại: ${res.conversationId}`);
      pushStatus(`phat-ve-${maVe}`);
    } else {
      entry.trang_thai = 'loi';
      saveRegistry(registry);
      log(`[LỖI] Không nhận được conversationId khi phát vé ${maVe}: ${JSON.stringify(res)}`);
      pushStatus(`loi-phat-ve-${maVe}`);
    }
  } catch (err) {
    entry.trang_thai = 'loi';
    saveRegistry(registry);
    log(`[LỖI PHÁT VÉ] Ngoại lệ khi gọi agentapi cho vé ${maVe}: ${err.message}`);
    pushStatus(`loi-phat-ve-${maVe}`);
  }
}

// Tập hợp lưu các cảnh báo trùng đã log để tránh spam log
const loggedDuplicates = new Set();
let isTicking = false;

function tick() {
  if (isTicking) {
    return;
  }
  isTicking = true;

  try {
    // BƯỚC 1: TỰ ĐỒNG BỘ CLONE KHO ĐIỀU PHỐI VỀ BẢN MỚI NHẤT TRƯỚC KHI QUÉT VÉ
    syncRemote();

    // Nạp registry (authoritative ngoài cây git)
    const registry = loadRegistry();

    // BƯỚC 2: KIỂM TRA ĐÓNG CÁC VÉ ĐANG CHẠY DỰA TRÊN TỆP KẾT QUẢ (XÁC NHẬN ĐÓNG)
    let stateChanged = false;
    const closedTickets = [];

    for (const entry of registry) {
      if (entry.trang_thai === 'dang-chay') {
        const ketQuaFile = path.join(KET_QUA_DIR, `${entry.ma_ve}.md`);
        if (fs.existsSync(ketQuaFile)) {
          try {
            const stat = fs.statSync(ketQuaFile);
            if (stat.size > 0) {
              entry.trang_thai = 'da-dong';
              entry.thoi_diem_dong = new Date().toISOString();
              stateChanged = true;
              closedTickets.push(entry.ma_ve);
              log(`[XÁC NHẬN ĐÓNG] Vé ${entry.ma_ve} đã hoàn thành (tệp kết quả: ${ketQuaFile}, size: ${stat.size}B). Hội thoại: ${entry.ma_hoi_thoai}`);
            }
          } catch (e) {
            // Bỏ qua lỗi truy cập tệp tạm thời
          }
        }
      }
    }

    // BƯỚC 3: THĂNG CẤP VÉ 'cho-slot' NẾU CÒN SLOT TRỐNG (Trần cửa sổ)
    let activeCount = registry.filter(r => r.trang_thai === 'dang-chay').length;
    const queuedEntries = registry.filter(r => r.trang_thai === 'cho-slot');

    for (const queued of queuedEntries) {
      if (activeCount < MAX_CONCURRENT) {
        const ticketPath = path.join(MAILBOX_DIR, queued.tep_ve || `${queued.ma_ve}.md`);
        const ticket = parseTicket(ticketPath);
        if (ticket) {
          // Kiểm tra xem vé chờ này có tệp kết quả chưa trước khi thăng cấp
          const ketQuaFile = path.join(KET_QUA_DIR, `${ticket.maVe}.md`);
          if (fs.existsSync(ketQuaFile) && fs.statSync(ketQuaFile).size > 0) {
            queued.trang_thai = 'da-dong';
            queued.thoi_diem_dong = new Date().toISOString();
            stateChanged = true;
            log(`[BỎ QUA THĂNG CẤP] Vé chờ ${ticket.maVe} đã có tệp kết quả. Đánh dấu da-dong.`);
            continue;
          }

          log(`[THĂNG CẤP HÀNG ĐỢI] Đã có slot trống (${activeCount}/${MAX_CONCURRENT} đang chạy). Phát vé chờ: ${queued.ma_ve}`);
          dispatchTicket(ticket, registry);
          activeCount++;
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      saveRegistry(registry);
      for (const closedMaVe of closedTickets) {
        pushStatus(`dong-ve-${closedMaVe}`);
      }
    }

    // BƯỚC 4: QUÉT HỘP THƯ TÌM VÉ MỚI
    let files = [];
    try {
      files = fs.readdirSync(MAILBOX_DIR);
    } catch (err) {
      log(`[LỖI] Không quét được thư mục hộp thư ${MAILBOX_DIR}: ${err.message}`);
      return;
    }

    activeCount = registry.filter(r => r.trang_thai === 'dang-chay').length;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('prompt-') || file === 'README.md' || file === 'QUY-UOC.md') continue;

      const fullPath = path.join(MAILBOX_DIR, file);
      const ticket = parseTicket(fullPath);
      if (!ticket || ticket.trangThai !== 'moi') continue;

      const maVe = ticket.maVe;

      // KIỂM CHỨNG ĐỘC LẬP 1 (BỔ SUNG BẮT BUỘC 2): SỰ TỒN TẠI CỦA TỆP KẾT QUẢ
      // Coi sự tồn tại của ket-qua/<MÃ VÉ>.md là bằng chứng tuyệt đối vé đã đóng, bất kể registry nói gì
      const ketQuaFile = path.join(KET_QUA_DIR, `${maVe}.md`);
      if (fs.existsSync(ketQuaFile)) {
        try {
          const stat = fs.statSync(ketQuaFile);
          if (stat.size > 0) {
            let entry = registry.find(r => r.ma_ve === maVe);
            let neededPush = false;
            if (!entry) {
              registry.push({
                ma_ve: maVe,
                ma_hoi_thoai: null,
                trang_thai: 'da-dong',
                thoi_diem_tao: new Date().toISOString(),
                thoi_diem_dong: new Date().toISOString(),
                tep_ve: file
              });
              saveRegistry(registry);
              neededPush = true;
            } else if (entry.trang_thai !== 'da-dong') {
              entry.trang_thai = 'da-dong';
              entry.thoi_diem_dong = new Date().toISOString();
              saveRegistry(registry);
              neededPush = true;
            }
            if (neededPush) {
              pushStatus(`dong-ve-${maVe}`);
            }
            const dupKey = `ket-qua:${maVe}`;
            if (!loggedDuplicates.has(dupKey)) {
              log(`[CHỐNG PHÁT TRÙNG - TỆP KẾT QUẢ ĐÃ TỒN TẠI] Bỏ qua vé ${maVe} (tệp ${file}) vì đã tìm thấy tệp kết quả tại ${ketQuaFile} (${stat.size} bytes). Đánh dấu da-dong.`);
              loggedDuplicates.add(dupKey);
            }
            continue;
          }
        } catch (e) {
          // Bỏ qua lỗi truy cập tệp
        }
      }

      // KIỂM CHỨNG ĐỘC LẬP 2: REGISTRY AUTHORITATIVE
      const existing = registry.find(r => r.ma_ve === maVe);
      if (existing) {
        const dupKey = `${maVe}:${existing.trang_thai}`;
        if (!loggedDuplicates.has(dupKey)) {
          log(`[CHỐNG PHÁT TRÙNG] Bỏ qua vé ${maVe} (tệp ${file}) vì mã vé đã tồn tại trong registry (trạng thái hiện tại: ${existing.trang_thai}, mã hội thoại: ${existing.ma_hoi_thoai}).`);
          loggedDuplicates.add(dupKey);
        }
        continue;
      }

      // LUẬT: TRẦN ĐỒNG THỜI
      if (activeCount >= MAX_CONCURRENT) {
        const queueEntry = {
          ma_ve: maVe,
          ma_hoi_thoai: null,
          trang_thai: 'cho-slot',
          thoi_diem_tao: null,
          thoi_diem_dong: null,
          tep_ve: file
        };
        registry.push(queueEntry);
        saveRegistry(registry);
        log(`[TRẦN ĐỒNG THỜI] Đã đạt tối đa ${MAX_CONCURRENT} hội thoại đang chạy (${activeCount}/${MAX_CONCURRENT}). Vé ${maVe} được chuyển vào trạng thái 'cho-slot'.`);
        pushStatus(`cho-slot-${maVe}`);
      } else {
        // Còn slot -> Phát vé
        dispatchTicket(ticket, registry);
        activeCount++;
      }
    }
  } catch (loopErr) {
    log(`[LỖI VÒNG QUÉT] Ngoại lệ không mong muốn trong tick: ${loopErr.message}`);
  } finally {
    isTicking = false;
  }
}

log('=== BẮT ĐẦU SIDECAR NHẶT VÉ ANTIGRAVITY (AGY-MAILBOX-PICKER v4 - THEO GIAO DIỆN) ===');
log(`Thư mục hộp thư: ${MAILBOX_DIR}`);
log(`Thư mục kết quả: ${KET_QUA_DIR}`);
log(`Thư mục prompt:  ${PROMPTS_DIR}`);
log(`Tệp registry authoritative: ${AUTH_REGISTRY_FILE}`);
log(`Tệp registry repo:          ${REPO_REGISTRY_FILE}`);
log(`Trần đồng thời:  ${MAX_CONCURRENT} cửa sổ`);
log(`Chu kỳ quét:     ${POLL_INTERVAL_MS}ms`);

// Vòng quét đầu tiên
tick();

// Lặp lại mỗi POLL_INTERVAL_MS
setInterval(tick, POLL_INTERVAL_MS);
