'use strict';

// ============================================================================================
// CẤU HÌNH AUTH + QUOTA — một nơi duy nhất đọc & VALIDATE biến môi trường.
// ============================================================================================
// Quy ước tên biến (dùng đúng các tên này xuyên suốt code, migration, tài liệu):
//   AI_TOKEN_LIMIT            giới hạn token mặc định cho MỌI user (override từng user: cột ai_quota.token_limit)
//   AI_COOLDOWN_MINUTES       số phút khoá sau khi cạn quota — số nguyên trong [30, 40], mặc định 35
//   AI_MAX_CONCURRENT         số request AI đồng thời tối đa mỗi user (mặc định 2)
//   AI_RESERVATION_TTL_SECONDS  reservation tự hết hạn (phải > thời gian chạy tối đa của function; mặc định 330s > maxDuration 300s)
//   AI_RESERVE_CHAT / _GENERATE / _RECOMMEND / _STUDY / _SOURCE / _VISUAL   token đặt chỗ ban đầu theo loại request
//   AI_IMAGE_TOKEN_COST       ảnh KHÔNG tính bằng token LLM: mỗi ảnh server sinh thành công bị tính một mức token-tương-đương cố định
//                             (mặc định 4000) vào CÙNG hạn mức/cooldown, để không ai sinh ảnh vô hạn được
//   AUTH_SIGNUP_POW_BITS      độ khó proof-of-work khi ĐĂNG KÝ (số bit 0 đầu của SHA-256; 0 = tắt; mặc định 16 ≈ 1 giây)
//   RATE_LIMIT_SIGNUP         số lần đăng ký tối đa / giờ / IP (mặc định 5)
//   AUTH_POW_SECRET           khóa ký challenge (mặc định: dẫn xuất từ SUPABASE_SERVICE_ROLE_KEY)
//   AUTH_REDIRECT_URL         URL trang web mà link “đặt lại mật khẩu” trong email đưa người dùng về (tuỳ chọn; phải nằm trong
//                             Supabase -> Authentication -> URL Configuration -> Redirect URLs; trống = dùng Site URL)
//   SUPABASE_URL, SUPABASE_ANON_KEY (hoặc NEXT_PUBLIC_*), SUPABASE_SERVICE_ROLE_KEY (CHỈ server)
//   AUTH_ENFORCEMENT          'on' (mặc định) | 'off' — 'off' bị CẤM khi NODE_ENV=production
//
// Giá trị SAI -> ném lỗi rõ ràng ngay lúc nạp (không âm thầm quay về mặc định).

class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; this.code = 'CONFIG_ERROR'; }
}

function readInt(env, name, def, { min, max } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new ConfigError(`${name} phải là số nguyên dương, nhận được "${s}".`);
  const n = Number(s);
  if (min !== undefined && n < min) throw new ConfigError(`${name} phải >= ${min}, nhận được ${n}.`);
  if (max !== undefined && n > max) throw new ConfigError(`${name} phải <= ${max}, nhận được ${n}.`);
  return n;
}

/** URL tuỳ chọn (http/https). Trống => ''. Sai định dạng => ConfigError (không âm thầm bỏ qua). */
function readUrl(env, name) {
  const raw = String(env[name] || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch (_) { throw new ConfigError(`${name} phải là URL hợp lệ, nhận được "${raw}".`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError(`${name} phải bắt đầu bằng https:// (hoặc http:// khi dev).`);
  return u.toString();
}

const RESERVE_DEFAULTS = Object.freeze({ chat: 8000, generate: 4000, recommend: 3000, study: 3000, source: 6000, visual: 4000 });

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  const enforcementRaw = String(env.AUTH_ENFORCEMENT || 'on').trim().toLowerCase();
  if (enforcementRaw !== 'on' && enforcementRaw !== 'off') {
    throw new ConfigError(`AUTH_ENFORCEMENT chỉ nhận 'on' hoặc 'off', nhận được "${enforcementRaw}".`);
  }
  if (enforcementRaw === 'off' && nodeEnv === 'production') {
    throw new ConfigError('AUTH_ENFORCEMENT=off bị CẤM khi NODE_ENV=production (sẽ tắt toàn bộ xác thực + quota).');
  }

  const supabaseUrl = String(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  if (supabaseUrl && !/^https?:\/\//i.test(supabaseUrl)) throw new ConfigError('SUPABASE_URL phải bắt đầu bằng https://');

  const reserve = {};
  for (const [kind, def] of Object.entries(RESERVE_DEFAULTS)) {
    reserve[kind] = readInt(env, `AI_RESERVE_${kind.toUpperCase()}`, def, { min: 500, max: 200000 });
  }

  return Object.freeze({
    enforcement: enforcementRaw === 'on',
    production: nodeEnv === 'production',
    supabase: Object.freeze({
      url: supabaseUrl,
      anonKey,
      serviceKey,
      configured: Boolean(supabaseUrl && anonKey && serviceKey)
    }),
    auth: Object.freeze({
      powBits: readInt(env, 'AUTH_SIGNUP_POW_BITS', 16, { min: 0, max: 24 }),
      signupPerHour: readInt(env, 'RATE_LIMIT_SIGNUP', 5, { min: 1, max: 1000 }),
      powSecret: String(env.AUTH_POW_SECRET || '').trim(),
      redirectUrl: readUrl(env, 'AUTH_REDIRECT_URL')
    }),
    quota: Object.freeze({
      tokenLimit: readInt(env, 'AI_TOKEN_LIMIT', 100000, { min: 1000 }),
      imageTokenCost: readInt(env, 'AI_IMAGE_TOKEN_COST', 4000, { min: 100, max: 200000 }),
      cooldownMinutes: readInt(env, 'AI_COOLDOWN_MINUTES', 35, { min: 30, max: 40 }),
      maxConcurrent: readInt(env, 'AI_MAX_CONCURRENT', 2, { min: 1, max: 20 }),
      reservationTtlSeconds: readInt(env, 'AI_RESERVATION_TTL_SECONDS', 330, { min: 60, max: 3600 }),
      minRequestTokens: readInt(env, 'AI_MIN_REQUEST_TOKENS', 500, { min: 100 }),
      reserve: Object.freeze(reserve)
    })
  });
}

let cached = null;
/** Nạp 1 lần; lỗi cấu hình ném ngay. */
function getConfig() {
  if (!cached) cached = loadConfig(process.env);
  return cached;
}
function _resetConfigForTest() { cached = null; }

module.exports = { loadConfig, getConfig, ConfigError, RESERVE_DEFAULTS, _resetConfigForTest };
