#!/usr/bin/env python3
"""
E2E trình duyệt THẬT (Chromium/Playwright) cho Hybrid Visual Engine + Puter Auth.
- Phục vụ public/ bằng CSP THẬT lấy từ vercel.json; /api/chat được mock (SSE) bằng payload do pipeline THẬT sinh ra.
- SDK Puter (https://js.puter.com/v2/) bị chặn ở mạng sandbox nên được GIẢ LẬP bằng page.route: nó đếm signIn/txt2img và
  đếm `unauthCall` = số lần puter.ai.* bị gọi khi chưa đăng nhập (SDK thật sẽ mở popup ở đúng thời điểm đó) — phải = 0.
=> Đây KHÔNG chứng minh hành vi của Puter thật; nó chứng minh CODE CỦA ỨNG DỤNG không bao giờ tự kích hoạt Auth.
"""
import json, os, subprocess, sys, threading, time, datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PUBLIC = os.path.join(ROOT, 'public')
SHOTS = os.environ.get('E2E_SHOTS', '/tmp/e2e')
os.makedirs(SHOTS, exist_ok=True)
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print('SKIPPED — không có playwright:', e); sys.exit(0)

# ---------- server THẬT: static (CSP thật) + route /api/chat THẬT (express-shim), upstream AI stub ----------
import urllib.request, socket
def free_port():
    sk = socket.socket(); sk.bind(('127.0.0.1', 0)); p = sk.getsockname()[1]; sk.close(); return p
PORT = free_port()
SRV = subprocess.Popen(['node', os.path.join(ROOT, 'test', 'e2e', 'chat_server.js'), str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT)
line = SRV.stdout.readline()
assert line.startswith('READY'), 'server không khởi động: ' + line
BASE = f'http://127.0.0.1:{PORT}/'
def srv_stats():
    return json.loads(urllib.request.urlopen(BASE + '__stats').read())
import atexit; atexit.register(lambda: SRV.kill())

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
FAKE_SDK = r'''
(function(){
  const S = window.__puter = { signIn:0, txt2img:0, unauthCall:0, isSignedIn:0, opens:0 };
  const KEY='fake_puter_signed';
  window.puter = {
    auth: {
      isSignedIn(){ S.isSignedIn++; return localStorage.getItem(KEY)==='1'; },
      signIn(){ S.signIn++; return new Promise((res)=>setTimeout(()=>{ localStorage.setItem(KEY,'1'); res({token:'x'}); },250)); },
      signOut(){ localStorage.removeItem(KEY); return Promise.resolve(); },
      getUser(){ return Promise.resolve({username:'hoc_sinh_e2e'}); }
    },
    ai: {
      txt2img(prompt, opts){ S.txt2img++; if(localStorage.getItem(KEY)!=='1') S.unauthCall++; return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.src='data:image/png;base64,__PNG__'; }); },
      chat(){ if(localStorage.getItem(KEY)!=='1') S.unauthCall++; return Promise.resolve({text:'x'}); }
    }
  };
})();
'''.replace('__PNG__', PNG)
INIT = 'window.__opens=0; const _o=window.open; window.open=function(){ window.__opens++; return null; };'

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail)); print(('  ok  - ' if cond else ' FAIL - ') + name + ('' if cond else f'   [{detail}]'))

def new_page(ctx, errors):
    p = ctx.new_page()
    p.add_init_script(INIT)
    p.route('https://js.puter.com/v2/', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE_SDK))
    p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    p.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
    return p

