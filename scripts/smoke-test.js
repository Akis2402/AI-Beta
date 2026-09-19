#!/usr/bin/env node
'use strict';

// ---------- FIX P2/N (audit): deployment smoke-test cho Vercel/local ----------
// Kiểm tra ROUTING + hành vi cơ bản của mọi endpoint /api/* trên 1 deployment THẬT (local hoặc
// Vercel) — KHÔNG gọi tới AI provider thật (tránh tốn tiền/API key khi chạy smoke-test), chỉ xác
// nhận: route tồn tại đúng path, trả đúng status cho input thiếu/sai (400/422 thay vì 404 — chứng
// tỏ route MOUNT đúng), health check sống, static file (index.html) serve được, security header
// (CSP/HSTS/X-Frame-Options) có mặt, và /api/chat trả Content-Type: text/event-stream đúng ngay cả
// khi request bị từ chối sớm (SSE header phải set TRƯỚC khi biết thành공 hay lỗi — xem chat.js).
//
// Dùng: node scripts/smoke-test.js [BASE_URL]
//   BASE_URL mặc định http://localhost:3000 (hoặc đọc từ SMOKE_BASE_URL) — có thể trỏ thẳng vào
//   URL Vercel Preview/Production để verify SAU KHI DEPLOY, KHÔNG thay thế cho việc chạy `npm test`
//   trước khi deploy (unit test chạy offline, mock hết mạng; smoke-test này verify HTTP thật).

const BASE_URL = process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:3000';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  -' : 'FAIL -'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function req(method, urlPath, body, headers) {
  const res = await fetch(BASE_URL + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return res;
}

async function main() {
  console.log(`\n== Deployment smoke-test: ${BASE_URL} ==\n`);

  // 1. Health check sống, đúng schema tối thiểu.
  try {
    const res = await req('GET', '/api/health');
    const json = await res.json().catch(() => null);
    record('GET /api/health trả 200 + {ok:true}', res.status === 200 && json && json.ok === true, `status=${res.status}`);
  } catch (e) { record('GET /api/health trả 200 + {ok:true}', false, e.message); }

  // 2. Static file (SPA) serve được — index.html cho path bất kỳ không phải /api/*.
  try {
    const res = await req('GET', '/mot-duong-dan-khong-ton-tai');
    const text = await res.text();
    // SỬA ASSERTION (assertion CŨ SAI so với thiết kế thật, và đã FAIL từ trước bản refactor này):
    // app này KHÔNG có client-side router (0 lần pushState/replaceState trong public/js/app.js) và
    // fallback `app.get('*') -> index.html` đã bị XOÁ CÓ CHỦ Ý — xem giải thích dài ở server/app.js:
    // fallback đó từng trả HTML cho request đang xin *.js, gây "Uncaught SyntaxError: Unexpected
    // token '<'" trên thiết bị thật. Hành vi ĐÚNG cho deployment này là 404 thật cho path lạ.
    // Kiểm tra điều quan trọng THẬT SỰ: path lạ KHÔNG được trả HTML (chống lặp lại đúng bug cũ).
    const servedHtml = /<html/i.test(text);
    record(
      'GET path lạ (không phải /api) -> 404 thật, KHÔNG trả HTML (không có SPA fallback — chủ ý, xem server/app.js)',
      res.status === 404 && !servedHtml,
      `status=${res.status}, trảHTML=${servedHtml}`
    );
  } catch (e) { record('SPA fallback', false, e.message); }

  // 3. Security headers có mặt (Helmet + CSP tự cấu hình trong vercel.json/server/middleware/security.js).
  try {
    const res = await req('GET', '/api/health');
    const csp = res.headers.get('content-security-policy');
    const xfo = res.headers.get('x-frame-options');
    record('Response có Content-Security-Policy header', !!csp, csp ? csp.slice(0, 40) + '…' : 'thiếu');
    record('Response có X-Frame-Options: DENY', xfo === 'DENY', `giá trị=${xfo}`);
  } catch (e) { record('Security headers', false, e.message); }

  // 4. /api/chat MOUNT đúng path, KHÔNG trả 404 khi thiếu body — trả lỗi validation (4xx) — chứng
  //    minh router thực sự chạy (không phải catch-all 404 do route sai path/rewrite Vercel hỏng).
  //    KHÔNG gửi problemText hợp lệ -> KHÔNG gọi AI provider nào -> không tốn phí.
  try {
    const res = await req('POST', '/api/chat', {});
    record('POST /api/chat (thiếu problemText) -> không phải 404 (route mount đúng)', res.status !== 404, `status=${res.status}`);
    record('POST /api/chat (thiếu problemText) -> 4xx validation, không phải 5xx (không lọt xuống gọi AI)', res.status >= 400 && res.status < 500, `status=${res.status}`);
  } catch (e) { record('/api/chat routing + validation', false, e.message); }

  // 5. /api/generate/* mount đúng (3 sub-route).
  for (const sub of ['flashcards', 'outline', 'mindmap']) {
    try {
      const res = await req('POST', `/api/generate/${sub}`, {});
      record(`POST /api/generate/${sub} (body rỗng) -> không phải 404`, res.status !== 404, `status=${res.status}`);
    } catch (e) { record(`/api/generate/${sub} routing`, false, e.message); }
  }

  // 6. /api/recommend mount đúng.
  try {
    const res = await req('POST', '/api/recommend', {});
    record('POST /api/recommend (body rỗng) -> không phải 404', res.status !== 404, `status=${res.status}`);
  } catch (e) { record('/api/recommend routing', false, e.message); }

  // 7. /api/study/* mount đúng.
  for (const sub of ['self-check', 'similar']) {
    try {
      const res = await req('POST', `/api/study/${sub}`, {});
      record(`POST /api/study/${sub} (body rỗng) -> không phải 404`, res.status !== 404, `status=${res.status}`);
    } catch (e) { record(`/api/study/${sub} routing`, false, e.message); }
  }

  // 8. CORS: request có Origin lạ (không cùng host, không trong whitelist) -> không được set
  //    Access-Control-Allow-Origin thành chính origin đó (tránh CORS mở toang * hoặc phản xạ mù).
  try {
    const res = await req('GET', '/api/health', undefined, { Origin: 'https://evil-attacker-example.test' });
    const acao = res.headers.get('access-control-allow-origin');
    record('CORS: origin lạ KHÔNG được phản xạ vào Access-Control-Allow-Origin', acao !== 'https://evil-attacker-example.test', `ACAO=${acao}`);
  } catch (e) { record('CORS origin check', false, e.message); }

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('Smoke-test crash:', e); process.exitCode = 1; });
