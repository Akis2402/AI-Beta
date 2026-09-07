'use strict';
/* ================= public/js/storage.js =================
 * Mục 13 (master prompt): document/source lớn (PDF/DOCX/TXT đã parse) không được
 * lưu trực tiếp trong localStorage (giới hạn ~5MB, đồng bộ, chặn main thread).
 * Module này cung cấp một "doc store" bất đồng bộ dùng IndexedDB, có:
 *   - migration 1 lần từ khóa localStorage cũ (LS_KEYS.docs) sang IndexedDB;
 *   - fallback an toàn về localStorage nếu IndexedDB không khả dụng (private mode,
 *     trình duyệt cũ, bị chặn bởi policy...) — không bao giờ throw ra ngoài, không
 *     bao giờ làm mất dữ liệu đang có;
 *   - schema version để có thể migrate tiếp trong tương lai.
 *
 * API (đều async, trả Promise):
 *   docStore.getAll()          -> Promise<Array<doc>>
 *   docStore.saveAll(docs)     -> Promise<boolean>  (true nếu ghi thành công)
 *   docStore.migrateFromLegacy(legacyDocs) -> Promise<void> (gọi 1 lần khi có dữ liệu cũ)
 *
 * Được viết theo dạng factory (createDocStore) nhận vào các implementation của
 * indexedDB/localStorage để có thể unit-test bằng fake trong Node (không có DOM),
 * đồng thời tự khởi tạo singleton gắn vào window khi chạy trong trình duyệt.
 */

