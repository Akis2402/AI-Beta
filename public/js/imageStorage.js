'use strict';
/* ================= public/js/imageStorage.js =================
 * ROOT CAUSE (mất ảnh sau F5): trước đây ảnh đề bài chỉ tồn tại trong RAM
 * (state.pendingImage.base64) và KHÔNG được lưu vào conversation persist — sau khi
 * conversation được ghi xuống localStorage (saveConversations), message user chỉ có
 * `hadImage: true`, không có dữ liệu ảnh nào để khôi phục. F5 → reload JS → RAM mất
 * sạch → ảnh biến mất vĩnh viễn, kể cả khi bấm "Xem cách giải chi tiết" (request sau
 * đó gửi image: null lên server).
 *
 * FIX: một "chat image store" bất đồng bộ dùng IndexedDB (cùng DB 'tro-giai-db' với
 * storage.js, thêm object store riêng 'chatImages') để lưu Blob ảnh lâu dài, độc lập
 * với localStorage — localStorage/conversation chỉ lưu 1 tham chiếu nhỏ `imageId`.
 *
 * KHÔNG lưu base64 ảnh trực tiếp vào localStorage (quota nhỏ, dễ đầy).
 * KHÔNG lưu Object URL vào localStorage (chỉ có giá trị trong phiên hiện tại).
 *
 * API (đều async, không bao giờ throw ra ngoài — reject Promise thay vào đó):
 *   chatImageStore.save(file|blob, {mediaType}) -> Promise<string> (imageId)
 *   chatImageStore.get(imageId)    -> Promise<{id,mediaType,blob,url}|null>
 *   chatImageStore.delete(imageId) -> Promise<boolean>
 *   chatImageStore.has(imageId)    -> Promise<boolean>
 *
 * Không có IndexedDB khả dụng (private mode/trình duyệt cũ) → mọi thao tác reject với
 * lỗi 'indexedDB_unavailable' rõ ràng, để nơi gọi (app.js) báo lỗi cho user thay vì
 * âm thầm coi như đã lưu thành công (mục 4 của yêu cầu: không được lưu message
 * hadImage=true mà không có ảnh thực sự lưu được).
 */

function createChatImageStore(opts) {
  opts = opts || {};
  var idbFactory = opts.indexedDB;
  var dbName = opts.dbName || 'tro-giai-db';
  var storeName = opts.storeName || 'chatImages';
  var dbVersion = opts.dbVersion || 2; // tăng version so với docStore (v1) để trigger onupgradeneeded tạo thêm store mới
  var indexedDbUsable = !!(idbFactory && typeof idbFactory.open === 'function');

  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!indexedDbUsable) { reject(new Error('indexedDB_unavailable')); return; }
      var req;
      try {
        req = idbFactory.open(dbName, dbVersion);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'id' });
      };
      req.onsuccess = function (ev) { resolve(ev.target.result); };
      req.onerror = function () {
        indexedDbUsable = false;
        reject(req.error || new Error('indexedDB_open_failed'));
      };
      req.onblocked = function () { reject(new Error('indexedDB_blocked')); };
    });
    return dbPromise;
  }

  function uid() {
    return 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(storeName, mode);
          var store = tx.objectStore(storeName);
          var out;
          fn(store, function (v) { out = v; });
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = function () { reject(tx.error || new Error('tx_failed')); };
          tx.onabort = function () { reject(tx.error || new Error('tx_aborted')); };
        } catch (e) { reject(e); }
      });
    });
  }

  /* Lưu 1 File/Blob ảnh. Trả về imageId. KHÔNG âm thầm nuốt lỗi — reject rõ ràng để
   * caller (loadImageFile trong app.js) hiển thị lỗi và cho user retry (mục 4). */
  function save(fileOrBlob, meta) {
    meta = meta || {};
    if (!fileOrBlob) return Promise.reject(new Error('no_file'));
    var id = meta.id || uid();
    var record = {
      id: id,
      conversationId: meta.conversationId || null,
      messageId: meta.messageId || null,
      mediaType: meta.mediaType || fileOrBlob.type || 'image/png',
      blob: fileOrBlob,
      size: fileOrBlob.size || 0,
      createdAt: Date.now()
    };
    return withStore('readwrite', function (store) { store.put(record); }).then(function () { return id; });
  }

  function get(id) {
    if (!id) return Promise.resolve(null);
    return withStore('readonly', function (store, setOut) {
      var req = store.get(id);
      req.onsuccess = function () { setOut(req.result || null); };
      req.onerror = function () { setOut(null); };
    }).then(function (record) {
      if (!record) return null;
      var url = null;
      try {
        if (typeof URL !== 'undefined' && URL.createObjectURL && record.blob) {
          url = URL.createObjectURL(record.blob); // Object URL mới cho phiên hiện tại — KHÔNG lưu url này xuống bất kỳ storage nào (mục 6)
        }
      } catch (e) { url = null; }
      return { id: record.id, mediaType: record.mediaType, blob: record.blob, url: url };
    }).catch(function () { return null; });
  }

  function del(id) {
    if (!id) return Promise.resolve(true);
    return withStore('readwrite', function (store) { store.delete(id); })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function has(id) {
    if (!id) return Promise.resolve(false);
    return get(id).then(function (r) { return !!r; });
  }

  return {
    save: save,
    get: get,
    delete: del,
    has: has,
    _isIndexedDbUsable: function () { return indexedDbUsable; }
  };
}

/* Đọc 1 Blob thành chuỗi base64 (không kèm phần "data:...;base64," ở đầu) — dùng khi cần
 * gửi ảnh đã khôi phục từ IndexedDB lên /api/chat (nơi cần {mediaType, base64}). */
function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    if (!blob) { resolve(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var m = String(reader.result).match(/^data:(.*?);base64,(.*)$/);
      resolve(m ? m[2] : null);
    };
    reader.onerror = function () { reject(reader.error || new Error('blob_read_failed')); };
    reader.readAsDataURL(blob);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createChatImageStore: createChatImageStore, blobToBase64: blobToBase64 };
}
if (typeof window !== 'undefined') {
  window.createChatImageStore = createChatImageStore;
  window.blobToBase64 = blobToBase64;
  window.chatImageStore = createChatImageStore({
    indexedDB: window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB
  });
}
