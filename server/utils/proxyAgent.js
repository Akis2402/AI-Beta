'use strict';

// ============================================================================================
// MỤC 2 (backlog v6.22) — PROXY CHO NGUỒN YOUTUBE (Lớp A)
// ============================================================================================
// Vì sao cần: safeHttp.fetchPinned() tự resolve DNS rồi GHIM IP (chống SSRF) và kết nối TRỰC TIẾP
// bằng IP outbound của server. Trên Vercel/cloud, dải IP datacenter có thể bị YouTube chặn/giới hạn
// ("Sign in to confirm you're not a bot"/429) -> MỌI video rơi về INCOMPLETE. Proxy là điểm cắm duy
// nhất để đổi IP outbound.
//
// RANH GIỚI BẢO MẬT (không được nới): module này CHỈ dùng cho youtubeSource.js. fetchPinned() còn tự
// kiểm hostname đích thuộc miền YouTube khi có proxyUrl (xem PROXY_ALLOWED_HOST_RE ở safeHttp.js).
// webSource.js (URL do người dùng dán) TUYỆT ĐỐI không import module này — proxy không tin cậy + đích
// tuỳ ý = mất hoàn toàn giá trị DNS pinning (test/youtube-proxy.test.js kiểm bằng grep).
//
// Thư viện agent nạp LƯỜI (require trong hàm): khi YOUTUBE_PROXY_URL trống, không ai nạp chúng —
// đường chạy mặc định không đổi 1 byte so với trước.

const SUPPORTED = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const agentCache = new Map();

/**
 * Parse `YOUTUBE_PROXY_URL` theo đúng convention đa giá trị của dự án (GEMINI_API_KEY=key1,key2).
 * Bỏ qua mục rỗng/không hợp lệ (không ném lỗi: cấu hình sai không được làm sập server).
 * @param {string} [raw]
 * @returns {string[]}
 */
function parseProxyList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!v) continue;
    let u;
    try { u = new URL(v); } catch (e) { continue; }
    if (!SUPPORTED.has(u.protocol) || !u.hostname) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Che user:pass khi log. */
function redactProxyUrl(proxyUrl) {
  try { const u = new URL(proxyUrl); return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`; } catch (e) { return 'invalid-proxy-url'; }
}

/**
 * @param {string} proxyUrl
 * @returns {import('http').Agent} HttpsProxyAgent (http/https) hoặc SocksProxyAgent (socks*)
 */
function buildProxyAgent(proxyUrl) {
  if (agentCache.has(proxyUrl)) return agentCache.get(proxyUrl);
  const protocol = new URL(proxyUrl).protocol;
  if (!SUPPORTED.has(protocol)) throw new Error(`proxy protocol không hỗ trợ: ${protocol}`);
  let agent;
  if (protocol.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    agent = new SocksProxyAgent(proxyUrl);
  } else {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    agent = new HttpsProxyAgent(proxyUrl);
  }
  agentCache.set(proxyUrl, agent);
  return agent;
}

/**
 * Round-robin đơn giản + cooldown trong bộ nhớ tiến trình (đủ cho scope này; KHÔNG cắm vào
 * rotationManager.js — đó là hạ tầng cho AI provider). Proxy vừa lỗi bị nghỉ `cooldownMs`.
 * @param {string[]} list
 * @param {{cooldownMs?:number, now?:()=>number}} [opts]
 */
function createProxyRotator(list, { cooldownMs = 60000, now = Date.now } = {}) {
  const proxies = Array.isArray(list) ? list.slice() : [];
  const coolUntil = new Map();
  let cursor = 0;
  return {
    size: proxies.length,
    /** Proxy kế tiếp KHÔNG đang cooldown; null nếu rỗng hoặc tất cả đang nghỉ. */
    next() {
      for (let i = 0; i < proxies.length; i++) {
        const p = proxies[(cursor + i) % proxies.length];
        if ((coolUntil.get(p) || 0) <= now()) { cursor = (cursor + i + 1) % proxies.length; return p; }
      }
      return null;
    },
    markFailed(p) { coolUntil.set(p, now() + cooldownMs); },
    markOk(p) { coolUntil.delete(p); }
  };
}

module.exports = { parseProxyList, buildProxyAgent, createProxyRotator, redactProxyUrl, SUPPORTED };
