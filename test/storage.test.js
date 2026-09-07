'use strict';
// Test cho public/js/storage.js (mục 13/35): migration localStorage -> IndexedDB,
// fallback an toàn khi IndexedDB không khả dụng, không mất dữ liệu khi lỗi.

const path = require('path');
const { createDocStore } = require(path.join(__dirname, '..', 'public', 'js', 'storage.js'));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

/* ---- fake localStorage ---- */
function makeFakeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => Object.assign({}, data)
  };
}

/* ---- fake IndexedDB (in-memory, đủ để test createDocStore) ---- */
function makeFakeIndexedDB(opts) {
  opts = opts || {};
  const stores = {}; // storeName -> Map(id -> value)
  function makeRequest(executor) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: undefined };
    setTimeout(() => {
      try {
        const result = executor();
        req.result = result;
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (e) {
        req.error = e;
        if (req.onerror) req.onerror({ target: req });
      }
    }, 0);
    return req;
  }
  const fakeDb = {
    objectStoreNames: { contains: (n) => !!stores[n] },
    createObjectStore: (name) => { stores[name] = new Map(); return { name }; },
    transaction: (name, mode) => {
      if (opts.failTransaction) {
        const txObj = {
          objectStore: () => ({
            clear: () => {}, put: () => {},
            getAll: () => makeRequest(() => { throw new Error('forced_fail'); }),
            openCursor: () => makeRequest(() => { throw new Error('forced_fail'); })
          }),
          oncomplete: null, onerror: null, onabort: null
        };
        setTimeout(() => { txObj.error = new Error('forced_tx_fail'); if (txObj.onerror) txObj.onerror(); }, 0);
        return txObj;
      }
      const store = stores[name] || (stores[name] = new Map());
      return {
        objectStore: () => ({
          clear: () => store.clear(),
          put: (v) => store.set(v.id, v),
          getAll: () => makeRequest(() => Array.from(store.values())),
          openCursor: () => makeRequest(() => { throw new Error('no_cursor_in_fake'); })
        }),
        get oncomplete() { return this._oc; }, set oncomplete(f) { this._oc = f; setTimeout(() => f && f(), 0); },
        onerror: null,
        onabort: null
      };
    }
  };
  return {
    open: (name, version) => makeRequest(() => fakeDb)
    // NB: onupgradeneeded không được gọi trong fake này vì store được tạo lười (lazy) ở transaction();
    // đủ để test hành vi get/save/migrate cấp module.
  };
}

