/**
 * picker.js — Sidecar nhặt vé cho Antigravity Desktop (Làn desktop)
 * Thuộc nhiệm vụ AGY-PAR-001 & DESKTOP-PICKER-AUTOPULL-HOME & DESKTOP-PROTECT-REPORT-PUSH-FIX-HOME &
 * DESKTOP-PICKER-MODEL-FOLLOW-UI-HOME & DESKTOP-PICKER-AUTOSAVE-GUARD-HOME &
 * DESKTOP-PICKER-REGISTRY-SYNC-FIX-HOME & DESKTOP-PICKER-PUSH-EVIDENCE-FIX-HOME.
 *
 * Tính năng chính:
 * 1. Tự động đồng bộ clone kho điều phối (git pull) trước mỗi vòng quét.
 * 2. Bảo vệ bằng chứng toàn diện:
 *    - Bản nộp phiên gồm TOÀN BỘ sản phẩm tạo ra: báo cáo (.md), tệp khai trong báo cáo,
 *      tệp tạo/sửa trong ket-qua/ trong lúc phiên chạy, cập nhật registry, log.
 *    - Quy tắc tên tệp chỉ là tín hiệu bổ sung, tuyệt đối không là cổng loại trừ.
 *    - Chặn hoàn toàn mọi ghi đè lên tệp của vé đã đóng (da-dong).
 * 3. Kỷ luật nộp bài với fetch + rebase + retry (tối đa 4 lần):
 *    - Đẩy kết quả và registry lên kho điều phối một cách an toàn (cấm đẩy force).
 *    - Nếu thất bại chung cuộc: KHÔNG đánh dấu da-dong trong registry-authoritative;
 *      tạo tệp báo động trong thư mục làn và cục bộ; tự thử lại ở các chu kỳ sau.
 * 4. Tự kiểm chứng sau khi đẩy (Self-Verification after Push):
 *    - Kiểm chứng blob trên remote origin/main: đảm bảo tệp báo cáo và 100% tệp bằng chứng tồn tại.
 *    - Kiểm chứng commit mã nguồn trên remote của kho AIOS_habbit: commit khai trong báo cáo
 *      phải mở được trên remote trước khi được phép đóng vé.
 * 5. Đồng bộ registry hai chiều & gộp theo ma_ve trước mỗi lần ghi/đẩy.
 * 6. Duy trì các quy ước cốt lõi: Ghi trước khi phát, mỗi vé một hội thoại, trần 3 cửa sổ.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

function getRepoDir() {
  if (process.env.AIOS_DIEU_PHOI_DIR) {
    return process.env.AIOS_DIEU_PHOI_DIR;
  }
  if (fs.existsSync('D:/Sandbox/aios-dieu-phoi-desktop')) {
    return 'D:/Sandbox/aios-dieu-phoi-desktop';
  }
  return 'D:/Sandbox/aios-dieu-phoi';
}

function getAppRepoDir() {
  return process.env.AIOS_APP_DIR || 'D:/Sandbox/AIOS_habbit';
}

function getMailboxDir() {
  if (process.env.AIOS_MAILBOX_DIR) {
    return process.env.AIOS_MAILBOX_DIR;
  }
  const repo = getRepoDir();
  const pc0575Dir = path.join(repo, 'hop-thu', 'lan-desktop-pc0575');
  if (process.env.COMPUTERNAME === 'KDTVN-PC0575' && fs.existsSync(pc0575Dir)) {
    return pc0575Dir;
  }
  return path.join(repo, 'hop-thu', 'lan-desktop');
}

function getKetQuaDir() {
  return process.env.AIOS_KET_QUA_DIR || path.join(getMailboxDir(), 'ket-qua');
}

function getPromptsDir() {
  return process.env.AIOS_PROMPTS_DIR || path.join(getMailboxDir(), 'prompts');
}

function getRepoRegistryFile() {
  return process.env.AIOS_REPO_REGISTRY || path.join(getMailboxDir(), 'registry.json');
}

function getLogFile() {
  return process.env.AIOS_LOG_FILE || path.join(getMailboxDir(), 'picker.log');
}

function getSidecarDir() {
  return process.env.AIOS_SIDECAR_DIR || __dirname;
}

function getAuthRegistryFile() {
  return process.env.AIOS_AUTH_REGISTRY || path.join(getSidecarDir(), 'registry-authoritative.json');
}

const MAX_CONCURRENT = (process.env.COMPUTERNAME === 'KDTVN-PC0575') ? 2 : 3;
const POLL_INTERVAL_MS = 5000;

function ensureDirs() {
  [getMailboxDir(), getKetQuaDir(), getPromptsDir()].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
  });
}
ensureDirs();

function getRelativeRepoPaths() {
  const repo = getRepoDir();
  return {
    relMailboxDir: path.relative(repo, getMailboxDir()).replace(/\\/g, '/'),
    relRegistryFile: path.relative(repo, getRepoRegistryFile()).replace(/\\/g, '/'),
    relLogFile: path.relative(repo, getLogFile()).replace(/\\/g, '/'),
    relKetQuaDir: path.relative(repo, getKetQuaDir()).replace(/\\/g, '/'),
    relPromptsDir: path.relative(repo, getPromptsDir()).replace(/\\/g, '/'),
  };
}

function normalizeToRelPath(p, baseDir = getRepoDir()) {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  if (path.isAbsolute(p)) {
    return path.relative(baseDir, p).replace(/\\/g, '/');
  }
  return norm;
}

function normalizeToAbsPath(p, baseDir = getRepoDir()) {
  if (!p) return '';
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(baseDir, p));
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(getLogFile(), line + '\n', 'utf-8');
  } catch (e) {}
}

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
  } catch (err) {}
  return null;
}

function fetchRemoteRegistry() {
  const repo = getRepoDir();
  const { relRegistryFile } = getRelativeRepoPaths();
  try {
    execSync('git fetch origin main', { cwd: repo, stdio: 'pipe', timeout: 20000 });
    const raw = execSync(`git show origin/main:"${relRegistryFile}"`, {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    log(`[CẢNH BÁO FETCH REGISTRY] Không thể lấy registry từ origin/main: ${err.message}. Sử dụng bản local.`);
  }

  const repoFile = getRepoRegistryFile();
  if (fs.existsSync(repoFile)) {
    try {
      const raw = fs.readFileSync(repoFile, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
  }
  return [];
}

function mergeRegistryWithRemote(remoteList, localList, targetTicketIds = []) {
  const targetSet = new Set((targetTicketIds || []).map(m => String(m).trim()));
  const merged = [];
  const handledMaVe = new Set();

  const safeRemoteList = Array.isArray(remoteList) ? remoteList : [];
  const safeLocalList = Array.isArray(localList) ? localList : [];

  for (const remoteItem of safeRemoteList) {
    const maVe = remoteItem.ma_ve;
    handledMaVe.add(maVe);

    if (targetSet.has(maVe)) {
      const localItem = safeLocalList.find(l => l.ma_ve === maVe);
      if (localItem) {
        merged.push({
          ...remoteItem,
          ...localItem
        });
      } else {
        merged.push({ ...remoteItem });
      }
    } else {
      merged.push({ ...remoteItem });
    }
  }

  for (const localItem of safeLocalList) {
    if (!handledMaVe.has(localItem.ma_ve)) {
      merged.push({ ...localItem });
      handledMaVe.add(localItem.ma_ve);
    }
  }

  return merged;
}

function loadRegistry() {
  const authFile = getAuthRegistryFile();
  const repoFile = getRepoRegistryFile();

  let authData = [];
  if (fs.existsSync(authFile)) {
    try {
      const raw = fs.readFileSync(authFile, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          authData = parsed;
        }
      }
    } catch (err) {
      log(`[CẢNH BÁO] Không đọc được ${authFile}: ${err.message}.`);
    }
  }

  let repoData = [];
  if (fs.existsSync(repoFile)) {
    try {
      const rawRepo = fs.readFileSync(repoFile, 'utf-8').trim();
      if (rawRepo) {
        const parsed = JSON.parse(rawRepo);
        if (Array.isArray(parsed)) {
          repoData = parsed;
        }
      }
    } catch (err) {
      log(`[CẢNH BÁO] Không đọc được ${repoFile}: ${err.message}.`);
    }
  }

  if (authData.length === 0 && repoData.length > 0) {
    authData = repoData.map(item => ({ ...item }));
    try {
      fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf-8');
    } catch (e) {}
    return authData;
  }

  let stateUpdated = false;
  for (const repoItem of repoData) {
    const existing = authData.find(r => r.ma_ve === repoItem.ma_ve);
    if (!existing) {
      authData.push({ ...repoItem });
      stateUpdated = true;
    } else {
      if (repoItem.trang_thai === 'da-dong' && existing.trang_thai !== 'da-dong') {
        existing.trang_thai = 'da-dong';
        existing.thoi_diem_dong = repoItem.thoi_diem_dong || new Date().toISOString();
        if (repoItem.ghi_chu_dong) existing.ghi_chu_dong = repoItem.ghi_chu_dong;
        stateUpdated = true;
      }
      if (repoItem.ghi_chu_dong && !existing.ghi_chu_dong) {
        existing.ghi_chu_dong = repoItem.ghi_chu_dong;
        stateUpdated = true;
      }
    }
  }

  if (stateUpdated) {
    try {
      fs.writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf-8');
    } catch (e) {}
  }

  return authData;
}

function saveRegistry(registry, targetTicketIds = []) {
  const authFile = getAuthRegistryFile();
  const repoFile = getRepoRegistryFile();
  try {
    const content = JSON.stringify(registry, null, 2);
    fs.writeFileSync(authFile, content, 'utf-8');

    if (fs.existsSync(repoFile)) {
      let repoBase = [];
      try {
        const raw = fs.readFileSync(repoFile, 'utf-8').trim();
        if (raw) repoBase = JSON.parse(raw);
      } catch (e) {}
      const merged = (targetTicketIds && targetTicketIds.length > 0)
        ? mergeRegistryWithRemote(repoBase, registry, targetTicketIds)
        : registry;
      fs.writeFileSync(repoFile, JSON.stringify(merged, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(repoFile, content, 'utf-8');
    }
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

  const trimmed = String(out || '').trim();
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace));
      if (parsed.response && parsed.response.newConversation) {
        return parsed.response.newConversation;
      }
      return parsed;
    } catch (e) {}
  }
  return null;
}

function getFilesUnderDir(dirPath) {
  let results = [];
  try {
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dirPath, ent.name);
      if (ent.isDirectory()) {
        results = results.concat(getFilesUnderDir(full));
      } else if (ent.isFile()) {
        results.push(full);
      }
    }
  } catch (e) {}
  return results;
}

function isFileMatchingTicket(relFilePath, maVe) {
  if (!maVe || !relFilePath) return false;
  const normalizedPath = relFilePath.replace(/\\/g, '/');

  if (normalizedPath.includes('/luu-tru-bang-chung/') || normalizedPath.startsWith('luu-tru-bang-chung/')) {
    return false;
  }

  const fileName = path.basename(normalizedPath).toLowerCase();
  const ticket = maVe.trim().toLowerCase();

  if (fileName === `${ticket}.md`) {
    return true;
  }

  const ticketHyphen = ticket;
  const ticketUnderscore = ticket.replace(/-/g, '_');
  const fileNameHyphen = fileName.replace(/_/g, '-');

  if (fileNameHyphen.includes(ticketHyphen) || fileName.includes(ticketUnderscore)) {
    return true;
  }

  const prefixMatch = ticket.match(/^(?:desktop|pc0575|canary)-(.*)$/);
  if (prefixMatch && prefixMatch[1] && prefixMatch[1].length >= 5) {
    const core = prefixMatch[1];
    const coreUnderscore = core.replace(/-/g, '_');
    if (fileNameHyphen.includes(core) || fileName.includes(coreUnderscore)) {
      return true;
    }
  }

  if (ticket.includes('evidence-recovery') && (fileName.includes('official-r2-20261019') || fileName.includes('official_r2') || fileName.includes('browser-acceptance'))) {
    return true;
  }

  return false;
}

function extractDeclaredFilesFromReport(reportContent, ketQuaDir = getKetQuaDir(), repoDir = getRepoDir()) {
  if (!reportContent) return [];
  const foundFiles = new Set();
  const { relKetQuaDir, relMailboxDir } = getRelativeRepoPaths();

  function addIfValid(candidate) {
    if (!candidate) return;
    let clean = candidate.trim().split('#')[0].split('?')[0].replace(/^["'`]|["'`]$/g, '').trim();
    if (!clean || clean.length < 3) return;
    if (clean.startsWith('http://') || clean.startsWith('https://')) return;

    const base = path.basename(clean);
    const directInKetQua = path.join(ketQuaDir, base);
    if (fs.existsSync(directInKetQua) && fs.statSync(directInKetQua).isFile()) {
      const rel = normalizeToRelPath(directInKetQua, repoDir);
      if (!rel.includes('/luu-tru-bang-chung/')) {
        foundFiles.add(rel);
        return;
      }
    }

    const fromRepo = path.join(repoDir, clean);
    if (fs.existsSync(fromRepo) && fs.statSync(fromRepo).isFile()) {
      const rel = normalizeToRelPath(fromRepo, repoDir);
      if ((rel.startsWith(relKetQuaDir + '/') || rel.startsWith(relMailboxDir + '/')) && !rel.includes('/luu-tru-bang-chung/')) {
        foundFiles.add(rel);
        return;
      }
    }
  }

  const linkRegex = /(?:!\[.*?\]\((.*?)\)|\[.*?\]\((.*?)\))/g;
  let match;
  while ((match = linkRegex.exec(reportContent)) !== null) {
    addIfValid(match[1] || match[2]);
  }

  const codeRegex = /`([^`\r\n]+\.(?:png|jpg|jpeg|gif|json|csv|log|txt|pdf|parquet|svg|bin|zip|tar|gz))`\b/gi;
  while ((match = codeRegex.exec(reportContent)) !== null) {
    addIfValid(match[1]);
  }

  const rawFileRegex = /\b([a-zA-Z0-9_\-./\\]+\.(?:png|jpg|jpeg|gif|json|csv|log|txt|pdf|parquet|svg))\b/gi;
  while ((match = rawFileRegex.exec(reportContent)) !== null) {
    addIfValid(match[1]);
  }

  return Array.from(foundFiles);
}

function getSessionCreatedFiles(ticketEntry, ketQuaDir = getKetQuaDir(), repoDir = getRepoDir(), closedTicketIds = []) {
  const results = [];
  if (!ticketEntry || !ticketEntry.ma_ve) return results;

  let startTime = 0;
  if (ticketEntry.thoi_diem_tao) {
    const t = new Date(ticketEntry.thoi_diem_tao).getTime();
    if (!isNaN(t)) {
      startTime = t;
    }
  }

  const allFiles = getFilesUnderDir(ketQuaDir);
  for (const absFile of allFiles) {
    const base = path.basename(absFile);
    const rel = normalizeToRelPath(absFile, repoDir);

    if (rel.includes('/luu-tru-bang-chung/') || rel.startsWith('luu-tru-bang-chung/')) {
      continue;
    }

    const isClosedTicketFile = closedTicketIds.some(cMaVe => {
      if (cMaVe.toLowerCase() === ticketEntry.ma_ve.toLowerCase()) return false;
      return base.toLowerCase() === `${cMaVe.toLowerCase()}.md` || isFileMatchingTicket(rel, cMaVe);
    });
    if (isClosedTicketFile) continue;

    try {
      const stat = fs.statSync(absFile);
      if (startTime > 0 && stat.mtimeMs >= (startTime - 2000)) {
        results.push(rel);
      }
    } catch (e) {}
  }

  return results;
}

function getAllowedFilesForTicket(ticketEntry, ketQuaDir = getKetQuaDir(), repoDir = getRepoDir(), closedTicketIds = []) {
  if (!ticketEntry || !ticketEntry.ma_ve) return [];
  const maVe = ticketEntry.ma_ve;
  const fileSet = new Set();

  const reportFileAbs = path.join(ketQuaDir, `${maVe}.md`);
  const reportFileRel = normalizeToRelPath(reportFileAbs, repoDir);

  if (fs.existsSync(reportFileAbs)) {
    fileSet.add(reportFileRel);

    try {
      const content = fs.readFileSync(reportFileAbs, 'utf-8');
      const declaredFiles = extractDeclaredFilesFromReport(content, ketQuaDir, repoDir);
      for (const df of declaredFiles) {
        fileSet.add(df);
      }
    } catch (e) {
      log(`[CẢNH BÁO ĐỌC BÁO CÁO] Không đọc được ${reportFileAbs}: ${e.message}`);
    }
  }

  const sessionCreated = getSessionCreatedFiles(ticketEntry, ketQuaDir, repoDir, closedTicketIds);
  for (const sf of sessionCreated) {
    fileSet.add(sf);
  }

  const allFiles = getFilesUnderDir(ketQuaDir);
  for (const absFile of allFiles) {
    const rel = normalizeToRelPath(absFile, repoDir);
    if (isFileMatchingTicket(rel, maVe)) {
      fileSet.add(rel);
    }
  }

  return Array.from(fileSet);
}

function getAllowedFilesForActiveEntries(activeEntries, ketQuaDir = getKetQuaDir(), repoDir = getRepoDir(), closedTicketIds = []) {
  const combined = new Set();
  for (const entry of activeEntries) {
    const files = getAllowedFilesForTicket(entry, ketQuaDir, repoDir, closedTicketIds);
    for (const f of files) combined.add(f);
  }
  return combined;
}

function handleKetQuaFile(relPath, allowedTicketIds, closedTicketIds, allowedFileSet = new Set()) {
  const repo = getRepoDir();
  const isAllowed = allowedFileSet.has(relPath) || allowedTicketIds.some(maVe => isFileMatchingTicket(relPath, maVe));

  if (isAllowed) {
    try {
      execSync(`git add "${relPath}"`, { cwd: repo, stdio: 'pipe', timeout: 5000 });
      log(`[BẢO VỆ KẾT QUẢ - ĐƯỢC PHÉP] Đã stage tệp kết quả hợp lệ: ${relPath}`);
    } catch (addErr) {
      log(`[CẢNH BÁO STAGE] Không thể stage ${relPath}: ${addErr.message}`);
    }
  } else {
    const matchingClosed = closedTicketIds.find(cMaVe => isFileMatchingTicket(relPath, cMaVe));
    if (matchingClosed) {
      log(`[BẢO VỆ KẾT QUẢ - ĐÃ CHẶN] PHÁT HIỆN THAY ĐỔI TRÊN TỆP VÉ ĐÃ ĐÓNG: "${relPath}" (vé đã đóng: ${matchingClosed}). ĐÃ CHẶN COMMIT ĐỂ BẢO VỆ BẰNG CHỨNG!`);
    } else {
      log(`[BẢO VỆ KẾT QUẢ - BỎ QUA] Tệp "${relPath}" không thuộc phiên đang chạy (${allowedTicketIds.join(', ') || 'không có vé nào'}). Bỏ qua không commit theo nguyên tắc an toàn bằng chứng.`);
    }
  }
}

function stageAllowedChanges(action, registry) {
  const repo = getRepoDir();
  const { relRegistryFile, relLogFile, relKetQuaDir, relPromptsDir } = getRelativeRepoPaths();

  const activeEntries = registry.filter(r => r.trang_thai === 'dang-chay');

  if (action && action.startsWith('dong-ve-')) {
    const closingMaVe = action.replace('dong-ve-', '').trim();
    if (closingMaVe && !activeEntries.some(e => e.ma_ve === closingMaVe)) {
      const found = registry.find(r => r.ma_ve === closingMaVe);
      activeEntries.push(found || { ma_ve: closingMaVe, trang_thai: 'dang-chay', thoi_diem_tao: new Date().toISOString() });
    }
  }

  const allowedTicketIds = activeEntries.map(r => r.ma_ve);
  const closedTicketIds = registry.filter(r => r.trang_thai === 'da-dong').map(r => r.ma_ve);
  const allowedFileSet = getAllowedFilesForActiveEntries(activeEntries, getKetQuaDir(), repo, closedTicketIds);

  try {
    const stagedOut = execSync('git -c core.quotepath=false diff --cached --name-only', {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 5000
    });
    const stagedFiles = stagedOut.split(/\r?\n/).map(f => f.trim().replace(/\\/g, '/')).filter(Boolean);
    for (const sFile of stagedFiles) {
      if (sFile.startsWith(relKetQuaDir + '/')) {
        const isAllowed = allowedFileSet.has(sFile) || allowedTicketIds.some(maVe => isFileMatchingTicket(sFile, maVe));
        if (!isAllowed) {
          execSync(`git reset HEAD -- "${sFile}"`, { cwd: repo, stdio: 'pipe', timeout: 5000 });
          log(`[BẢO VỆ KẾT QUẢ - UNSTAGE] Đã unstage tệp không hợp lệ khỏi index: ${sFile}`);
        }
      }
    }
  } catch (e) {}

  const baseItems = [];
  const repoReg = getRepoRegistryFile();
  const logF = getLogFile();
  const promptD = getPromptsDir();

  if (action !== 'auto-save' && fs.existsSync(repoReg)) {
    baseItems.push(relRegistryFile);
  }
  if (fs.existsSync(logF)) baseItems.push(relLogFile);
  if (action && action.startsWith('phat-ve-') && fs.existsSync(promptD)) {
    baseItems.push(relPromptsDir);
  }

  for (const item of baseItems) {
    try {
      execSync(`git add "${item}"`, { cwd: repo, stdio: 'pipe', timeout: 5000 });
    } catch (err) {
      log(`[CẢNH BÁO STAGE] Không thể stage ${item}: ${err.message}`);
    }
  }

  try {
    const statusOut = execSync('git -c core.quotepath=false status --porcelain', {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 10000
    });

    const statusLines = statusOut.split(/\r?\n/).filter(l => l.trim().length > 3);
    for (const line of statusLines) {
      let rawPath = line.slice(3).trim();
      if (rawPath.includes(' -> ')) {
        rawPath = rawPath.split(' -> ')[1].trim();
      }
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1);
      }
      const relPath = rawPath.replace(/\\/g, '/');

      if (!relPath.startsWith(relKetQuaDir + '/') && relPath !== relKetQuaDir) {
        continue;
      }

      if (relPath.endsWith('/')) {
        const absDir = path.join(repo, relPath);
        const filesInside = getFilesUnderDir(absDir);
        for (const fInside of filesInside) {
          const relInside = normalizeToRelPath(fInside, repo);
          handleKetQuaFile(relInside, allowedTicketIds, closedTicketIds, allowedFileSet);
        }
        continue;
      }

      handleKetQuaFile(relPath, allowedTicketIds, closedTicketIds, allowedFileSet);
    }
  } catch (err) {
    log(`[LỖI QUÉT THAY ĐỔI] Không thể quét trạng thái git để lọc kết quả: ${err.message}`);
  }
}

function checkSourceCodeCommitOnRemote(reportContent, appRepoDir = getAppRepoDir()) {
  if (!reportContent) return { valid: true };
  if (!fs.existsSync(appRepoDir) || !fs.existsSync(path.join(appRepoDir, '.git'))) {
    return { valid: true };
  }

  const candidateShas = new Set();
  const patterns = [
    /(?:commit(?:\s*mã\s*nguồn|\s*nguồn|\s*code)?|sha(?:\s*commit)?|mã băm)[:\s*`]+([0-9a-f]{7,40})/gi,
    /"(?:commit|sha)":\s*"([0-9a-f]{7,40})"/gi,
    /\b([0-9a-f]{40})\b/gi
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(reportContent)) !== null) {
      candidateShas.add(m[1].toLowerCase());
    }
  }

  for (const sha of candidateShas) {
    let isAppCommit = false;
    let fullSha = sha;
    try {
      fullSha = execSync(`git rev-parse --verify --quiet "${sha}^{commit}"`, {
        cwd: appRepoDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      isAppCommit = !!fullSha;
    } catch (e) {
      isAppCommit = false;
    }

    if (isAppCommit) {
      log(`[KIỂM CHỨNG MÃ NGUỒN] Phát hiện commit ${fullSha.slice(0, 8)} của kho mã nguồn khai trong báo cáo. Đang kiểm tra remote...`);
      try {
        execSync('git fetch origin', { cwd: appRepoDir, stdio: 'pipe', timeout: 20000 });
        const branchOut = execSync(`git branch -r --contains "${fullSha}"`, {
          cwd: appRepoDir,
          encoding: 'utf-8',
          timeout: 10000
        }).trim();

        if (!branchOut) {
          const tagOut = execSync(`git tag --contains "${fullSha}"`, {
            cwd: appRepoDir,
            encoding: 'utf-8',
            timeout: 10000
          }).trim();
          if (!tagOut) {
            return {
              valid: false,
              commitSha: fullSha,
              error: `Commit mã nguồn ${fullSha.slice(0, 8)} tồn tại cục bộ nhưng CHƯA ĐƯỢC PUSH lên remote của kho AIOS_habbit!`
            };
          }
        }
        log(`[KIỂM CHỨNG MÃ NGUỒN - ĐẠT] Commit ${fullSha.slice(0, 8)} đã tồn tại trên remote (${branchOut.split('\n')[0].trim()}).`);
      } catch (err) {
        return {
          valid: false,
          commitSha: fullSha,
          error: `Không thể xác minh commit ${fullSha.slice(0, 8)} trên remote: ${err.message}`
        };
      }
    }
  }

  return { valid: true };
}

function verifyRemoteEvidence(maVe, sessionFiles, repoDir = getRepoDir()) {
  try {
    execSync('git fetch origin main', { cwd: repoDir, stdio: 'pipe', timeout: 20000 });
  } catch (fetchErr) {
    return { valid: false, error: `Không thể fetch origin main để kiểm chứng: ${fetchErr.message}` };
  }

  const { relKetQuaDir } = getRelativeRepoPaths();
  const relReport = path.join(relKetQuaDir, `${maVe}.md`).replace(/\\/g, '/');

  try {
    const reportCheck = execSync(`git ls-tree -r origin/main "${relReport}"`, {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
    if (!reportCheck) {
      return { valid: false, missingFile: relReport, error: `Tệp báo cáo ${relReport} không tồn tại trên origin/main` };
    }
  } catch (e) {
    return { valid: false, missingFile: relReport, error: `Lỗi kiểm tra tệp báo cáo trên remote: ${e.message}` };
  }

  for (const sFile of sessionFiles) {
    const relFile = normalizeToRelPath(sFile, repoDir);
    try {
      const fileCheck = execSync(`git ls-tree -r origin/main "${relFile}"`, {
        cwd: repoDir,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      if (!fileCheck) {
        return { valid: false, missingFile: relFile, error: `Tệp bằng chứng ${relFile} không tồn tại trên origin/main` };
      }
    } catch (e) {
      return { valid: false, missingFile: relFile, error: `Lỗi kiểm tra tệp ${relFile} trên remote: ${e.message}` };
    }
  }

  return { valid: true };
}

function createSubmissionAlarm(maVe, unsubmittedFiles, errorMsg) {
  const mailboxDir = getMailboxDir();
  const sidecarDir = getSidecarDir();

  const laneAlarmContent = `# BÁO ĐỘNG NỘP BÀI THẤT BẠI: ${maVe}
- **Mã vé**: ${maVe}
- **Thời điểm**: ${new Date().toISOString()}
- **Nguyên nhân / Lỗi**: ${errorMsg}
- **Danh sách tệp chưa nộp được**:
${unsubmittedFiles.map(f => `  - \`${f}\``).join('\n')}
`;
  const laneAlarmFile = path.join(mailboxDir, `BAO-DONG-${maVe}.md`);
  try {
    fs.writeFileSync(laneAlarmFile, laneAlarmContent, 'utf-8');
    log(`[BÁO ĐỘNG] Đã tạo tệp báo động trong thư mục làn: ${laneAlarmFile}`);
  } catch (e) {
    log(`[BÁO ĐỘNG LỖI] Không thể ghi tệp báo động làn: ${e.message}`);
  }

  const localAlarmData = {
    ma_ve: maVe,
    thoi_diem: new Date().toISOString(),
    loi: errorMsg,
    tep_chua_nop: unsubmittedFiles
  };
  const localAlarmFile = path.join(sidecarDir, `bao-dong-${maVe}.json`);
  try {
    fs.writeFileSync(localAlarmFile, JSON.stringify(localAlarmData, null, 2), 'utf-8');
    log(`[BÁO ĐỘNG] Đã tạo tệp báo động cục bộ tại: ${localAlarmFile}`);
  } catch (e) {
    log(`[BÁO ĐỘNG LỖI] Không thể ghi tệp báo động cục bộ: ${e.message}`);
  }
}

function clearSubmissionAlarm(maVe) {
  const sidecarDir = getSidecarDir();
  const mailboxDir = getMailboxDir();
  const repo = getRepoDir();

  const localAlarmFile = path.join(sidecarDir, `bao-dong-${maVe}.json`);
  if (fs.existsSync(localAlarmFile)) {
    try { fs.unlinkSync(localAlarmFile); } catch (e) {}
  }
  const laneAlarmFile = path.join(mailboxDir, `BAO-DONG-${maVe}.md`);
  if (fs.existsSync(laneAlarmFile)) {
    try {
      fs.unlinkSync(laneAlarmFile);
      const { relMailboxDir } = getRelativeRepoPaths();
      const relAlarm = path.join(relMailboxDir, `BAO-DONG-${maVe}.md`).replace(/\\/g, '/');
      try {
        execSync(`git rm -f --ignore-unmatch "${relAlarm}"`, { cwd: repo, stdio: 'pipe' });
      } catch (rmErr) {}
    } catch (e) {}
  }
}

function commitAndPushWithRetry(maVe, sessionFiles, registry, maxRetries = 4) {
  const repo = getRepoDir();
  const { relRegistryFile, relLogFile, relKetQuaDir, relMailboxDir } = getRelativeRepoPaths();
  const relReportFile = path.join(relKetQuaDir, `${maVe}.md`).replace(/\\/g, '/');
  const repoRegFile = getRepoRegistryFile();
  const authRegFile = getAuthRegistryFile();
  const logF = getLogFile();
  const mailboxDir = getMailboxDir();

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[NỘP BÀI] Bắt đầu lượt thử ${attempt}/${maxRetries} cho vé ${maVe}...`);
    try {
      execSync('git fetch origin main', { cwd: repo, stdio: 'pipe', timeout: 20000 });

      const remoteRegistry = fetchRemoteRegistry();
      const localRegistry = loadRegistry();
      const mergedRegistry = mergeRegistryWithRemote(remoteRegistry, localRegistry, [maVe]);

      const targetEntry = mergedRegistry.find(r => r.ma_ve === maVe);
      if (targetEntry) {
        targetEntry.trang_thai = 'da-dong';
        targetEntry.thoi_diem_dong = targetEntry.thoi_diem_dong || new Date().toISOString();
      }

      fs.writeFileSync(repoRegFile, JSON.stringify(mergedRegistry, null, 2), 'utf-8');

      if (fs.existsSync(path.join(repo, relReportFile))) {
        execSync(`git add "${relReportFile}"`, { cwd: repo, stdio: 'pipe' });
      }
      for (const sFile of sessionFiles) {
        const rel = normalizeToRelPath(sFile, repo);
        if (fs.existsSync(path.join(repo, rel))) {
          execSync(`git add "${rel}"`, { cwd: repo, stdio: 'pipe' });
          log(`[NỘP BÀI - STAGE] Đã stage sản phẩm: ${rel}`);
        }
      }
      if (fs.existsSync(repoRegFile)) {
        execSync(`git add "${relRegistryFile}"`, { cwd: repo, stdio: 'pipe' });
      }
      if (fs.existsSync(logF)) {
        execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
      }

      const laneAlarmFile = path.join(mailboxDir, `BAO-DONG-${maVe}.md`);
      if (fs.existsSync(laneAlarmFile)) {
        try {
          fs.unlinkSync(laneAlarmFile);
          const relAlarm = path.join(relMailboxDir, `BAO-DONG-${maVe}.md`).replace(/\\/g, '/');
          execSync(`git rm -f --ignore-unmatch "${relAlarm}"`, { cwd: repo, stdio: 'pipe' });
        } catch (e) {}
      }

      let hasDiff = false;
      try {
        execSync('git diff --cached --quiet', { cwd: repo, stdio: 'pipe' });
      } catch (e) {
        hasDiff = true;
      }

      if (hasDiff) {
        execFileSync('git', ['commit', '-m', `feat(picker): cap nhat ket qua va dong ve [dong-ve-${maVe}]`], {
          cwd: repo,
          stdio: 'pipe',
          timeout: 15000
        });
      }

      execSync('git fetch origin main', { cwd: repo, stdio: 'pipe', timeout: 20000 });
      const localHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
      const remoteHead = execSync('git rev-parse origin/main', { cwd: repo, encoding: 'utf-8' }).trim();

      if (localHead !== remoteHead) {
        const behindCount = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: repo, encoding: 'utf-8' }).trim(), 10);
        if (behindCount > 0) {
          if (fs.existsSync(logF)) {
            try { execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' }); } catch (e) {}
          }
          log(`[NỘP BÀI - REBASE] Remote tiến lên ${behindCount} commit. Tiến hành git pull --rebase...`);
          if (fs.existsSync(logF)) {
            try { execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' }); } catch (e) {}
          }
          try {
            execSync('git pull --rebase --autostash origin main', { cwd: repo, stdio: 'pipe', timeout: 25000 });
          } catch (rebaseErr) {
            log(`[NỘP BÀI - REBASE XUNG ĐỘT] Xung đột rebase: ${rebaseErr.message}. Giải quyết xung đột registry...`);
            const isRebasing = fs.existsSync(path.join(repo, '.git', 'rebase-merge')) || fs.existsSync(path.join(repo, '.git', 'rebase-apply'));
            if (isRebasing) {
              try {
                const conflictRemoteReg = fetchRemoteRegistry();
                const resolvedReg = mergeRegistryWithRemote(conflictRemoteReg, loadRegistry(), [maVe]);
                const closingInResolved = resolvedReg.find(r => r.ma_ve === maVe);
                if (closingInResolved) {
                  closingInResolved.trang_thai = 'da-dong';
                  closingInResolved.thoi_diem_dong = closingInResolved.thoi_diem_dong || new Date().toISOString();
                }
                fs.writeFileSync(repoRegFile, JSON.stringify(resolvedReg, null, 2), 'utf-8');
                execSync(`git add "${relRegistryFile}"`, { cwd: repo, stdio: 'pipe' });
                if (fs.existsSync(logF)) {
                  execSync(`git checkout --ours "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
                  execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
                }
                execSync('git -c core.editor=true rebase --continue', { cwd: repo, stdio: 'pipe' });
                log(`[NỘP BÀI - REBASE] Đã giải quyết xung đột rebase thành công.`);
              } catch (resErr) {
                log(`[NỘP BÀI - REBASE THẤT BẠI] Không thể giải quyết rebase: ${resErr.message}. Huỷ rebase.`);
                try { execSync('git rebase --abort', { cwd: repo, stdio: 'pipe' }); } catch (abErr) {}
                throw resErr;
              }
            } else {
              throw rebaseErr;
            }
          }
        }
      }

      execFileSync('git', ['push', 'origin', 'main'], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 30000
      });
      log(`[NỘP BÀI - PUSH THÀNH CÔNG] Đã đẩy commit lên origin/main ở lượt ${attempt}.`);

      const verifyRes = verifyRemoteEvidence(maVe, sessionFiles, repo);
      if (!verifyRes.valid) {
        throw new Error(`Tự kiểm chứng remote thất bại: ${verifyRes.error || verifyRes.missingFile}`);
      }

      const currentAuth = loadRegistry();
      const authEntry = currentAuth.find(r => r.ma_ve === maVe);
      if (authEntry) {
        authEntry.trang_thai = 'da-dong';
        authEntry.thoi_diem_dong = authEntry.thoi_diem_dong || new Date().toISOString();
      }
      fs.writeFileSync(authRegFile, JSON.stringify(currentAuth, null, 2), 'utf-8');

      clearSubmissionAlarm(maVe);

      log(`[NỘP BÀI HOÀN TẤT] Vé ${maVe} đã đóng và nộp toàn bộ bằng chứng lên origin/main thành công.`);
      return { success: true };
    } catch (err) {
      lastError = err;
      log(`[NỘP BÀI - LỖI LƯỢT ${attempt}] ${err.message}`);
      if (attempt < maxRetries) {
        try { execSync(`powershell -Command "Start-Sleep -Milliseconds ${1000 * attempt}"`); } catch (e) {}
      }
    }
  }

  log(`[BÁO ĐỘNG ĐẨY THẤT BẠI] Vé ${maVe} không thể nộp bài sau ${maxRetries} lần thử!`);
  const errorMsg = lastError ? lastError.message : 'Unknown push failure';
  const unsubmittedList = [relReportFile, ...sessionFiles.map(f => normalizeToRelPath(f, repo))];

  createSubmissionAlarm(maVe, unsubmittedList, errorMsg);

  return { success: false, error: lastError };
}

function submitTicket(entry, registry) {
  const repo = getRepoDir();
  const ketQuaDir = getKetQuaDir();
  const maVe = entry.ma_ve;
  const ketQuaFile = path.join(ketQuaDir, `${maVe}.md`);
  if (!fs.existsSync(ketQuaFile)) {
    return false;
  }
  let stat = null;
  try {
    stat = fs.statSync(ketQuaFile);
  } catch (e) {}
  if (!stat || stat.size === 0) {
    return false;
  }

  log(`[TIẾN HÀNH NỘP BÀI] Phát hiện kết quả cho vé ${maVe} (${stat.size} bytes). Bắt đầu kiểm tra và nộp...`);

  const reportContent = fs.readFileSync(ketQuaFile, 'utf-8');
  const codeCheck = checkSourceCodeCommitOnRemote(reportContent, getAppRepoDir());
  if (!codeCheck.valid) {
    log(`[BÁO ĐỘNG MÃ NGUỒN] Vé ${maVe} KHÔNG ĐƯỢC ĐÓNG vì: ${codeCheck.error}`);
    const relReport = normalizeToRelPath(ketQuaFile, repo);
    createSubmissionAlarm(maVe, [relReport], codeCheck.error);
    return false;
  }

  const closedTicketIds = registry.filter(r => r.trang_thai === 'da-dong').map(r => r.ma_ve);
  const sessionFiles = getAllowedFilesForTicket(entry, ketQuaDir, repo, closedTicketIds);
  log(`[SẢN PHẨM PHIÊN] Vé ${maVe} có ${sessionFiles.length} tệp cần nộp (báo cáo + bằng chứng).`);

  const submitRes = commitAndPushWithRetry(maVe, sessionFiles, registry, 4);
  return submitRes.success;
}

function syncRemote() {
  const repo = getRepoDir();
  const { relRegistryFile, relLogFile } = getRelativeRepoPaths();
  const repoRegFile = getRepoRegistryFile();
  const authRegFile = getAuthRegistryFile();

  try {
    execSync('git fetch origin main', {
      cwd: repo,
      stdio: 'pipe',
      timeout: 20000
    });

    const localHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8', timeout: 5000 }).trim();
    const remoteHead = execSync('git rev-parse origin/main', { cwd: repo, encoding: 'utf-8', timeout: 5000 }).trim();

    if (localHead === remoteHead) {
      log(`[ĐỒNG BỘ KHO] Clone đã khớp với kho điều phối (HEAD: ${localHead.slice(0, 7)}).`);
      return true;
    }

    const behindCount = parseInt(
      execSync('git rev-list HEAD..origin/main --count', { cwd: repo, encoding: 'utf-8', timeout: 5000 }).trim(),
      10
    );

    if (behindCount > 0) {
      log(`[ĐỒNG BỘ KHO] Phát hiện ${behindCount} commit mới trên kho điều phối. Bắt đầu kéo về...`);

      const registry = loadRegistry();
      stageAllowedChanges('auto-save', registry);

      let hasStaged = false;
      try {
        execSync('git diff --cached --quiet', { cwd: repo, stdio: 'pipe', timeout: 5000 });
      } catch (e) {
        hasStaged = true;
      }

      if (hasStaged) {
        execFileSync('git', ['commit', '-m', 'chore(picker): auto-save desktop lane status and results before merge [skip ci]'], {
          cwd: repo,
          stdio: 'pipe',
          timeout: 10000
        });
      }

      try {
        const pullOut = execSync('git pull --no-rebase --no-edit origin main', {
          cwd: repo,
          encoding: 'utf-8',
          timeout: 25000
        });
        const newHead = execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf-8', timeout: 5000 }).trim();
        log(`[ĐỒNG BỘ KHO] Đã kéo thành công bản mới từ kho điều phối (HEAD: ${newHead}). Kết quả: ${pullOut.trim()}`);
        loadRegistry();
      } catch (mergeErr) {
        log(`[CẢNH BÁO ĐỒNG BỘ] Xung đột khi kéo, giải quyết xung đột registry bằng gộp theo mã vé...`);
        try {
          const remoteList = fetchRemoteRegistry();
          const localList = loadRegistry();
          const activeMaVeList = localList.filter(r => r.trang_thai === 'dang-chay').map(r => r.ma_ve);
          const merged = mergeRegistryWithRemote(remoteList, localList, activeMaVeList);
          fs.writeFileSync(repoRegFile, JSON.stringify(merged, null, 2), 'utf-8');
          fs.writeFileSync(authRegFile, JSON.stringify(merged, null, 2), 'utf-8');

          execSync(`git checkout --ours "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
          execSync(`git add "${relRegistryFile}" "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
          execSync('git commit -m "chore(picker): resolve merge conflict preserving remote registry states [skip ci]"', { cwd: repo, stdio: 'pipe' });
          log(`[ĐỒNG BỘ KHO] Đã giải quyết xung đột thành công, bảo toàn trạng thái remote của registry.`);
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

function pushStatus(action, targetTicketIds = []) {
  const repo = getRepoDir();
  const { relRegistryFile, relLogFile } = getRelativeRepoPaths();
  const repoRegFile = getRepoRegistryFile();
  const authRegFile = getAuthRegistryFile();
  const logF = getLogFile();
  const maxRetries = 4;

  const targets = new Set((targetTicketIds || []).map(t => String(t).trim()));
  for (const prefix of ['phat-ve-', 'dong-ve-', 'cho-slot-', 'loi-phat-ve-']) {
    if (action && action.startsWith(prefix)) {
      const ma = action.replace(prefix, '').trim();
      if (ma) targets.add(ma);
    }
  }
  const targetList = Array.from(targets);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync('git fetch origin main', { cwd: repo, stdio: 'pipe', timeout: 20000 });
      const remoteRegistry = fetchRemoteRegistry();
      const localRegistry = loadRegistry();
      const mergedRegistry = mergeRegistryWithRemote(remoteRegistry, localRegistry, targetList);

      fs.writeFileSync(repoRegFile, JSON.stringify(mergedRegistry, null, 2), 'utf-8');
      fs.writeFileSync(authRegFile, JSON.stringify(mergedRegistry, null, 2), 'utf-8');

      stageAllowedChanges(action, mergedRegistry);

      let hasDiff = false;
      try {
        execSync('git diff --cached --quiet', { cwd: repo, stdio: 'pipe', timeout: 5000 });
      } catch (e) {
        hasDiff = true;
      }

      if (hasDiff) {
        const isClosing = action && action.startsWith('dong-ve-');
        const commitMsg = isClosing
          ? `feat(picker): cap nhat ket qua va dong ve [${action}]`
          : `chore(picker): cap nhat trang thai [${action}]`;
        execFileSync('git', ['commit', '-m', commitMsg], {
          cwd: repo,
          stdio: 'pipe',
          timeout: 10000
        });
      }

      execSync('git fetch origin main', { cwd: repo, stdio: 'pipe', timeout: 20000 });
      const localHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
      const remoteHead = execSync('git rev-parse origin/main', { cwd: repo, encoding: 'utf-8' }).trim();

      if (localHead !== remoteHead) {
        const behindCount = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: repo, encoding: 'utf-8' }).trim(), 10);
        if (behindCount > 0) {
          if (fs.existsSync(logF)) {
            try { execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' }); } catch (e) {}
          }
          try {
            execSync('git pull --rebase --autostash origin main', { cwd: repo, stdio: 'pipe', timeout: 25000 });
          } catch (rebaseErr) {
            const isRebasing = fs.existsSync(path.join(repo, '.git', 'rebase-merge')) || fs.existsSync(path.join(repo, '.git', 'rebase-apply'));
            if (isRebasing) {
              const conflictRemote = fetchRemoteRegistry();
              const reMerged = mergeRegistryWithRemote(conflictRemote, loadRegistry(), targetList);
              fs.writeFileSync(repoRegFile, JSON.stringify(reMerged, null, 2), 'utf-8');
              fs.writeFileSync(authRegFile, JSON.stringify(reMerged, null, 2), 'utf-8');
              execSync(`git add "${relRegistryFile}"`, { cwd: repo, stdio: 'pipe' });
              if (fs.existsSync(logF)) {
                execSync(`git checkout --ours "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
                execSync(`git add "${relLogFile}"`, { cwd: repo, stdio: 'pipe' });
              }
              execSync('git -c core.editor=true rebase --continue', { cwd: repo, stdio: 'pipe' });
            }
          }
        }
      }

      execFileSync('git', ['push', 'origin', 'main'], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 25000
      });
      log(`[TỰ ĐẨY TRẠNG THÁI] Đã đẩy trạng thái lên kho thành công (${action}) ở lượt ${attempt}.`);
      return true;
    } catch (err) {
      log(`[CẢNH BÁO TỰ ĐẨY] Lỗi tại lượt ${attempt} (${action}): ${err.message}`);
      if (attempt < maxRetries) {
        try { execSync(`powershell -Command "Start-Sleep -Milliseconds ${1000 * attempt}"`); } catch (e) {}
      }
    }
  }

  log(`[THẤT BẠI ĐẨY] Đã thử ${maxRetries} lần nhưng không thể đẩy trạng thái (${action}). Cấm đẩy force theo quy ước.`);
  return false;
}

function dispatchTicket(ticket, registry) {
  const maVe = ticket.maVe;
  log(`[CHUẨN BỊ PHÁT VÉ] Bắt đầu phát vé ${maVe}...`);

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
  saveRegistry(registry, [maVe]);
  log(`[GHI TRƯỚC KHI PHÁT] Đã ghi vé ${maVe} vào registry với trạng thái dang-chay (thời điểm: ${entry.thoi_diem_tao}).`);

  const promptFileName = `prompt-${maVe}.md`;
  const promptFilePath = path.join(getPromptsDir(), promptFileName);
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
   \`${path.join(getKetQuaDir(), `${maVe}.md`)}\`
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

  try {
    const promptArg = `Đọc tệp prompt tại "${promptFilePath}" và thực hiện toàn bộ nội dung trong tệp.`;
    const res = callAgentApiNewConversation(promptArg, `Ticket-${maVe}`);
    if (res && res.conversationId) {
      entry.ma_hoi_thoai = res.conversationId;
      saveRegistry(registry, [maVe]);
      log(`[PHÁT VÉ THÀNH CÔNG] Vé ${maVe} -> Hội thoại: ${res.conversationId}`);
      pushStatus(`phat-ve-${maVe}`, [maVe]);
    } else {
      entry.trang_thai = 'loi';
      saveRegistry(registry, [maVe]);
      log(`[LỖI] Không nhận được conversationId khi phát vé ${maVe}: ${JSON.stringify(res)}`);
      pushStatus(`loi-phat-ve-${maVe}`, [maVe]);
    }
  } catch (err) {
    entry.trang_thai = 'loi';
    saveRegistry(registry, [maVe]);
    log(`[LỖI PHÁT VÉ] Ngoại lệ khi gọi agentapi cho vé ${maVe}: ${err.message}`);
    pushStatus(`loi-phat-ve-${maVe}`, [maVe]);
  }
}

const loggedDuplicates = new Set();
let isTicking = false;

function tick() {
  if (isTicking) {
    return;
  }
  isTicking = true;

  try {
    syncRemote();
    const registry = loadRegistry();
    const ketQuaDir = getKetQuaDir();
    const mailboxDir = getMailboxDir();

    for (const entry of registry) {
      if (entry.trang_thai === 'dang-chay') {
        const ketQuaFile = path.join(ketQuaDir, `${entry.ma_ve}.md`);
        if (fs.existsSync(ketQuaFile)) {
          let stat = null;
          try {
            stat = fs.statSync(ketQuaFile);
          } catch (e) {}

          if (stat && stat.size > 0) {
            submitTicket(entry, registry);
          }
        }
      }
    }

    let activeCount = registry.filter(r => r.trang_thai === 'dang-chay').length;
    const queuedEntries = registry.filter(r => r.trang_thai === 'cho-slot');

    for (const queued of queuedEntries) {
      if (activeCount < MAX_CONCURRENT) {
        const ticketPath = path.join(mailboxDir, queued.tep_ve || `${queued.ma_ve}.md`);
        const ticket = parseTicket(ticketPath);
        if (ticket) {
          const ketQuaFile = path.join(ketQuaDir, `${ticket.maVe}.md`);
          if (fs.existsSync(ketQuaFile) && fs.statSync(ketQuaFile).size > 0) {
            submitTicket(queued, registry);
            continue;
          }

          log(`[THĂNG CẤP HÀNG ĐỢI] Đã có slot trống (${activeCount}/${MAX_CONCURRENT} đang chạy). Phát vé chờ: ${queued.ma_ve}`);
          dispatchTicket(ticket, registry);
          activeCount++;
        }
      }
    }

    let files = [];
    try {
      files = fs.readdirSync(mailboxDir);
    } catch (err) {
      log(`[LỖI] Không quét được thư mục hộp thư ${mailboxDir}: ${err.message}`);
      return;
    }

    activeCount = registry.filter(r => r.trang_thai === 'dang-chay').length;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('prompt-') || file.startsWith('BAO-DONG-') || file === 'README.md' || file === 'QUY-UOC.md') continue;

      const fullPath = path.join(mailboxDir, file);
      const ticket = parseTicket(fullPath);
      if (!ticket || ticket.trangThai !== 'moi') continue;

      const maVe = ticket.maVe;
      const ketQuaFile = path.join(ketQuaDir, `${maVe}.md`);
      if (fs.existsSync(ketQuaFile)) {
        try {
          const stat = fs.statSync(ketQuaFile);
          if (stat.size > 0) {
            let entry = registry.find(r => r.ma_ve === maVe);
            if (!entry) {
              entry = {
                ma_ve: maVe,
                ma_hoi_thoai: null,
                trang_thai: 'dang-chay',
                thoi_diem_tao: new Date().toISOString(),
                thoi_diem_dong: null,
                tep_ve: file
              };
              registry.push(entry);
              saveRegistry(registry, [maVe]);
            }
            if (entry.trang_thai !== 'da-dong') {
              submitTicket(entry, registry);
            }
            const dupKey = `ket-qua:${maVe}`;
            if (!loggedDuplicates.has(dupKey)) {
              log(`[CHỐNG PHÁT TRÙNG - TỆP KẾT QUẢ ĐÃ TỒN TẠI] Vé ${maVe} (tệp ${file}) đã có tệp kết quả.`);
              loggedDuplicates.add(dupKey);
            }
            continue;
          }
        } catch (e) {}
      }

      const existing = registry.find(r => r.ma_ve === maVe);
      if (existing) {
        const dupKey = `${maVe}:${existing.trang_thai}`;
        if (!loggedDuplicates.has(dupKey)) {
          log(`[CHỐNG PHÁT TRÙNG] Bỏ qua vé ${maVe} (tệp ${file}) vì mã vé đã tồn tại trong registry (trạng thái hiện tại: ${existing.trang_thai}, mã hội thoại: ${existing.ma_hoi_thoai}).`);
          loggedDuplicates.add(dupKey);
        }
        continue;
      }

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
        saveRegistry(registry, [maVe]);
        log(`[TRẦN ĐỒNG THỜI] Đã đạt tối đa ${MAX_CONCURRENT} hội thoại đang chạy (${activeCount}/${MAX_CONCURRENT}). Vé ${maVe} được chuyển vào trạng thái 'cho-slot'.`);
        pushStatus(`cho-slot-${maVe}`, [maVe]);
      } else {
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

if (require.main === module) {
  log('=== BẮT ĐẦU SIDECAR NHẶT VÉ ANTIGRAVITY (AGY-MAILBOX-PICKER v6 - EVIDENCE SUBMISSION & REMOTE VERIFY FIX) ===');
  log(`Thư mục hộp thư: ${getMailboxDir()}`);
  log(`Thư mục kết quả: ${getKetQuaDir()}`);
  log(`Thư mục prompt:  ${getPromptsDir()}`);
  log(`Tệp registry authoritative: ${getAuthRegistryFile()}`);
  log(`Tệp registry repo:          ${getRepoRegistryFile()}`);
  log(`Trần đồng thời:  ${MAX_CONCURRENT} cửa sổ`);
  log(`Chu kỳ quét:     ${POLL_INTERVAL_MS}ms`);

  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getRepoDir,
    getAppRepoDir,
    getMailboxDir,
    getKetQuaDir,
    getPromptsDir,
    getRepoRegistryFile,
    getAuthRegistryFile,
    getLogFile,
    getSidecarDir,
    normalizeToRelPath,
    normalizeToAbsPath,
    isFileMatchingTicket,
    getFilesUnderDir,
    extractDeclaredFilesFromReport,
    getSessionCreatedFiles,
    getAllowedFilesForTicket,
    getAllowedFilesForActiveEntries,
    checkSourceCodeCommitOnRemote,
    verifyRemoteEvidence,
    createSubmissionAlarm,
    clearSubmissionAlarm,
    commitAndPushWithRetry,
    submitTicket,
    handleKetQuaFile,
    stageAllowedChanges,
    getRelativeRepoPaths,
    loadRegistry,
    saveRegistry,
    syncRemote,
    pushStatus,
    fetchRemoteRegistry,
    mergeRegistryWithRemote,
    tick
  };

  Object.defineProperty(module.exports, 'REPO_DIR', { get: getRepoDir });
  Object.defineProperty(module.exports, 'MAILBOX_DIR', { get: getMailboxDir });
  Object.defineProperty(module.exports, 'KET_QUA_DIR', { get: getKetQuaDir });
  Object.defineProperty(module.exports, 'PROMPTS_DIR', { get: getPromptsDir });
  Object.defineProperty(module.exports, 'REPO_REGISTRY_FILE', { get: getRepoRegistryFile });
  Object.defineProperty(module.exports, 'LOG_FILE', { get: getLogFile });
  Object.defineProperty(module.exports, 'SIDECAR_DIR', { get: getSidecarDir });
  Object.defineProperty(module.exports, 'AUTH_REGISTRY_FILE', { get: getAuthRegistryFile });
  Object.defineProperty(module.exports, 'APP_REPO_DIR', { get: getAppRepoDir });
}
