'use strict';

/*
 * scripts/build.js — chạy TỰ ĐỘNG bởi Vercel (vercel.json: "buildCommand": "npm run build")
 * NGAY TRƯỚC KHI thư mục `public/` được snapshot làm output tĩnh của deployment đó.
 *
 * MỤC ĐÍCH (khớp PHẦN 4 của yêu cầu audit): không phụ thuộc "?v=..." hard-code để cache-bust. Thay vào đó:
 *   1. Đọc nội dung THẬT của từng file JS/CSS.
 *   2. Băm nội dung (sha256, 10 hex đầu) -> ghi bản "<tên>.<hash>.<ext>" cạnh file nguồn.
 *   3. Ghi đè từng trang HTML để mọi <script src>/<link href> trỏ đúng tên đã hash.
 *   4. Ghi public/asset-manifest.json để scripts/check-static-assets.js và test HTTP xác minh lại.
 * Nội dung đổi -> hash đổi -> URL đổi: 2 deployment không bao giờ dùng chung 1 URL cho 2 nội dung khác nhau
 * (triệt tiêu lỗi "HTML mới + JS cũ" / "Identifier ... already been declared").
 *
 * NHIỀU TRANG: trước đây chỉ có public/index.html. Nay có 3 trang (index.html = app, landing.html = trang
 * giới thiệu ở "/", auth.html = trang đăng nhập ở "/auth"), mỗi trang khai báo danh sách asset riêng trong PAGES.
 * Asset dùng chung (i18n, mascot) được băm MỘT lần và thay vào mọi trang cần. Trang thiếu thẻ cho một asset
 * trong danh sách của nó -> build DỪNG (không tự chèn lại) để tránh deploy thiếu asset.
 *
 * File nguồn trong repo giữ tên KHÔNG hash (template). Bản hash được ghi trong container build, không commit ngược.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const publicDir = path.join(__dirname, '..', 'public');

const CORE_JS = [
  'boot.js',
  'payloadBudget.js', // PHẦN A: ngân sách payload dùng chung client/server
  'storage.js',
  'imageStorage.js',
  'config.js',
  'formulas.js',
  'subjects.js',
  'solid3d.js',
  'exprEval.js', // PHẦN C: trình tính biểu thức an toàn dưới CSP (thay new Function)
  'scene3d.js', // PHẦN J-S: engine 3D mới (compact scene JSON + patch)
  'voiceInput.js', // PHẦN D: nhập bằng giọng nói (Web Speech API, xử lý hoàn toàn trong trình duyệt)
  'app.js',
];
const I18N_JS = ['translations.js', 'languageStore.js', 'i18n.js'];
const PROVIDER_JS = ['puterAdapter.js', 'providerRouter.js'];
const VISUAL_JS = ['puterVisualManager.js'];
// Puter Auth UI + đăng nhập Supabase/quota/Asset Manager + zoom/pan cho lightbox SVG + Akis đồng hành.
// mascotCompanion.js PHẢI nạp SAU app.js (xem thứ tự thẻ trong index.html).
const UI_JS = ['puterAuthUI.js', 'authUI.js', 'visualViewer.js', 'mascotCompanion.js'];
const TASK_JS = ['conversationTaskManager.js', 'backgroundTaskUI.js'];
const CORE_CSS = ['styles.css'];
// Linh vật Akis: ảnh gốc của người dùng nhúng dạng data URI (akisImage.js) + lớp điều khiển (mascot.js).
const MASCOT_JS = ['akisImage.js', 'mascot.js'];

/** Mỗi trang: file HTML + danh sách [thư mục con của public/, [tên file]] mà trang đó PHẢI tham chiếu. */
const PAGES = [
  {
    file: 'index.html',
    groups: [
      ['js', CORE_JS], ['js/i18n', I18N_JS], ['js/providers', PROVIDER_JS], ['js/visual', VISUAL_JS],
      ['js/ui', UI_JS], ['js/tasks', TASK_JS], ['js/mascot', MASCOT_JS],
      ['css', CORE_CSS], ['css', ['mascot.css']],
    ],
  },
  {
    file: 'landing.html',
    groups: [
      ['js/i18n', I18N_JS], ['js/mascot', MASCOT_JS], ['js/pages', ['landing.js']],
      ['css', ['site.css', 'mascot.css', 'landing.css']],
    ],
  },
  {
    file: 'auth.html',
    groups: [
      ['js/i18n', I18N_JS], ['js/mascot', MASCOT_JS], ['js/auth', ['authClient.js']], ['js/pages', ['auth.js']],
      ['css', ['site.css', 'mascot.css', 'auth.css']],
    ],
  },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

/** Xoá các bản hash CŨ của cùng 1 file nguồn (tránh phình public/ sau nhiều lần build). */
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

/**
 * Regex khớp mọi cách đang tham chiếu tới asset này trong HTML: tên gốc, tên đã-hash cũ, hoặc kèm ?v=...
 * Cờ `g` + `.test()` làm lastIndex nhích đi — người gọi PHẢI reset lastIndex = 0 trước khi dùng `.replace()`.
 */
function buildTagRegex(relDir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  const pattern =
    `(["'])/${escapeRegExp(relDir)}/${escapeRegExp(stem)}` +
    `(?:\\.[0-9a-f]{10})?${escapeRegExp(ext)}(?:\\?[^"']*)?\\1`;
  return new RegExp(pattern, 'g');
}

function main() {
  const manifest = { generatedAt: new Date().toISOString(), assets: {}, pages: {} };
  const done = new Map(); // "relDir/name" -> info (asset dùng chung chỉ băm 1 lần)

  for (const page of PAGES) {
    const htmlPath = path.join(publicDir, page.file);
    if (!fs.existsSync(htmlPath)) {
      throw new Error(`[build] Không tìm thấy public/${page.file} — kiểm tra lại outputDirectory.`);
    }
    let html = fs.readFileSync(htmlPath, 'utf8');
    manifest.pages[page.file] = [];

    for (const [relDir, list] of page.groups) {
      for (const name of list) {
        const key = `${relDir}/${name}`;
        let info = done.get(key);
        if (!info) { info = fingerprintAsset(relDir, name); done.set(key, info); }

        const re = buildTagRegex(relDir, name);
        if (!re.test(html)) {
          throw new Error(
            `[build] ${page.file} KHÔNG có thẻ tham chiếu tới /${relDir}/${name} — có thể đã bị xoá ` +
            `nhầm. Dừng build (không đoán/tự chèn lại) để tránh deploy thiếu asset.`
          );
        }
        re.lastIndex = 0;
        html = html.replace(re, `$1${info.urlPath}$1`);

        if (manifest.assets[name] && manifest.assets[name] !== info.urlPath) {
          throw new Error(`[build] Tên asset "${name}" trùng giữa 2 thư mục khác nhau — manifest khoá theo tên nên phải đổi tên 1 file.`);
        }
        manifest.assets[name] = info.urlPath;
        manifest.pages[page.file].push(name);
      }
    }
    fs.writeFileSync(htmlPath, html, 'utf8');
  }

  fs.writeFileSync(path.join(publicDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`[build] Fingerprint xong ${Object.keys(manifest.assets).length} asset cho ${PAGES.length} trang:`);
  for (const [k, v] of Object.entries(manifest.assets)) console.log(`  ${k} -> ${v}`);
  console.log('[build] Đã ghi public/asset-manifest.json và cập nhật ' + PAGES.map((p) => 'public/' + p.file).join(', ') + '.');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { main, hashOf, buildTagRegex, CORE_JS, CORE_CSS, VISUAL_JS, UI_JS, MASCOT_JS, PAGES };
