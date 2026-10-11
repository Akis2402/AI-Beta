'use strict';

/* =====================================================================================
   authClient.js — lớp gọi /api/auth/* dùng cho trang đăng nhập riêng (auth.html).
   - KHÔNG chạm /api/chat|generate|recommend|study|source|visual: trang này không tốn token AI.
   - Proof-of-work (đăng ký / quên mật khẩu): giống hệt giao thức của authUI.js
       SHA-256(`${salt}:${nonce}`) phải có >= bits bit 0 đứng đầu. Có SHA-256 thuần JS dự phòng cho ngữ
       cảnh không bảo mật (http://192.168.x.x không có crypto.subtle). Hằng số SHA tính từ căn bậc 2/3 của
       số nguyên tố (đúng định nghĩa chuẩn) và được test đối chiếu với crypto của Node.
   - safeNext(): chỉ cho phép quay về /index.html (chống open-redirect).
   ===================================================================================== */
(function (root) {
  var K = [], H0 = [];
  (function () {
    var n = 2, c = 0;
    function prime(x) { for (var i = 2; i * i <= x; i++) if (x % i === 0) return false; return true; }
    function frac(x) { return ((x - Math.floor(x)) * 4294967296) | 0; }
    while (c < 64) {
      if (prime(n)) { if (c < 8) H0[c] = frac(Math.sqrt(n)); K[c] = frac(Math.cbrt(n)); c++; }
      n++;
    }
  })();

  function sha256Js(bytes) {
    var H = H0.slice(), l = bytes.length, bitLen = l * 8;
    var padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296)); dv.setUint32(padded.length - 4, bitLen >>> 0);
    var w = new Array(64), i;
    for (var off = 0; off < padded.length; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        var s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }

  function leadingZeroBits(u8) {
    var bits = 0;
    for (var i = 0; i < u8.length; i++) {
      if (u8[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(u8[i]) - 24; break;
    }
    return bits;
  }

  /** Tìm nonce sao cho SHA-256(`${salt}:${nonce}`) có >= bits bit 0 đầu. Không chặn luồng UI. */
  async function solvePow(salt, bits, subtleOverride) {
    var enc = new TextEncoder();
    var subtle = subtleOverride === undefined ? (root.crypto && root.crypto.subtle) : subtleOverride;
    var n = 0, LIMIT = 1 << 27, i;
    if (subtle) {
      var BATCH = 512;
      while (n < LIMIT) {
        var jobs = [];
        for (i = 0; i < BATCH; i++) jobs.push(subtle.digest('SHA-256', enc.encode(salt + ':' + (n + i))));
        var res = await Promise.all(jobs);
        for (i = 0; i < BATCH; i++) if (leadingZeroBits(new Uint8Array(res[i])) >= bits) return n + i;
        n += BATCH;
      }
    } else {
      var t0 = Date.now();
      while (n < LIMIT) {
        if (leadingZeroBits(sha256Js(enc.encode(salt + ':' + n))) >= bits) return n;
        n += 1;
        if (Date.now() - t0 > 40) { await new Promise(function (r) { setTimeout(r, 0); }); t0 = Date.now(); }
      }
    }
    throw new Error('pow_unsolved');
  }

  function api(method, path, body) {
    return root.fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j || {} }; });
    });
  }

  /** Lấy challenge + giải PoW. Trả {challenge, nonce} hoặc {} nếu server tắt PoW. */
  async function getPow() {
    var r = await api('GET', '/api/auth/challenge');
    if (!r.ok) { var e = new Error('challenge_failed'); e.json = r.json; throw e; }
    if (!r.json || !r.json.enabled) return {};
    var nonce = await solvePow(r.json.salt, r.json.bits);
    return { challenge: r.json.token, nonce: String(nonce) };
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function isEmail(v) { return EMAIL_RE.test(String(v || '').trim()); }
  function isStrongPassword(v) { v = String(v || ''); return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v); }

  /** Khoá i18n cho một lỗi server. Mã lạ -> ap.err.generic. Không bao giờ hiện chuỗi thô của server. */
  function errorKey(json, has) {
    var code = json && json.code ? String(json.code) : '';
    if (/^pow_(?!expired)/.test(code)) code = 'pow_invalid';
    var key = 'ap.err.' + code;
    var exists = has || function (k) { var T = root.TRANSLATIONS; return !!(T && T.vi && T.vi[k]); };
    return code && exists(key) ? key : 'ap.err.generic';
  }

  /** Chỉ cho quay về /index.html (kèm query nếu có). Mọi thứ khác -> /index.html. Chống open-redirect. */
  function safeNext(raw) {
    var fallback = '/index.html';
    try {
      if (typeof raw !== 'string' || !raw || raw.length > 300) return fallback;
      if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\' || /[\u0000-\u001f\\]/.test(raw)) return fallback;
      var u = new URL(raw, 'http://x.invalid');
      if (u.origin !== 'http://x.invalid' || u.pathname !== '/index.html') return fallback;
      return u.pathname + u.search;
    } catch (e) { return fallback; }
  }

  var AuthClient = {
    session: function () { return api('GET', '/api/auth/session'); },
    login: function (email, password, remember) { return api('POST', '/api/auth/login', { email: email, password: password, remember: !!remember }); },
    signup: async function (email, password, confirmPassword, remember) {
      var pow = await getPow();
      return api('POST', '/api/auth/signup', { email: email, password: password, confirmPassword: confirmPassword, remember: !!remember, challenge: pow.challenge, nonce: pow.nonce });
    },
    forgot: async function (email) {
      var pow = await getPow();
      return api('POST', '/api/auth/forgot', { email: email, challenge: pow.challenge, nonce: pow.nonce });
    },
    isEmail: isEmail, isStrongPassword: isStrongPassword, errorKey: errorKey, safeNext: safeNext,
    _sha256: sha256Js, _leadingZeroBits: leadingZeroBits, _solvePow: solvePow
  };

  root.AuthClient = AuthClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = AuthClient;
})(typeof window !== 'undefined' ? window : globalThis);
