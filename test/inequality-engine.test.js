'use strict';
// Test tích hợp engine: bất phương trình đi qua tryRender() + HỒI QUY hình học/vật lí không bị nuốt.
// Chạy: node test/inequality-engine.test.js

const path = require('path');
const D = require(path.join(__dirname, '..', 'server', 'utils', 'visual', 'deterministic'));

let pass = 0; let fail = 0;
const ok = (c, n, e) => { if (c) { pass += 1; console.log('  PASS', n); } else { fail += 1; console.log('  FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 260)); } };

console.log('# Bất phương trình qua tryRender');
const REGION = 'Biểu diễn miền nghiệm của hệ bất phương trình: x + 2y ≤ 4; x ≥ 0; y ≥ 0';
let r = D.tryRender(REGION, 'math');
ok(r.status === 'rendered' && r.category === 'inequality_region' && r.svg.startsWith('<svg'), 'miền nghiệm -> rendered', [r.status, r.category]);
r = D.tryRender(REGION, 'math'); ok(r.cacheHit === true, 'lần 2 cache hit');
r = D.tryRender('Giải bất phương trình 2x - 3 > 5 và biểu diễn tập nghiệm trên trục số', 'math');
ok(r.status === 'rendered' && r.category === 'inequality_number_line', 'trục số -> rendered', [r.status, r.category]);
r = D.tryRender('Biểu diễn miền nghiệm của hệ bất phương trình: x + y ≤ 1; x + y ≥ 3', 'math');
ok(r.status === 'contradiction' && /vô nghiệm/.test(r.errors[0].detail), 'vô nghiệm -> contradiction (mô tả tiếng Việt)', r.errors);
r = D.tryRender('Giải bất phương trình x² - 4 < 0 và biểu diễn trên trục số', 'math');
ok(r.status === 'not_deterministic', 'phi tuyến -> not_deterministic (không vẽ bừa)', [r.status, r.reason]);

console.log('# Hồi quy: hình học / vật lí không bị nuốt');
r = D.tryRender('Cho tam giác ABC vuông tại A có AB = 3 cm, AC = 4 cm. Tính BC và vẽ hình.', 'math');
ok(r.status === 'rendered' && /^geometry_/.test(r.category), 'tam giác vuông vẫn là geometry', [r.status, r.category]);
r = D.tryRender('Tam giác ABC có AB < 5 và AC > 3, vẽ hình tam giác', 'math');
ok(!(r.category || '').startsWith('inequality'), 'AB<5, AC>3 không bị coi là bất phương trình', [r.status, r.category]);
r = D.tryRender('Vẽ đường tròn tâm O bán kính R = 3 cm', 'math');
ok(r.status === 'rendered' && /^geometry_/.test(r.category), 'đường tròn vẫn ok', [r.status, r.category]);
r = D.tryRender('Một vật khối lượng 2 kg trượt trên mặt phẳng nghiêng góc 30 độ, vẽ các lực tác dụng', 'physics');
ok(r.status !== 'contradiction', 'vật lí không bị ảnh hưởng', [r.status, r.category]);

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
