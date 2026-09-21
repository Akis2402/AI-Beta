'use strict';

/* Client-owned Puter visual lifecycle. Server sends metadata only. */
(function installPuterVisualManager(global) {
  const jobs = new Map();
  const completed = new Map();
  const attempts = new Map();
  const MAX_VISUAL_LIFECYCLE_ATTEMPTS = 2;
  const queue = [];
  let active = 0;
  const MAX_ACTIVE = 1;
  const MAX_BYTES = 12 * 1024 * 1024;
  const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  function error(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!m) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Ảnh trả về không hợp lệ');
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
  }

  function readBytes(blob, count) {
    return blob.slice(0, count).arrayBuffer().then((b) => new Uint8Array(b));
  }

  async function validatePuterImageBlob(blob) {
    if (!blob || !blob.size) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Ảnh trả về rỗng');
    if (!ALLOWED_MIME.has(blob.type)) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'MIME ảnh không được hỗ trợ');
    if (blob.size > MAX_BYTES) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Ảnh vượt quá dung lượng cho phép');
    const bytes = await readBytes(blob, 12);
    const png = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    const gif = bytes.length >= 6 && /GIF8[79]a/.test(String.fromCharCode(...bytes.slice(0, 6)));
    if (!(png || jpg || webp || gif)) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Ảnh không có magic bytes hợp lệ');
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      if (!(img.width > 0 && img.height > 0)) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Kích thước ảnh không hợp lệ');
      return { blob, mime: blob.type, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function resolveVisualInputImages(job) {
    const ids = Array.isArray(job.inputImageIds) ? job.inputImageIds.filter(Boolean) : [];
    const out = [];
    for (const id of ids) {
      const record = await global.chatImageStore.get(id);
      if (!record || !record.blob) throw error('INPUT_IMAGE_MISSING', 'Không khôi phục được ảnh đầu vào');
      if (!ALLOWED_MIME.has(record.mediaType || record.blob.type)) throw error('PUTER_IMAGE_VALIDATION_FAILED', 'Ảnh đầu vào không hợp lệ');
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || error('PUTER_IMAGE_VALIDATION_FAILED'));
        reader.readAsDataURL(record.blob);
      });
      out.push(dataUrl);
    }
    return out;
  }

  function timeoutRace(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(error('PUTER_NETWORK_ERROR', 'Puter tạo hình quá thời gian'), { reason: 'timeout', retryable: true })), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function run(job) {
    const adapter = global.puterAdapter;
    if (!adapter) throw error('PUTER_SDK_UNAVAILABLE', 'Puter image adapter unavailable');
    const inputImages = await resolveVisualInputImages(job);
    const result = await timeoutRace(adapter.generatePuterImage({ ...job, inputImages }), job.timeoutMs || 120000);
    if (attempts.get(job.visualId) !== job.generationAttemptId) throw error('cancelled', 'Kết quả hình đã cũ');
    const blob = result && result.dataUrl ? dataUrlToBlob(result.dataUrl) : null;
    const checked = await validatePuterImageBlob(blob);
    // Kho ảnh (IndexedDB) có thể lỗi (hết dung lượng, private mode...). Ảnh ĐÃ được tạo (đã tốn hạn mức của người dùng) nên
    // KHÔNG được vứt đi: nếu không lưu được thì giữ ảnh trong phiên bằng object URL (mất khi tải lại trang — thẻ hình khi đó
    // hiện nút "Thử tạo lại"), thay vì làm hỏng cả job.
    let imageId = `visual-${job.visualId}`; let url = null; let storageError = null;
    try {
      await global.chatImageStore.save(checked.blob, {
        id: imageId, kind: 'generated_visual', visualId: job.visualId,
        messageId: job.requestId, mediaType: checked.mime,
        provider: 'puter', puterProvider: result.puterProvider,
        model: result.model, fingerprint: job.visualFingerprint,
        generationAttemptId: job.generationAttemptId,
        width: checked.width, height: checked.height
      });
      const stored = await global.chatImageStore.get(imageId);
      url = stored && stored.url;
    } catch (e) {
      storageError = String((e && e.message) || e).slice(0, 160);
      imageId = null;
    }
    if (!url) { try { url = global.URL.createObjectURL(checked.blob); } catch (e) { url = null; } }
    if (!url) throw error('PUTER_INVALID_RESULT', 'Không thể hiển thị ảnh vừa tạo');
    const visual = {
      ...job, status: 'READY', imageId, provider: 'puter',
      puterProvider: result.puterProvider, model: result.model,
      format: 'image_url', url,
      mime: checked.mime, width: checked.width, height: checked.height,
      ...(storageError ? { storageError } : {})
    };
    completed.set(job.visualFingerprint, visual);
    return visual;
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      const item = queue.shift();
      active++;
      run(item.job).then(item.resolve, item.reject).finally(() => { active--; pump(); });
    }
  }

  function enqueue(job) {
    if (!job || !job.visualId) return Promise.reject(error('invalid_job'));
    if (jobs.has(job.visualId)) return jobs.get(job.visualId);
    if (job.visualFingerprint && completed.has(job.visualFingerprint) && !job.hq) return Promise.resolve(completed.get(job.visualFingerprint));
    const attempt = Number(job.generationAttemptId || 1);
    if (attempt > MAX_VISUAL_LIFECYCLE_ATTEMPTS) return Promise.reject(error('retry_limit', 'Đã đạt giới hạn tạo lại'));
    attempts.set(job.visualId, attempt);
    job = { ...job, generationAttemptId: attempt };
    const promise = new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
    jobs.set(job.visualId, promise);
    promise.then(() => jobs.delete(job.visualId), () => jobs.delete(job.visualId));
    return promise;
  }

  async function retry(job, quality) {
    const next = Number(job.generationAttemptId || job.retryCount || 1) + 1;
    if (next > MAX_VISUAL_LIFECYCLE_ATTEMPTS) return Promise.reject(error('retry_limit', 'Đã đạt giới hạn tạo lại'));
    return enqueue({ ...job, quality: quality || 'standard', status: 'QUEUED', retryCount: next - 1, generationAttemptId: next });
  }

  async function hq(job) {
    const next = Number(job.generationAttemptId || 1) + 1;
    if (next > MAX_VISUAL_LIFECYCLE_ATTEMPTS) return Promise.reject(error('retry_limit', 'Đã đạt giới hạn tạo lại'));
    return enqueue({ ...job, quality: 'high', status: 'QUEUED', hq: true, generationAttemptId: next });
  }

  // ---------------------------------------------------------------- Job "chờ Auth" (parked)
  // Job bị chặn vì Puter chưa Auth KHÔNG được thử lại ngầm và KHÔNG được mở popup Auth. Nó được ĐỖ
  // lại; khi người dùng tự Auth trong Settings (canonical state -> authenticated) thì:
  //   • autoResume=true  (hình do người dùng yêu cầu tường minh/NECESSARY): chạy tiếp, không cần bấm lại.
  //   • autoResume=false (hình tuỳ chọn): giữ nguyên, thẻ hình hiện nút [Tạo hình AI ngay].
  const parked = new Map();
  const PARK_TTL_MS = 30 * 60 * 1000;
  function park(job, opts = {}) {
    if (!job || !job.visualId) return false;
    parked.set(job.visualId, { job, autoResume: !!opts.autoResume, onReady: opts.onReady, onError: opts.onError, parkedAt: Date.now() });
    return true;
  }
  function unpark(visualId) { return parked.delete(visualId); }
  function resumeParked() {
    const now = Date.now();
    [...parked.entries()].forEach(([id, entry]) => {
      if (now - entry.parkedAt > PARK_TTL_MS) { parked.delete(id); return; }
      if (!entry.autoResume) return;
      parked.delete(id);
      enqueue(entry.job).then((v) => { if (typeof entry.onReady === 'function') entry.onReady(v); }, (e) => { if (typeof entry.onError === 'function') entry.onError(e); });
    });
  }
  // Nghe canonical auth state — KHÔNG tự kiểm tra Puter riêng.
  if (global.puterAdapter && global.puterAdapter.auth && typeof global.puterAdapter.auth.subscribe === 'function') {
    global.puterAdapter.auth.subscribe((st) => { if (st && st.status === 'authenticated') resumeParked(); });
  }

  /** Chạy job ngay (dùng cho nút [Tạo hình AI ngay] SAU KHI đã Auth). Chưa Auth -> lỗi PUTER_AUTH_REQUIRED, KHÔNG popup. */
  function runNow(job) {
    unpark(job && job.visualId);
    return enqueue(job);
  }

  global.puterVisualManager = {
    enqueue, retry, hq, runNow, park, unpark, resumeParked, resolveVisualInputImages, validatePuterImageBlob,
    getActiveCount: () => active, getParkedCount: () => parked.size
  };
})(typeof window !== 'undefined' ? window : globalThis);