async function run() {
  console.log('\n== IndexedDB path: save + getAll roundtrip (mục 13) ==');
  {
    const ls = makeFakeLocalStorage();
    const store = createDocStore({ indexedDB: makeFakeIndexedDB(), localStorage: ls, dbName: 't1' });
    const docs = [{ id: 1, name: 'a.pdf', chunks: [{ id: 1, text: 'hello' }] }];
    const saveOk = await store.saveAll(docs);
    ok(saveOk === true, 'saveAll() trả true khi IndexedDB hoạt động');
    const got = await store.getAll();
    ok(Array.isArray(got) && got.length === 1 && got[0].name === 'a.pdf', 'getAll() đọc lại đúng dữ liệu vừa lưu qua IndexedDB');
  }

  console.log('\n== Fallback localStorage khi không có IndexedDB (mục 13) ==');
  {
    const ls = makeFakeLocalStorage();
    const store = createDocStore({ indexedDB: undefined, localStorage: ls });
    ok(store._isIndexedDbUsable() === false, 'không có indexedDB -> đánh dấu không khả dụng ngay từ đầu');
    const docs = [{ id: 5, name: 'b.docx', chunks: [] }];
    const saveOk = await store.saveAll(docs);
    ok(saveOk === true, 'saveAll() vẫn thành công qua fallback localStorage');
    const got = await store.getAll();
    ok(got.length === 1 && got[0].id === 5, 'getAll() đọc đúng dữ liệu từ fallback localStorage');
  }

  console.log('\n== Fallback khi IndexedDB lỗi giữa chừng (mục 13/35 — không throw, không mất dữ liệu) ==');
  {
    const ls = makeFakeLocalStorage();
    const store = createDocStore({ indexedDB: makeFakeIndexedDB({ failTransaction: true }), localStorage: ls });
    const docs = [{ id: 9, name: 'c.txt', chunks: [] }];
    let threw = false;
    let saveOk;
    try { saveOk = await store.saveAll(docs); } catch (e) { threw = true; }
    ok(!threw, 'IndexedDB transaction lỗi -> saveAll() không throw ra ngoài, tự rơi về fallback');
    ok(saveOk === true, 'sau khi IndexedDB lỗi, dữ liệu vẫn được lưu thành công qua fallback localStorage');
  }

  console.log('\n== Migration từ localStorage cũ sang store mới (mục 13/35) ==');
  {
    const legacyDocs = [{ id: 3, name: 'old.pdf', chunks: [{ id: 1, text: 'legacy content' }] }];
    const ls = makeFakeLocalStorage({ 'tro-giai:docs': JSON.stringify(legacyDocs) });
    const store = createDocStore({ indexedDB: makeFakeIndexedDB(), localStorage: ls, dbName: 't2' });
    const migrated = await store.migrateFromLegacyIfNeeded();
    ok(Array.isArray(migrated) && migrated.length === 1 && migrated[0].name === 'old.pdf', 'migrateFromLegacyIfNeeded() trả đúng dữ liệu cũ');
    ok(ls._dump()['tro-giai:docs'] === undefined, 'khóa localStorage cũ bị xóa sau khi migrate thành công (không còn lưu data lớn ở localStorage)');
    ok(ls._dump()['tro-giai:docs:migrated-v1'] === '1', 'đã đánh dấu migrated để không chạy lại lần sau');

    const gotAfter = await store.getAll();
    ok(gotAfter.length === 1 && gotAfter[0].id === 3, 'dữ liệu cũ thực sự nằm trong store mới sau migrate (đọc lại qua getAll)');

    // Gọi lại lần 2: không còn key cũ, phải không throw và trả về đúng dữ liệu đã migrate (từ store).
    const migrated2 = await store.migrateFromLegacyIfNeeded();
    ok(migrated2.length === 1 && migrated2[0].id === 3, 'gọi migrate lần 2 an toàn (idempotent), vẫn thấy đúng dữ liệu');
  }

  console.log('\n== Migration khi không có dữ liệu cũ (mục 35) ==');
  {
    const ls = makeFakeLocalStorage();
    const store = createDocStore({ indexedDB: makeFakeIndexedDB(), localStorage: ls, dbName: 't3' });
    const migrated = await store.migrateFromLegacyIfNeeded();
    ok(Array.isArray(migrated) && migrated.length === 0, 'không có dữ liệu cũ -> trả mảng rỗng, không lỗi');
    ok(ls._dump()['tro-giai:docs:migrated-v1'] === '1', 'vẫn đánh dấu đã kiểm tra migrate dù không có gì để chuyển');
  }

  console.log('\n== Corrupt legacy data không làm crash (mục 35) ==');
  {
    const ls = makeFakeLocalStorage({ 'tro-giai:docs': '{not valid json' });
    const store = createDocStore({ indexedDB: makeFakeIndexedDB(), localStorage: ls, dbName: 't4' });
    let threw = false;
    let migrated;
    try { migrated = await store.migrateFromLegacyIfNeeded(); } catch (e) { threw = true; }
    ok(!threw, 'legacy data hỏng JSON -> migrateFromLegacyIfNeeded() không throw');
    ok(Array.isArray(migrated) && migrated.length === 0, 'legacy data hỏng -> coi như không có gì để migrate, trả mảng rỗng');
  }

  console.log('\n== FIX P0 mục 4: concurrent saveAll() không bị ghi đè out-of-order ==');
  {
    // Transaction "chậm" cho lần ghi đầu, "nhanh" cho lần ghi sau -> nếu không có write
    // queue/versioning, lần ghi ĐẦU (state cũ) có thể commit SAU và ghi đè lần ghi SAU (state mới).
    const ls = makeFakeLocalStorage();
    let callIndex = 0;
    const stores = {};
    const fakeDb = {
      objectStoreNames: { contains: (n) => !!stores[n] },
      createObjectStore: (name) => { stores[name] = new Map(); return { name }; },
      transaction: (name) => {
        const store = stores[name] || (stores[name] = new Map());
        callIndex += 1;
        const myCall = callIndex;
        const delayMs = myCall === 1 ? 20 : 0; // lần ghi đầu tiên cố tình chậm hơn
        const txObj = { onerror: null, onabort: null };
        const ops = [];
        return {
          objectStore: () => ({
            clear: () => ops.push(() => store.clear()),
            put: (v) => ops.push(() => store.set(v.id, v)),
            getAll: () => {
              const req = { onsuccess: null, onerror: null };
              setTimeout(() => { req.result = Array.from(store.values()); req.onsuccess && req.onsuccess({ target: req }); }, 0);
              return req;
            }
          }),
          set oncomplete(f) {
            setTimeout(() => { ops.forEach((fn) => fn()); f && f(); }, delayMs);
          }
        };
      }
    };
    const store = createDocStore({ indexedDB: { open: () => { const r = { onsuccess: null }; setTimeout(() => r.onsuccess && r.onsuccess({ target: { result: fakeDb } }), 0); return r; } }, localStorage: ls, dbName: 't5' });

    const p1 = store.saveAll([{ id: 1, name: 'OLD-should-be-overwritten.pdf', chunks: [] }]);
    const p2 = store.saveAll([{ id: 2, name: 'NEW-must-win.pdf', chunks: [] }]);
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 30)); // chờ transaction "chậm" (nếu có chạy) hoàn tất

    const got = await store.getAll();
    ok(got.length === 1 && got[0].name === 'NEW-must-win.pdf', 'state MỚI NHẤT thắng, state cũ hơn bị bỏ qua dù transaction của nó có commit trễ hơn (mục 4)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