function createDocStore(opts) {
  opts = opts || {};
  var idbFactory = opts.indexedDB; // có thể undefined -> dùng fallback
  var storage = opts.localStorage; // localStorage-like: getItem/setItem/removeItem
  var dbName = opts.dbName || 'tro-giai-db';
  var storeName = opts.storeName || 'docs';
  var dbVersion = opts.dbVersion || 1;
  var legacyKey = opts.legacyKey || 'tro-giai:docs';
  var fallbackKey = opts.fallbackKey || 'tro-giai:docs:fallback';
  var migratedFlagKey = opts.migratedFlagKey || 'tro-giai:docs:migrated-v1';

  var dbPromise = null;
  var indexedDbUsable = !!(idbFactory && typeof idbFactory.open === 'function');

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!indexedDbUsable) { reject(new Error('indexedDB_unavailable')); return; }
      var req;
      try {
        req = idbFactory.open(dbName, dbVersion);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess = function (ev) { resolve(ev.target.result); };
      req.onerror = function () {
        indexedDbUsable = false; // hỏng thì đừng thử lại mãi, chuyển hẳn sang fallback
        reject(req.error || new Error('indexedDB_open_failed'));
      };
      req.onblocked = function () { reject(new Error('indexedDB_blocked')); };
    });
    return dbPromise;
  }

  function idbGetAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(storeName, 'readonly');
          var store = tx.objectStore(storeName);
          var req = store.getAll ? store.getAll() : null;
          if (req) {
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function () { reject(req.error || new Error('getAll_failed')); };
          } else {
            // Trình duyệt cũ không hỗ trợ getAll(): duyệt bằng cursor.
            var out = [];
            var cursorReq = store.openCursor();
            cursorReq.onsuccess = function (ev) {
              var cursor = ev.target.result;
              if (cursor) { out.push(cursor.value); cursor.continue(); } else { resolve(out); }
            };
            cursorReq.onerror = function () { reject(cursorReq.error || new Error('cursor_failed')); };
          }
        } catch (e) { reject(e); }
      });
    });
  }

  function idbSaveAll(docs) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(storeName, 'readwrite');
          var store = tx.objectStore(storeName);
          store.clear();
          (docs || []).forEach(function (d) { store.put(d); });
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error || new Error('saveAll_failed')); };
          tx.onabort = function () { reject(tx.error || new Error('saveAll_aborted')); };
        } catch (e) { reject(e); }
      });
    });
  }

  /* ---- fallback localStorage (khi IndexedDB không khả dụng) ---- */
  function lsGetAll() {
    try {
      var raw = storage.getItem(fallbackKey);
      return Promise.resolve(raw ? JSON.parse(raw) : []);
    } catch (e) { return Promise.resolve([]); }
  }
  function lsSaveAll(docs) {
    try {
      storage.setItem(fallbackKey, JSON.stringify(docs || []));
      return Promise.resolve(true);
    } catch (e) {
      // Quota vượt hoặc storage bị chặn: không throw ra ngoài, báo false để caller biết.
      return Promise.resolve(false);
    }
  }

  function getAll() {
    if (!indexedDbUsable) return lsGetAll();
    return idbGetAll().catch(function () { indexedDbUsable = false; return lsGetAll(); });
  }

  function rawSaveAll(docs) {
    if (!indexedDbUsable) return lsSaveAll(docs);
    return idbSaveAll(docs).catch(function () { indexedDbUsable = false; return lsSaveAll(docs); });
  }

  /* FIX P0 (concurrent write): upload/remove liên tiếp nhanh có thể tạo nhiều lời gọi saveAll()
   * chồng lấp. Do độ trễ của transaction IndexedDB không đảm bảo, transaction ứng với state CŨ
   * hoàn toàn có thể resolve/commit SAU transaction ứng với state MỚI hơn -> ghi đè mất dữ liệu.
   * Giải pháp: 1 "write queue" tuần tự (writeChain) + số thứ tự đơn điệu (writeSeq):
   *   - Mọi lời gọi saveAll() được xếp hàng, chỉ chạy sau khi lời gọi trước đó xong (không còn 2
   *     transaction chạy song song -> không còn out-of-order commit).
   *   - Nếu tại thời điểm tới lượt chạy, đã có 1 lời gọi saveAll() MỚI HƠN được xếp hàng phía sau
   *     (writeSeq đã tăng thêm), coi bản ghi này là cũ (obsolete) và BỎ QUA — chỉ bản ghi mới nhất
   *     mới thực sự được ghi xuống ("latest snapshot wins", đúng yêu cầu P0 mục 4).
   */
  var writeSeq = 0;
  var writeChain = Promise.resolve();

  function saveAll(docs) {
    writeSeq += 1;
    var mySeq = writeSeq;
    // Chụp snapshot ngay lúc gọi (không phải lúc tới lượt chạy) để tránh việc caller mutate tiếp
    // mảng gốc (vd push thêm phần tử) làm lẫn dữ liệu giữa 2 lần ghi khác nhau.
    var snapshot = (docs || []).slice();
    writeChain = writeChain.then(function () {
      if (mySeq !== writeSeq) {
        // Đã có 1 saveAll() mới hơn được gọi sau khi lời gọi này xếp hàng -> state này đã lỗi thời,
        // ghi xuống chỉ tổ tốn công và có nguy cơ ghi đè nhầm lên state mới hơn nếu race tiếp.
        return true;
      }
      return rawSaveAll(snapshot);
    }).catch(function () { return false; });
    return writeChain;
  }

  /* Di chuyển dữ liệu cũ từ localStorage[legacyKey] sang store hiện tại (IndexedDB hoặc
   * fallback), chỉ chạy 1 lần (đánh dấu bằng migratedFlagKey). An toàn khi gọi lặp lại,
   * không làm mất dữ liệu nếu migrate thất bại giữa chừng (không set flag cho tới khi
   * saveAll xong). Trả về mảng docs cuối cùng nên dùng (đã migrate hoặc rỗng).
   */
  function migrateFromLegacyIfNeeded() {
    var alreadyMigrated = false;
    try { alreadyMigrated = storage.getItem(migratedFlagKey) === '1'; } catch (e) { /* ignore */ }
    if (alreadyMigrated) return getAll();

    var legacyDocs = [];
    try {
      var raw = storage.getItem(legacyKey);
      legacyDocs = raw ? JSON.parse(raw) : [];
    } catch (e) { legacyDocs = []; }

    if (!legacyDocs || !legacyDocs.length) {
      try { storage.setItem(migratedFlagKey, '1'); } catch (e) { /* ignore */ }
      return getAll();
    }

    return saveAll(legacyDocs).then(function (ok) {
      if (ok) {
        try {
          storage.setItem(migratedFlagKey, '1');
          storage.removeItem(legacyKey); // dọn dữ liệu lớn khỏi localStorage sau khi đã migrate an toàn
        } catch (e) { /* ignore */ }
        return legacyDocs;
      }
      // Ghi thất bại (vd quota) — KHÔNG đánh dấu đã migrate, KHÔNG xóa dữ liệu cũ, để lần
      // sau còn thử lại; vẫn trả legacyDocs để UI có dữ liệu dùng ngay trong phiên này.
      return legacyDocs;
    }).catch(function () { return legacyDocs; });
  }

  return {
    getAll: getAll,
    saveAll: saveAll,
    migrateFromLegacyIfNeeded: migrateFromLegacyIfNeeded,
    _isIndexedDbUsable: function () { return indexedDbUsable; } // dùng cho test
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDocStore: createDocStore };
}
if (typeof window !== 'undefined') {
  window.createDocStore = createDocStore;
  window.docStore = createDocStore({
    indexedDB: window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB,
    localStorage: window.localStorage
  });
}
