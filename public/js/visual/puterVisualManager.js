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
    if (!m) throw error('invalid_output', 'Ảnh trả về không hợp lệ');
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
  }

  function readBytes(blob, count) {
    return blob.slice(0, count).arrayBuffer().then((b) => new Uint8Array(b));
  }

  async function validatePuterImageBlob(blob) {
    if (!blob || !blob.size) throw error('invalid_output', 'Ảnh trả về rỗng');
    if (!ALLOWED_MIME.has(blob.type)) throw error('invalid_output', 'MIME ảnh không được hỗ trợ');
    if (blob.size > MAX_BYTES) throw error('invalid_output', 'Ảnh vượt quá dung lượng cho phép');
    const bytes = await readBytes(blob, 12);
    const png = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    const gif = bytes.length >= 6 && /GIF8[79]a/.test(String.fromCharCode(...bytes.slice(0, 6)));
    if (!(png || jpg || webp || gif)) throw error('invalid_output', 'Ảnh không có magic bytes hợp lệ');
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      if (!(img.width > 0 && img.height > 0)) throw error('invalid_output', 'Kích thước ảnh không hợp lệ');
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
      if (!ALLOWED_MIME.has(record.mediaType || record.blob.type)) throw error('invalid_output', 'Ảnh đầu vào không hợp lệ');
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || error('invalid_output'));
        reader.readAsDataURL(record.blob);
      });
      out.push(dataUrl);
    }
    return out;
  }

  function timeoutRace(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(error('timeout', 'Puter tạo hình quá thời gian')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function run(job) {
    const adapter = global.puterAdapter;
    if (!adapter) throw error('upstream_failed', 'Puter image adapter unavailable');
    const inputImages = await resolveVisualInputImages(job);
    const result = await timeoutRace(adapter.generatePuterImage({ ...job, inputImages }), job.timeoutMs || 120000);
    if (attempts.get(job.visualId) !== job.generationAttemptId) throw error('cancelled', 'Kết quả hình đã cũ');
    const blob = result && result.dataUrl ? dataUrlToBlob(result.dataUrl) : null;
    const checked = await validatePuterImageBlob(blob);
    const imageId = `visual-${job.visualId}`;
    await global.chatImageStore.save(checked.blob, {
      id: imageId, kind: 'generated_visual', visualId: job.visualId,
      messageId: job.requestId, mediaType: checked.mime,
      provider: 'puter', puterProvider: result.puterProvider,
      model: result.model, fingerprint: job.visualFingerprint,
      generationAttemptId: job.generationAttemptId,
      width: checked.width, height: checked.height
    });
    const stored = await global.chatImageStore.get(imageId);
    const visual = {
      ...job, status: 'READY', imageId, provider: 'puter',
      puterProvider: result.puterProvider, model: result.model,
      format: 'image_url', url: stored && stored.url,
      mime: checked.mime, width: checked.width, height: checked.height
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

  async function signInAndResume(job) {
    if (!global.puterAdapter || typeof global.puterAdapter.signIn !== 'function') throw error('not_available_in_app');
    await global.puterAdapter.signIn();
    return enqueue(job);
  }

  global.puterVisualManager = {
    enqueue, retry, hq, signInAndResume, resolveVisualInputImages, validatePuterImageBlob,
    getActiveCount: () => active
  };
})(typeof window !== 'undefined' ? window : globalThis);
