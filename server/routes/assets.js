'use strict';

// ============================================================================================
// /api/assets/*  — ASSET MANAGER (favicon, logo, OG image, avatar mặc định, nền...)
// ============================================================================================
// Kiến trúc: file nằm ở Supabase Storage (bucket `site-assets`), metadata ở bảng `site_assets`.
// Trình duyệt KHÔNG gọi thẳng Supabase (CSP img-src 'self'); server proxy file qua /api/assets/file/:key
// nên URL luôn cùng-origin. Cache-busting bằng tham số ?v=<version>: mỗi lần đổi, version tăng và
// đường dẫn lưu trữ cũng đổi => không có favicon "cũ vĩnh viễn" ở trình duyệt/CDN.
//
// Quyền: đọc công khai; ghi/xoá CHỈ admin (profiles.role = 'admin', tra bằng service role phía server).
// Kiểm tra file: allowlist key, MIME theo magic bytes (không tin Content-Type client), ≤ 1MB,
// kích thước ảnh ≤ 4096px (PNG/JPEG). KHÔNG nhận SVG (vector XSS) .

const express = require('express');
const { createLimiter } = require('../middleware/rateLimit');
const { requireUser, originAllowed } = require('../middleware/authQuota');
const session = require('../utils/auth/session');
const sb = require('../utils/supabase/client');
const { getConfig } = require('../utils/quota/config');

const router = express.Router();

const BUCKET = 'site-assets';
const MAX_BYTES = 1024 * 1024;
const MAX_DIM = 4096;
const KEYS = Object.freeze([
  'favicon', 'logo', 'logo_light', 'logo_dark', 'app_icon', 'og_image', 'default_avatar', 'background', 'empty_state', 'auth_image'
]);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/x-icon': 'ico' };

const adminLimiter = createLimiter({
  name: 'assets-admin', windowMs: 15 * 60 * 1000, max: Number(process.env.RATE_LIMIT_ASSETS_ADMIN || 30),
  message: { error: 'Bạn thao tác asset quá nhiều lần. Vui lòng thử lại sau.' }
});

// ---------- sniff & kiểm tra ảnh ----------
function sniffMime(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** @returns {{ok:true, mime:string}|{ok:false, error:string, code:string}} */
function validateImage(buf, key) {
  if (!buf || !buf.length) return { ok: false, error: 'File rỗng.', code: 'empty_file' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'File quá lớn (tối đa 1MB).', code: 'file_too_large' };
  const mime = sniffMime(buf);
  if (!mime) return { ok: false, error: 'Chỉ chấp nhận PNG, JPEG, WebP hoặc ICO (không nhận SVG).', code: 'unsupported_type' };
  if (mime === 'image/x-icon' && key !== 'favicon') return { ok: false, error: 'ICO chỉ dùng cho favicon.', code: 'ico_only_favicon' };
  const dim = mime === 'image/png' ? pngSize(buf) : (mime === 'image/jpeg' ? jpegSize(buf) : null);
  if ((mime === 'image/png' || mime === 'image/jpeg') && !dim) return { ok: false, error: 'Không đọc được kích thước ảnh (file hỏng?).', code: 'bad_image' };
  if (dim && (dim.w < 1 || dim.h < 1 || dim.w > MAX_DIM || dim.h > MAX_DIM)) {
    return { ok: false, error: `Kích thước ảnh phải trong khoảng 1–${MAX_DIM}px mỗi cạnh.`, code: 'bad_dimensions' };
  }
  return { ok: true, mime, dim };
}

function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
function err(res, status, error, code) { noStore(res); return res.status(status).json({ error, code }); }
function keyOk(k) { return KEYS.includes(k); }

async function requireAdmin(req, res, next) {
  if (!req.user) return err(res, 401, 'Bạn cần đăng nhập.', 'auth_required');
  if (!originAllowed(req)) return err(res, 403, 'Yêu cầu bị từ chối do nguồn gốc không hợp lệ.', 'bad_origin');
  try {
    const p = await session.getProfile(req.user.id);
    if (!p || p.role !== 'admin') return err(res, 403, 'Bạn không có quyền quản lý asset.', 'forbidden');
    return next();
  } catch (_) {
    return err(res, 503, 'Không xác minh được quyền. Vui lòng thử lại sau.', 'auth_unavailable');
  }
}

// ---------- đọc công khai ----------
// GET /api/assets/config -> { assets: { favicon: {url, alt, version}, ... } } — rỗng nếu chưa cấu hình/tùy biến.
router.get('/config', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  if (!getConfig().supabase.configured) return res.json({ assets: {}, keys: KEYS });
  try {
    const rows = await sb.select('site_assets', 'select=key,alt,version,content_type');
    const assets = {};
    rows.forEach((r) => {
      if (!keyOk(r.key)) return;
      assets[r.key] = { url: `/api/assets/file/${r.key}?v=${encodeURIComponent(r.version)}`, alt: r.alt || '', version: r.version, contentType: r.content_type };
    });
    return res.json({ assets, keys: KEYS });
  } catch (_) {
    // Lỗi đọc asset KHÔNG được làm hỏng trang: trả rỗng -> frontend dùng asset mặc định đóng gói sẵn.
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ assets: {}, keys: KEYS, degraded: true });
  }
});

