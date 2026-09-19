'use strict';
// Test cho public/js/imageStorage.js — persistent chat image store (IndexedDB), fix ROOT CAUSE #1
// (F5 làm mất ảnh đề bài). Xem PHẦN C của yêu cầu fix: TEST IMAGE 1..10.

const path = require('path');

// Node không có FileReader built-in (chỉ là API trình duyệt) — imageStorage.js dùng nó trong
// blobToBase64() để chuyển Blob khôi phục từ IndexedDB thành base64 gửi lên /api/chat. Polyfill tối
// thiểu đủ dùng cho test, dựa trên Blob.arrayBuffer() (Node 18+ có sẵn Blob toàn cục).
global.FileReader = function () {
  this.onload = null;
  this.onerror = null;
  this.result = null;
};
global.FileReader.prototype.readAsDataURL = function (blob) {
  const self = this;
  Promise.resolve()
    .then(() => blob.arrayBuffer())
    .then((buf) => {
      const b64 = Buffer.from(buf).toString('base64');
      self.result = `data:${blob.type || 'image/png'};base64,${b64}`;
      if (self.onload) self.onload();
    })
    .catch((e) => { if (self.onerror) { self.error = e; self.onerror(); } });
};

const { createChatImageStore, blobToBase64 } = require(path.join(__dirname, '..', 'public', 'js', 'imageStorage.js'));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

/* ---- fake IndexedDB tối thiểu, đủ cho get/put/delete theo keyPath 'id' ---- */
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
    transaction: (name) => {
      if (opts.failTransaction) {
        const txObj = { oncomplete: null, onerror: null, onabort: null };
        setTimeout(() => { txObj.error = new Error('forced_tx_fail'); if (txObj.onerror) txObj.onerror(); }, 0);
        return {
          objectStore: () => ({
            put: () => {}, delete: () => {},
            get: () => makeRequest(() => { throw new Error('forced_fail'); })
          }),
          set oncomplete(f) { txObj.oncomplete = f; },
          set onerror(f) { txObj.onerror = f; },
          onabort: null
        };
      }
      const store = stores[name] || (stores[name] = new Map());
      const txObj = {};
      return {
        objectStore: () => ({
          put: (v) => store.set(v.id, v),
          delete: (id) => store.delete(id),
          get: (id) => makeRequest(() => store.get(id))
        }),
        get oncomplete() { return txObj._oc; },
        set oncomplete(f) { txObj._oc = f; setTimeout(() => f && f(), 0); },
        onerror: null,
        onabort: null
      };
    }
  };
  return { open: () => makeRequest(() => fakeDb) };
}

async function run() {
  console.log('\n== TEST IMAGE: save() rồi get() trả đúng blob (roundtrip qua IndexedDB) ==');
  {
    const store = createChatImageStore({ indexedDB: makeFakeIndexedDB(), dbName: 'i1' });
    const blob = new Blob(['fake-image-bytes'], { type: 'image/png' });
    const imageId = await store.save(blob, { mediaType: 'image/png' });
    ok(typeof imageId === 'string' && imageId.length > 0, 'save() trả về 1 imageId dạng chuỗi');
    const record = await store.get(imageId);
    ok(!!record, 'get() tìm lại được record vừa lưu');
    ok(record.mediaType === 'image/png', 'mediaType được giữ nguyên');
    ok(!!record.blob, 'record khôi phục có kèm Blob gốc');
  }

  console.log('\n== TEST IMAGE 4: image không tồn tại trong IndexedDB -> không crash, trả null ==');
  {
    const store = createChatImageStore({ indexedDB: makeFakeIndexedDB(), dbName: 'i2' });
    let threw = false;
    let result;
    try { result = await store.get('img_khong_ton_tai'); } catch (e) { threw = true; }
    ok(!threw, 'get() với imageId không tồn tại không throw');
    ok(result === null, 'get() trả null khi không tìm thấy record');
  }

  console.log('\n== TEST IMAGE 5: xoá conversation -> delete() dọn được record, get() sau đó trả null ==');
  {
    const store = createChatImageStore({ indexedDB: makeFakeIndexedDB(), dbName: 'i3' });
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    const imageId = await store.save(blob, { mediaType: 'image/jpeg' });
    ok(await store.has(imageId), 'has() true trước khi xoá');
    const delOk = await store.delete(imageId);
    ok(delOk === true, 'delete() báo thành công');
    const after = await store.get(imageId);
    ok(after === null, 'sau delete(), get() trả null (record đã bị xoá thật)');
    ok(await store.has(imageId) === false, 'has() false sau khi xoá');
  }

  console.log('\n== TEST IMAGE 6/7/8: Ctrl+V / drag&drop / file input đều dùng chung save() -> cùng 1 pipeline ==');
  {
    const store = createChatImageStore({ indexedDB: makeFakeIndexedDB(), dbName: 'i4' });
    const blobPaste = new Blob(['paste'], { type: 'image/png' });
    const blobDrop = new Blob(['drop'], { type: 'image/png' });
    const blobInput = new Blob(['input'], { type: 'image/png' });
    const idPaste = await store.save(blobPaste, { mediaType: 'image/png' });
    const idDrop = await store.save(blobDrop, { mediaType: 'image/png' });
    const idInput = await store.save(blobInput, { mediaType: 'image/png' });
    const ids = new Set([idPaste, idDrop, idInput]);
    ok(ids.size === 3, 'mỗi nguồn ảnh (paste/drop/input) tạo 1 imageId riêng biệt qua cùng save()');
    ok((await store.get(idPaste)) && (await store.get(idDrop)) && (await store.get(idInput)), 'cả 3 record đều khôi phục lại được');
  }

  console.log('\n== TEST IMAGE 10: không throw khi IndexedDB không khả dụng (thay vì âm thầm giả vờ đã lưu) ==');
  {
    const store = createChatImageStore({ indexedDB: undefined, dbName: 'i5' });
    ok(store._isIndexedDbUsable() === false, 'không có indexedDB -> đánh dấu ngay không khả dụng');
    let threw = false;
    try { await store.save(new Blob(['x']), {}); } catch (e) { threw = true; }
    ok(threw === true, 'save() REJECT rõ ràng khi không có IndexedDB — không được âm thầm coi như đã lưu (mục 4 yêu cầu)');
  }

  console.log('\n== blobToBase64(): chuyển Blob khôi phục thành base64 để gửi lên /api/chat ==');
  {
    const blob = new Blob(['hello-world'], { type: 'image/png' });
    const b64 = await blobToBase64(blob);
    ok(typeof b64 === 'string' && b64.length > 0, 'blobToBase64() trả về chuỗi base64 hợp lệ');
    ok(Buffer.from(b64, 'base64').toString('utf8') === 'hello-world', 'nội dung base64 giải mã đúng dữ liệu Blob gốc (dùng để phục hồi request detail sau F5)');
  }

  console.log('\n== TEST IMAGE: IndexedDB lỗi giữa chừng -> get()/delete() không throw ra ngoài ==');
  {
    const store = createChatImageStore({ indexedDB: makeFakeIndexedDB({ failTransaction: true }), dbName: 'i6' });
    let threw = false;
    let result;
    try { result = await store.get('bat_ky_id_nao'); } catch (e) { threw = true; }
    ok(!threw, 'IndexedDB transaction lỗi -> get() không throw (app không được crash)');
    ok(result === null, 'transaction lỗi -> get() coi như không tìm thấy, trả null an toàn');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