def stats(p): return p.evaluate('()=>({...window.__puter, opens: window.__opens})')
def today(): d = datetime.date.today(); return d.isoformat()

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])
    # ===================== 1. Tải trang chưa Auth: chỉ THÔNG BÁO, không popup =====================
    print('\n== E2E-1. Tải trang chưa Auth ==')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 1280, 'height': 820}); errors = []; page = new_page(ctx, errors)
    page.goto(BASE); page.wait_for_load_state('networkidle')
    check('1a. mục Settings Puter tồn tại trong DOM', page.locator('#puterAuthSection').count() == 1)
    check('1b. chưa hiện thông báo ngay lúc load (chờ trạng thái + 1,2 s)', page.locator('#puterAuthNotice').count() == 0)
    page.wait_for_selector('#puterAuthNotice', timeout=6000)
    body = page.locator('#puterNoticeBody').inner_text()
    check('1c. thông báo hiện ĐÚNG NGUYÊN VĂN', body == 'Phần tạo hình ảnh bằng AI chưa dùng được vì chưa Auth Puter.js, hãy Auth trong setting. Các tính năng khác thì không sao.', body)
    s = stats(page)
    check('1d. KHÔNG popup Auth: signIn=0, window.open=0, puter.ai gọi khi chưa đăng nhập=0', s['signIn'] == 0 and s['opens'] == 0 and s['unauthCall'] == 0 and s['txt2img'] == 0, str(s))
    check('1e. đúng 3 nút hành động', page.locator('#puterAuthNotice button').count() == 3)
    page.locator('#puterAuthNotice').screenshot(path=f'{SHOTS}/e2e_notice_desktop.png')
    csp = [e for e in errors if 'Content Security Policy' in e or 'PAGEERROR' in e]
    check('1f. không vi phạm CSP / không lỗi JS khi tải trang', not csp, str(csp[:2]))

    # ===================== 2. Hai kiểu tắt thông báo =====================
    print('\n== E2E-2. Đóng thông báo ==')
    page.locator('#puterAuthNotice button', has_text='Đã hiểu').click()
    check('2a. "Đã hiểu" đóng thông báo', page.locator('#puterAuthNotice').count() == 0)
    check('2b. "Đã hiểu" KHÔNG lưu gì', page.evaluate("()=>localStorage.getItem('tro-giai:puter-notice-dismissed-until')") is None)
    page.reload(); page.wait_for_selector('#puterAuthNotice', timeout=6000)
    check('2c. tải lại trang -> thông báo hiện lại (tắt một lần)', True)
    page.locator('#puterAuthNotice button', has_text='Không hiển thị lại hôm nay').click()
    check('2d. đã lưu dismissedUntilDate = ngày lịch hôm nay', page.evaluate("()=>localStorage.getItem('tro-giai:puter-notice-dismissed-until')") == today(), page.evaluate("()=>localStorage.getItem('tro-giai:puter-notice-dismissed-until')"))
    page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(2600)
    check('2e. cùng ngày, tải lại -> KHÔNG hiện', page.locator('#puterAuthNotice').count() == 0)
    yest = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    page.evaluate("(y)=>localStorage.setItem('tro-giai:puter-notice-dismissed-until', y)", yest)
    page.reload(); page.wait_for_selector('#puterAuthNotice', timeout=6000)
    check('2f. sang ngày mới (ngày lưu < hôm nay) -> hiện lại', True)
    page.evaluate("()=>localStorage.removeItem('tro-giai:puter-notice-dismissed-until')")

    # ===================== 3. Mở Settings + Auth bằng click thật =====================
    print('\n== E2E-3. Settings -> Auth ==')
    page.locator('#puterAuthNotice button', has_text='Mở Settings').click()
    page.wait_for_selector('#settingsOverlay.show', timeout=3000)
    check('3a. "Mở Settings" mở modal + KHÔNG gọi signIn', stats(page)['signIn'] == 0 and page.locator('#puterAuthNotice').count() == 0)
    check('3b. mục Puter hiển thị trạng thái "Chưa Auth"', '○ Chưa Auth' in page.locator('#puterAuthStatus').inner_text(), page.locator('#puterAuthStatus').inner_text())
    check('3c. nút Auth khả dụng, chưa có Đăng xuất', page.locator('#puterAuthBtn').is_enabled() and not page.locator('#puterSignOutBtn').is_visible())
    page.locator('#puterAuthSection').screenshot(path=f'{SHOTS}/e2e_settings_unauth.png')
    page.locator('#puterAuthBtn').click()
    page.wait_for_function("()=>document.getElementById('puterAuthStatus').textContent.includes('Đã Auth')", timeout=4000)
    s = stats(page)
    check('3d. click THẬT -> đúng 1 lần puter.auth.signIn()', s['signIn'] == 1, str(s))
    check('3e. Đã Auth: hiện username, nút chuyển thành Re-Auth, có Đăng xuất — KHÔNG reload trang', 'hoc_sinh_e2e' in page.locator('#puterAuthUser').inner_text() and page.locator('#puterAuthBtn').inner_text() == 'Re-Auth' and page.locator('#puterSignOutBtn').is_visible())
    page.locator('#puterAuthSection').screenshot(path=f'{SHOTS}/e2e_settings_authed.png')
    page.evaluate("()=>document.getElementById('settingsCloseBtn').click()")
    page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(2600)
    check('3f. tải lại trang khi đã Auth: KHÔNG thông báo, trạng thái vẫn Đã Auth', page.locator('#puterAuthNotice').count() == 0 and page.evaluate("()=>window.puterAdapter.auth.getState().status") == 'authenticated')
    ctx.close()

    # ===================== 4. SVG tất định: hiện được KHI CHƯA Auth =====================
    print('\n== E2E-4. SVG tất định không cần Auth ==')
    def ask(page, q):
        page.fill('#qInput', q); page.click('#sendBtn')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 1280, 'height': 900}); errors = []; page = new_page(ctx, errors)
    page.add_init_script("localStorage.setItem('tro-giai:puter-notice-dismissed-until','9999-12-31')")
    page.goto(BASE); page.wait_for_load_state('networkidle')
    ask(page, 'Vẽ cấu hình electron của Na')
    page.wait_for_selector('.visual-card-svg .visual-svg-img', timeout=10000)
    src = page.locator('.visual-svg-img').first.get_attribute('src')
    ok_img = page.evaluate("()=>{const i=document.querySelector('.visual-svg-img'); return i.complete && i.naturalWidth>0}")
    check('4a. thẻ SVG hiển thị qua <img src=data:image/svg+xml> và ĐÃ TẢI (naturalWidth>0)', src.startswith('data:image/svg+xml') and ok_img, src[:40])
    check('4b. KHÔNG có <svg> nhúng trực tiếp vào DOM câu trả lời (chỉ <img>)', page.evaluate("()=>document.querySelectorAll('.visual-card-svg svg').length") == 0)
    s = stats(page)
    check('4c. chưa Auth mà vẫn có hình: signIn=0, puter.ai gọi=0', s['signIn'] == 0 and s['txt2img'] == 0 and s['unauthCall'] == 0 and s['opens'] == 0, str(s))
    check('4d. request /api/chat mang clientCaps.puterAuth = unauthenticated (route thật đọc được)', (srv_stats()['last'] or {}).get('clientCaps', {}).get('puterAuth') == 'unauthenticated', str(srv_stats()['last']))
    check('4d2. server KHÔNG gọi image API khi dựng SVG', srv_stats()['image'] == 0, str(srv_stats()))
    check('4e. thẻ có ghi chú "dựng chính xác" + nút Mở ảnh / Tải SVG', 'dựng chính xác' in page.locator('.visual-svg-note').inner_text() and page.locator('.visual-card-svg .visual-btn').count() == 2)
    page.locator('.visual-card-svg').first.scroll_into_view_if_needed(); page.locator('.visual-card-svg').first.screenshot(path=f'{SHOTS}/e2e_svg_atom.png')
    page.locator('.visual-svg-img').first.click(); page.wait_for_selector('.visual-lightbox .visual-svg-lightbox-img', timeout=3000)
    check('4f. lightbox SVG mở được, Esc đóng', True); page.keyboard.press('Escape'); check('4g. Esc đóng lightbox', page.locator('.visual-lightbox').count() == 0)
    with page.expect_download() as dl: page.locator('.visual-card-svg .visual-btn', has_text='Tải SVG').click()
    fn = dl.value.suggested_filename; content = open(dl.value.path()).read()
    check('4h. tải về file .svg hợp lệ', fn.endswith('.svg') and content.lstrip().startswith('<svg') and '<script' not in content, fn)
    csp = [e for e in errors if 'Content Security Policy' in e or 'PAGEERROR' in e]
    check('4i. không vi phạm CSP khi hiển thị SVG', not csp, str(csp[:2]))
    # SVG sống sót qua reload (lưu trong lịch sử hội thoại, KHÔNG cần tính lại)
    n_before = srv_stats()['count']
    page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(800)
    hist = page.locator('.visual-card-svg .visual-svg-img').count()
    if hist == 0:
        # có thể cần mở lại hội thoại từ tab Lịch sử
        try:
            page.locator('.side-tab', has_text='Lịch sử').first.click(); page.wait_for_timeout(300)
            page.locator('.history-item, .conv-item, [data-conv-id]').first.click(); page.wait_for_timeout(800)
        except Exception as e:
            pass
        hist = page.locator('.visual-card-svg .visual-svg-img').count()
    check('4j. sau reload, thẻ SVG vẫn hiển thị từ lịch sử (không gọi lại server)', hist >= 1 and srv_stats()['count'] == n_before, f'cards={hist} calls={srv_stats()["count"]-n_before}')
    ctx.close()

    # ===================== 4b. Luồng giải thích (không phải image-only) + stage detail =====================
    print('\n== E2E-4b. Luồng có lời giải + hình + "Xem cách giải chi tiết" ==')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 1280, 'height': 900}); errors = []; page = new_page(ctx, errors)
    page.add_init_script("localStorage.setItem('tro-giai:puter-notice-dismissed-until','9999-12-31')")
    page.goto(BASE); page.wait_for_load_state('networkidle')
    ask(page, 'Cho tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm. Tính BC và vẽ hình minh hoạ.')
    page.wait_for_selector('.visual-card-svg .visual-svg-img', timeout=12000)
    check('4b-a. luồng giải thích: SVG tam giác hiển thị cùng lời giải', page.locator('.visual-card-svg').count() == 1)
    st = srv_stats(); check('4b-b. text model được gọi (lời giải) nhưng KHÔNG image API', st['messages'] >= 1 and st['image'] == 0, str(st))
    page.locator('.detail-btn').first.click()
    page.wait_for_function("()=>document.querySelectorAll('.msg-ai, .ai-row, [data-role=ai]').length>=0 && !document.querySelector('.detail-btn[disabled]')", timeout=15000)
    page.wait_for_timeout(2500)
    st2 = srv_stats()
    srcs = page.evaluate("()=>[...document.querySelectorAll('.visual-card-svg .visual-svg-img')].map(i=>i.src)")
    check('4b-c. sau "Xem cách giải chi tiết": khối Hướng giải và khối Chi tiết cùng hiển thị ĐÚNG MỘT hình SVG đó (thiết kế gốc: mỗi khối vẽ hình của nó), 0 lệnh gọi ảnh', len(srcs) == 2 and srcs[0] == srcs[1] and st2['image'] == 0, f'srcs={len(srcs)} same={len(srcs)==2 and srcs[0]==srcs[1]} image={st2["image"]}')
    csp = [e for e in errors if 'Content Security Policy' in e or 'PAGEERROR' in e]; check('4b-d. không vi phạm CSP / lỗi JS', not csp, str(csp[:2]))
    ctx.close()

    # ===================== 5. Ảnh AI khi chưa Auth: thẻ "Mở Settings", không popup =====================
    print('\n== E2E-5. Ảnh AI + chưa Auth ==')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 1280, 'height': 900}); errors = []; page = new_page(ctx, errors)
    page.add_init_script("localStorage.setItem('tro-giai:puter-notice-dismissed-until','9999-12-31')")
    page.goto(BASE); page.wait_for_load_state('networkidle')
    ask(page, 'Vẽ hình tế bào thực vật')
    page.wait_for_selector('.visual-card-auth', timeout=10000)
    txt = page.locator('.visual-card-auth .visual-error-text').inner_text()
    check('5a. thẻ hiện đúng thông điệp Auth', txt == 'Để dùng tạo hình ảnh AI, hãy Auth Puter.js trong Settings.', txt)
    check('5b. có nút "Mở Settings", KHÔNG có nút Thử tạo lại', page.locator('.visual-card-auth .visual-btn', has_text='Mở Settings').count() == 1 and page.locator('.visual-card-auth .visual-btn-retry').count() == 0)
    s = stats(page); check('5c. KHÔNG tự popup: signIn=0, window.open=0, puter.ai=0', s['signIn'] == 0 and s['opens'] == 0 and s['txt2img'] == 0 and s['unauthCall'] == 0, str(s))
    page.locator('.visual-card-auth').first.screenshot(path=f'{SHOTS}/e2e_ai_auth_required.png')
    page.locator('.visual-card-auth .visual-btn', has_text='Mở Settings').click(); page.wait_for_selector('#settingsOverlay.show', timeout=3000)
    check('5d. "Mở Settings" trên thẻ chỉ mở Settings (signIn vẫn 0)', stats(page)['signIn'] == 0)
    page.locator('#puterAuthBtn').click(); page.wait_for_function("()=>window.puterAdapter.auth.getState().status==='authenticated'", timeout=4000)
    page.evaluate("()=>document.getElementById('settingsCloseBtn').click()")
    page.wait_for_selector('.visual-card-image .visual-img, .visual-img-wrap img', timeout=10000)
    s = stats(page)
    check('5e. sau khi Auth: hình do người dùng yêu cầu TỰ chạy tiếp (txt2img=1, khi đã đăng nhập, unauthCall=0)', s['txt2img'] == 1 and s['unauthCall'] == 0 and s['signIn'] == 1, str(s))
    check('5f. thẻ Auth được thay bằng ảnh, không nhân đôi thẻ', page.locator('.visual-card-auth').count() == 0 and page.locator('[data-visual-card]').count() == 1, str(page.locator('[data-visual-card]').count()))
    page.locator('[data-visual-card]').first.screenshot(path=f'{SHOTS}/e2e_ai_after_auth.png')
    csp = [e for e in errors if 'Content Security Policy' in e or 'PAGEERROR' in e]; check('5g. không vi phạm CSP / lỗi JS', not csp, str(csp[:2]))
    # 5h. hình AI TUỲ CHỌN bị bỏ vì chưa Auth -> MỘT dòng nhắc nhẹ (không phải lỗi), chỉ 1 lần/trang
    page.evaluate("()=>localStorage.removeItem('fake_puter_signed')"); page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(500)
    r = page.evaluate("""()=>{ const mk=(id)=>({format:'notice',noticeKind:'puter_auth_skipped',visualId:id});
      const a=renderVisualCard(mk('n1')); const b=renderVisualCard(mk('n2')); const again=renderVisualCard(mk('n1'));
      return {a:!!a, text:a&&a.textContent, second:b===null, again:!!again, buttons:a&&a.querySelectorAll('button').length}; }""")
    check('5h. dòng nhắc nhẹ hiện đúng chữ + nút Mở Settings; hình thứ hai trong cùng trang bị lược bỏ (không làm phiền); vẽ lại cùng thẻ vẫn được',
          r['a'] and 'Hình ảnh AI chưa được tạo vì Puter.js chưa được Auth. Bạn có thể Auth trong Settings để sử dụng.' in r['text'] and r['buttons'] == 1 and r['second'] and r['again'], str(r))
    ctx.close()

    # ===================== 6. Dữ kiện mâu thuẫn =====================
    print('\n== E2E-6. Dữ kiện mâu thuẫn ==')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 1280, 'height': 900}); errors = []; page = new_page(ctx, errors)
    page.add_init_script("localStorage.setItem('tro-giai:puter-notice-dismissed-until','9999-12-31')")
    page.goto(BASE); page.wait_for_load_state('networkidle')
    ask(page, 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6')
    page.wait_for_selector('.visual-card-notice', timeout=10000)
    t = page.locator('.visual-notice-text').inner_text()
    check('6a. hiện thẻ thông báo mâu thuẫn (không vẽ hình sai), có lý do Pythagore', 'mâu thuẫn' in t and 'Pythagore' in t, t)
    check('6b. không có nút thử lại, không có ảnh, không có <img> SVG', page.locator('.visual-card-notice .visual-btn').count() == 0 and page.locator('.visual-svg-img').count() == 0)
    check('6c. không gọi Puter', stats(page)['txt2img'] == 0 and stats(page)['signIn'] == 0)
    page.locator('.visual-card-notice').first.screenshot(path=f'{SHOTS}/e2e_contradiction.png'); ctx.close()

    # ===================== 7. Mobile =====================
    print('\n== E2E-7. Mobile ==')
    ctx = browser.new_context(locale='vi-VN', viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True); errors = []; page = new_page(ctx, errors)
    page.goto(BASE); page.wait_for_selector('#puterAuthNotice', timeout=6000)
    box = page.locator('#puterAuthNotice').bounding_box()
    check('7a. thông báo nằm gọn trong màn hình 390px (không tràn ngang)', box and box['x'] >= 0 and box['x'] + box['width'] <= 390 and box['y'] + box['height'] <= 780, str(box))
    page.screenshot(path=f'{SHOTS}/e2e_notice_mobile.png')
    ctx.close()

    # ===================== 8. Ngôn ngữ giao diện tiếng Anh =====================
    print('\n== E2E-8. Giao diện tiếng Anh ==')
    ctx = browser.new_context(locale='en-US', viewport={'width': 1280, 'height': 800}); errors = []; page = new_page(ctx, errors)
    page.goto(BASE); page.wait_for_selector('#puterAuthNotice', timeout=6000)
    check('8a. locale en-US: thông báo hiện bằng tiếng Anh (i18n hoạt động)', 'AI image generation is not available yet' in page.locator('#puterNoticeBody').inner_text())
    ctx.close(); browser.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
