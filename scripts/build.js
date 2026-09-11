'use strict';

/*
 * scripts/build.js — chạy TỰ ĐỘNG bởi Vercel (xem vercel.json: "buildCommand": "npm run build")
 * NGAY TRƯỚC KHI thư mục `public/` được snapshot làm output tĩnh của deployment đó.
 *
 * MỤC ĐÍCH DUY NHẤT (khớp PHẦN 4 của yêu cầu audit): loại bỏ hoàn toàn việc phụ thuộc vào 1 con số
 * "?v=..." hard-code trong index.html để cache-bust. Thay vào đó:
 *   1. Đọc nội dung THẬT của từng file JS/CSS "core".
 *   2. Băm nội dung đó (sha256, lấy 10 ký tự hex đầu) -> đổi tên file thành "<tên>.<hash>.<ext>".
 *   3. Ghi đè lại index.html để mọi <script src>/<link href> trỏ đúng tên file đã hash đó.
 *   4. Ghi ra public/asset-manifest.json để scripts/check-static-assets.js và test HTTP có thể xác
 *      minh lại (không đoán mò) rằng deployment thật sự phục vụ đúng asset vừa build.
 *
 * Vì bước này chạy LẠI TỪ ĐẦU trên 1 checkout sạch cho MỖI deployment (đúng mô hình build của
 * Vercel), 2 deployment KHÔNG BAO GIỜ có thể vô tình dùng chung 1 URL asset cho 2 nội dung khác
 * nhau nữa -> triệt tiêu tận gốc lớp lỗi "HTML mới + JS cũ" / "HTML cũ + JS mới" /
 * "Identifier ... already been declared" do version bị giữ lại giữa các lần deploy.
 *
 * File nguồn public/index.html trong repo CỐ Ý giữ tên KHÔNG hash (vd "/js/app.js") — đó là
 * template. Script này ghi đè bản ĐÃ hash vào chính public/index.html trong quá trình build (diễn
 * ra trong container build tạm thời của Vercel), KHÔNG commit ngược thay đổi đó về git.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const publicDir = path.join(__dirname, '..', 'public');
const indexHtmlPath = path.join(publicDir, 'index.html');

// Thứ tự này chỉ để liệt kê đủ file — KHÔNG quyết định thứ tự <script> thật trong index.html
// (thứ tự thật đọc trực tiếp từ chính index.html, xem PHẦN 8 của yêu cầu audit).
const CORE_JS = [
  'boot.js',
  'analytics.js', // Vercel Web Analytics initialization
  'storage.js',
  'imageStorage.js',
  'config.js',
  'formulas.js',
  'subjects.js',
  'solid3d.js',
  'scene3d.js', // PHẦN J-S: engine 3D mới (compact scene JSON + patch)
  'geo2d-engine.js',
  'app.js',
];
// PHẦN T-AZ (i18n) / A-C (Puter) / E-I (task manager): asset mới nằm ở thư mục con riêng —
// fingerprint từng nhóm bằng process() riêng (mỗi nhóm 1 relDir) thay vì gộp chung CORE_JS.
const I18N_JS = ['translations.js', 'languageStore.js', 'i18n.js'];
const PROVIDER_JS = ['puterAdapter.js', 'providerRouter.js'];
const TASK_JS = ['conversationTaskManager.js'];
const CORE_CSS = ['styles.css'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

// Dọn các bản đã-hash TỪ LẦN BUILD TRƯỚC (nếu script này từng chạy trong cùng 1 checkout, vd khi
// chạy `npm run build` nhiều lần ở local) để không tích tụ file rác theo thời gian.
function cleanPreviousHashed(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  const re = new RegExp(`^${escapeRegExp(stem)}\\.[0-9a-f]{10}${escapeRegExp(ext)}$`, 'i');
  for (const f of fs.readdirSync(dir)) {
    if (re.test(f)) fs.unlinkSync(path.join(dir, f));
  }
}

function fingerprintAsset(relDir, baseName) {
  const dir = path.join(publicDir, relDir);
  const srcPath = path.join(dir, baseName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`[build] THIẾU asset bắt buộc: public/${relDir}/${baseName} không tồn tại trên đĩa.`);
  }
  const content = fs.readFileSync(srcPath);
  const hash = hashOf(content);
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  const hashedName = `${stem}.${hash}${ext}`;

  cleanPreviousHashed(dir, baseName);
  fs.writeFileSync(path.join(dir, hashedName), content);

  return { baseName, hashedName, hash, urlPath: `/${relDir}/${hashedName}` };
}

// Khớp thẻ <script src="..."> / <link href="..."> trỏ tới asset này ở BẤT KỲ dạng nào từng tồn
// tại trước đây (không version, ?v=<số>, hoặc đã có hash từ lần build trước) rồi thay bằng URL đã
// hash MỚI NHẤT — nhờ vậy script này idempotent (chạy lại nhiều lần vẫn ra kết quả đúng).
function buildTagRegex(relDir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  const pattern =
    `(["'])/${escapeRegExp(relDir)}/${escapeRegExp(stem)}` +
    `(?:\\.[0-9a-f]{10})?${escapeRegExp(ext)}(?:\\?[^"']*)?\\1`;
  return new RegExp(pattern);
}

function main() {
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error('[build] Không tìm thấy public/index.html — kiểm tra lại outputDirectory.');
  }
  let html = fs.readFileSync(indexHtmlPath, 'utf8');
  const manifest = { generatedAt: new Date().toISOString(), assets: {} };

  function process(relDir, list) {
    for (const name of list) {
      const info = fingerprintAsset(relDir, name);
      const re = buildTagRegex(relDir, name);
      if (!re.test(html)) {
        throw new Error(
          `[build] index.html KHÔNG có thẻ tham chiếu tới /${relDir}/${name} — có thể đã bị xoá ` +
          `nhầm khỏi index.html. Dừng build (không đoán/tự chèn lại) để tránh deploy thiếu asset.`
        );
      }
      html = html.replace(re, `$1${info.urlPath}$1`);
      manifest.assets[name] = info.urlPath;
    }
  }

  process('js', CORE_JS);
  process('js/i18n', I18N_JS);
  process('js/providers', PROVIDER_JS);
  process('js/tasks', TASK_JS);
  process('css', CORE_CSS);

  fs.writeFileSync(indexHtmlPath, html, 'utf8');
  fs.writeFileSync(
    path.join(publicDir, 'asset-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );

  console.log(`[build] Fingerprint xong ${Object.keys(manifest.assets).length} asset:`);
  for (const [k, v] of Object.entries(manifest.assets)) console.log(`  ${k} -> ${v}`);
  console.log('[build] Đã ghi public/asset-manifest.json và cập nhật public/index.html.');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { main, hashOf, buildTagRegex, CORE_JS, CORE_CSS };