router.get('/file/:key', async (req, res) => {
  const key = String(req.params.key || '');
  if (!keyOk(key)) return res.status(404).end();
  try {
    const rows = await sb.select('site_assets', `key=eq.${encodeURIComponent(key)}&select=storage_path,content_type,version&limit=1`);
    if (!rows[0]) return res.status(404).end();
    const f = await sb.storage.download(BUCKET, rows[0].storage_path);
    if (!f) return res.status(404).end();
    const hasV = Number(req.query.v) === Number(rows[0].version);
    res.setHeader('Content-Type', EXT[rows[0].content_type] ? rows[0].content_type : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', hasV ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    return res.status(200).end(f.buffer);
  } catch (_) {
    return res.status(502).end();
  }
});

// ---------- ghi (admin) ----------
const jsonAsset = express.json({ limit: '1600kb' });

router.put('/:key', requireUser, requireAdmin, adminLimiter, jsonAsset, async (req, res) => {
  const key = String(req.params.key || '');
  if (!keyOk(key)) return err(res, 400, 'Khoá asset không hợp lệ.', 'bad_key');
  const b64 = req.body && typeof req.body.dataBase64 === 'string' ? req.body.dataBase64 : '';
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return err(res, 400, 'Thiếu dữ liệu ảnh (base64).', 'missing_data');
  const buf = Buffer.from(b64, 'base64');
  const v = validateImage(buf, key);
  if (!v.ok) return err(res, 400, v.error, v.code);
  const alt = String((req.body && req.body.alt) || '').trim().slice(0, 200);

  try {
    const prev = (await sb.select('site_assets', `key=eq.${encodeURIComponent(key)}&select=version,storage_path&limit=1`))[0];
    const version = prev ? Number(prev.version) + 1 : 1;
    const path = `${key}/v${version}.${EXT[v.mime]}`;
    await sb.storage.upload(BUCKET, path, buf, v.mime);
    await sb.upsert('site_assets', { key, storage_path: path, content_type: v.mime, alt, version, updated_by: req.user.id, updated_at: new Date().toISOString() }, 'key');
    if (prev && prev.storage_path) sb.storage.remove(BUCKET, prev.storage_path).catch(() => {});
    noStore(res);
    return res.json({ ok: true, key, version, url: `/api/assets/file/${key}?v=${version}` });
  } catch (e) {
    return err(res, 502, 'Không lưu được asset. Vui lòng thử lại.', 'asset_save_failed');
  }
});

// "Reset to default" = xoá bản tuỳ biến; frontend quay về asset mặc định đóng gói sẵn.
router.delete('/:key', requireUser, requireAdmin, adminLimiter, async (req, res) => {
  const key = String(req.params.key || '');
  if (!keyOk(key)) return err(res, 400, 'Khoá asset không hợp lệ.', 'bad_key');
  try {
    const prev = (await sb.select('site_assets', `key=eq.${encodeURIComponent(key)}&select=storage_path&limit=1`))[0];
    await sb.remove('site_assets', `key=eq.${encodeURIComponent(key)}`);
    if (prev && prev.storage_path) await sb.storage.remove(BUCKET, prev.storage_path).catch(() => {});
    noStore(res);
    return res.json({ ok: true, key });
  } catch (_) {
    return err(res, 502, 'Không đặt lại được asset. Vui lòng thử lại.', 'asset_reset_failed');
  }
});

module.exports = router;
module.exports._test = { sniffMime, validateImage, pngSize, jpegSize, KEYS, MAX_BYTES };
