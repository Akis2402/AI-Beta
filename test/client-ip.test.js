'use strict';

// P7 — getClientIp(): rate limit không được tin x-forwarded-for do client tự gửi.
// Chạy: node test/client-ip.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getClientIp } = require('../server/utils/clientIp');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const req = (ip, headers) => ({ ip, headers: headers || {} });

test('hành vi cũ giữ nguyên: không env đặc biệt -> dùng req.ip', () => {
  assert.strictEqual(getClientIp(req('203.0.113.7'), {}), '203.0.113.7');
});

test('không có req.ip: lấy phần tử đầu x-forwarded-for HỢP LỆ, rác thì "unknown"', () => {
  assert.strictEqual(getClientIp(req(undefined, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }), {}), '198.51.100.9');
  assert.strictEqual(getClientIp(req(undefined, { 'x-forwarded-for': 'not-an-ip' }), {}), 'unknown');
  assert.strictEqual(getClientIp(req(undefined, {}), {}), 'unknown');
});

test('Vercel: ưu tiên x-vercel-forwarded-for dù req.ip bị giả mạo qua x-forwarded-for', () => {
  const r = req('9.9.9.9', { 'x-forwarded-for': '9.9.9.9', 'x-vercel-forwarded-for': '203.0.113.7' });
  assert.strictEqual(getClientIp(r, { VERCEL: '1' }), '203.0.113.7');
});

test('Ngoài Vercel: bỏ qua x-vercel-forwarded-for (client tự gửi được)', () => {
  const r = req('198.51.100.20', { 'x-vercel-forwarded-for': '1.2.3.4' });
  assert.strictEqual(getClientIp(r, {}), '198.51.100.20');
});

test('Vercel nhưng header thiếu/không phải IP -> rơi về req.ip', () => {
  assert.strictEqual(getClientIp(req('203.0.113.7', { 'x-vercel-forwarded-for': 'abc' }), { VERCEL: '1' }), '203.0.113.7');
  assert.strictEqual(getClientIp(req('203.0.113.7', {}), { VERCEL: '1' }), '203.0.113.7');
});

test('CLIENT_IP_HEADER (opt-in, vd Cloudflare): dùng header chỉ định, thắng cả Vercel', () => {
  const r = req('104.16.0.1', { 'cf-connecting-ip': '203.0.113.50', 'x-vercel-forwarded-for': '104.16.0.1' });
  assert.strictEqual(getClientIp(r, { CLIENT_IP_HEADER: 'CF-Connecting-IP', VERCEL: '1' }), '203.0.113.50');
});

test('CLIENT_IP_HEADER trỏ tới giá trị không phải IP -> bỏ qua, không dùng chuỗi tuỳ ý làm khoá', () => {
  const r = req('203.0.113.7', { 'cf-connecting-ip': '<script>' });
  assert.strictEqual(getClientIp(r, { CLIENT_IP_HEADER: 'cf-connecting-ip' }), '203.0.113.7');
});

test('IPv6 hợp lệ được chấp nhận', () => {
  const r = req('::1', { 'x-vercel-forwarded-for': '2001:db8::1' });
  assert.strictEqual(getClientIp(r, { VERCEL: '1' }), '2001:db8::1');
});

test('rateLimit.js dùng getClientIp (không còn đọc x-forwarded-for trực tiếp)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/middleware/rateLimit.js'), 'utf8');
  assert.ok(/require\('\.\.\/utils\/clientIp'\)/.test(src));
  assert.ok(/getClientIp\(req\)/.test(src));
  assert.ok(!/headers\['x-forwarded-for'\]/.test(src), 'rateLimit.js không được đọc x-forwarded-for trực tiếp');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
