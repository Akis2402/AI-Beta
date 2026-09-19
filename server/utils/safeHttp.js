'use strict';

// ============================================================================================
// PHẦN L — TẢI HỘ ẢNH MÀ KHÔNG MỞ ĐƯỜNG SSRF
// ============================================================================================
// Bản trước chỉ có: https-only + whitelist hostname + kiểm lại hostname ở mỗi chặng redirect. Vẫn
// còn 3 lỗ hổng THẬT:
//   1. DNS REBINDING / bản ghi DNS trỏ vào nội bộ: hostname nằm trong whitelist nhưng DNS trả về
//      127.0.0.1 / 169.254.169.254 (metadata endpoint của cloud) / 10.x — `fetch` vẫn kết nối.
//   2. Không có Content-Length: trần MAX_BYTES chỉ được kiểm SAU KHI `arrayBuffer()` đã nạp toàn bộ
//      vào RAM — một upstream trả 2GB là đủ giết instance trước khi dòng kiểm tra chạy.
//   3. Nén: body 12MB có thể giãn ra rất lớn khi giải nén (decompression bomb).
//
// Module này:
//   - Tự phân giải DNS TRƯỚC, từ chối MỌI địa chỉ không phải public (IPv4 + IPv6, kể cả dạng ánh
//     xạ ::ffff:10.0.0.1 và các dạng số bất thường đã được `new URL` chuẩn hoá).
//   - GHIM chính địa chỉ IP đã kiểm bằng tuỳ chọn `lookup` của https.request — không còn khe thời
//     gian giữa lúc kiểm và lúc kết nối để DNS đổi câu trả lời.
//   - Đọc theo LUỒNG và HUỶ ngay khi vượt trần byte (không bao giờ nạp trọn body rồi mới kiểm).
//   - KHÔNG gửi header Accept-Encoding nén -> upstream trả nguyên bản, loại bỏ decompression bomb.
//   - Redirect xử lý thủ công, mỗi chặng lại đi qua ĐÚNG các bước trên.

const https = require('https');
const dns = require('dns').promises;
const net = require('net');

/** @returns {boolean} địa chỉ này KHÔNG được phép kết nối tới (nội bộ/đặc biệt). */
function isBlockedAddress(addr) {
  const ip = String(addr || '');
  const family = net.isIP(ip);
  if (!family) return true; // không phải IP hợp lệ -> chặn

  if (family === 4) return isBlockedIPv4(ip);

  const lower = ip.toLowerCase();
  // IPv4 ánh xạ trong IPv6 (::ffff:10.0.0.1) — phải kiểm theo luật IPv4, nếu không là đường vòng.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;           // unspecified / loopback
  if (/^fe[89ab]/.test(lower)) return true;                      // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true;                         // fc00::/7 unique local
  if (/^ff/.test(lower)) return true;                            // multicast
  if (/^64:ff9b:/.test(lower)) return true;                      // NAT64 -> có thể trỏ về IPv4 nội bộ
  return false;
}

function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + metadata cloud (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a >= 224) return true;                       // multicast + reserved 240/4 + broadcast
  return false;
}

/**
 * Phân giải hostname và trả về MỘT địa chỉ public đã kiểm. Bất kỳ địa chỉ nào trong kết quả DNS rơi
 * vào dải nội bộ -> TỪ CHỐI CẢ HOST (không "chọn cái công khai còn lại"): một host trả về cả public
 * lẫn private là dấu hiệu kinh điển của DNS rebinding.
 * @returns {Promise<{ok:boolean, address?:string, family?:number, reason?:string}>}
 */
async function resolvePublicAddress(hostname) {
  const literal = net.isIP(hostname);
  if (literal) {
    if (isBlockedAddress(hostname)) return { ok: false, reason: 'blocked_ip' };
    return { ok: true, address: hostname, family: literal };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, reason: 'dns_failed' };
  }
  if (!records || !records.length) return { ok: false, reason: 'dns_empty' };
  for (const r of records) {
    if (isBlockedAddress(r.address)) return { ok: false, reason: 'blocked_ip' };
  }
  return { ok: true, address: records[0].address, family: records[0].family };
}

/**
 * GET https có kiểm soát: IP đã ghim, trần byte cứng, không nén, không tự đi theo redirect.
 * @param {URL} url
 * @param {{maxBytes:number, timeoutMs:number}} opts
 * @returns {Promise<{ok:boolean, status?:number, headers?:object, body?:Buffer, location?:string, reason?:string}>}
 */
async function fetchPinned(url, opts) {
  const maxBytes = opts.maxBytes;
  const resolved = await resolvePublicAddress(url.hostname);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = https.request({
      protocol: 'https:',
      host: url.hostname,
      servername: url.hostname, // SNI + xác thực chứng chỉ vẫn theo TÊN, không theo IP
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      // Cho phép caller thêm header tùy chỉnh, không để caller ghi đè Accept-Encoding (identity là bắt buộc cho trần byte trên luồng).
      headers: { Accept: '*/*', ...(opts.headers || {}), 'Accept-Encoding': 'identity' },
      timeout: opts.timeoutMs,
      lookup: (host, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {}; }
        if (options && options.all) {
          cb(null, [{ address: resolved.address, family: resolved.family }]);
        } else {
          cb(null, resolved.address, resolved.family);
        }
      }
    }, (res) => {
      const status = res.statusCode || 0;
      const declared = Number(res.headers['content-length'] || 0);
      if (declared && declared > maxBytes) { res.destroy(); return done({ ok: false, reason: 'too_large' }); }
      if (status >= 300 && status < 400) {
        res.resume();
        return done({ ok: true, status, headers: res.headers, location: res.headers.location || null });
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        // Trần được áp NGAY TRÊN LUỒNG: vượt là huỷ kết nối, không nạp tiếp 1 byte nào.
        if (total > maxBytes) { res.destroy(); return done({ ok: false, reason: 'too_large' }); }
        chunks.push(chunk);
      });
      res.on('end', () => done({ ok: true, status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => done({ ok: false, reason: 'stream_error' }));
    });

    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }); });
    req.on('error', () => done({ ok: false, reason: 'request_failed' }));
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

module.exports = { isBlockedAddress, isBlockedIPv4, resolvePublicAddress, fetchPinned };
