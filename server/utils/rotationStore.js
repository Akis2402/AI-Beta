'use strict';

// ============================================================================================
// ROTATION STATE STORE — fairness qua NHIỀU serverless instance (Vấn đề #3)
// ============================================================================================
// GIỚI HẠN CỦA BẢN TRƯỚC: `selectionState`/`keyHealth`/`modelHealth`/`targetHealth` là Map trong bộ
// nhớ tiến trình. Trên Vercel, mỗi request có thể chạy ở 1 instance KHÁC — nên:
//   - fairness chỉ đúng trong phạm vi 1 instance (10 instance = 10 vòng xoay độc lập, target đầu
//     danh sách bị ưu tiên nhiều hơn mức đáng có);
//   - cooldown còn tệ hơn: instance B KHÔNG biết instance A vừa nhận 429 cho khóa đó, nên vẫn gọi
//     tiếp vào đúng khóa đang bị rate-limit → 429 lặp lại, tốn lượt gọi và làm chậm request.
//
// CÁCH TIẾP CẬN (không thêm dependency, không đổi API đồng bộ của rotationManager):
//   HYDRATE (đọc) 1 lần mỗi request  →  quyết định TRONG BỘ NHỚ (đồng bộ, nhanh)  →  WRITE-BEHIND
//   (ghi bất đồng bộ, fire-and-forget) sau khi markSuccess/markFailure.
//
// `orderByRotation()` phải là ĐỒNG BỘ (nó nằm giữa vòng failover) nên không thể await ở đó. Vì vậy
// nhất quán ở đây là EVENTUAL, không phải tuyệt đối: 2 request khởi động ĐỒNG THỜI ở 2 instance có
// thể cùng chọn 1 target. Đây là đánh đổi có chủ ý và được ghi rõ; nó vẫn tốt hơn hẳn trạng thái
// per-instance thuần vì cooldown và mốc LRU được lan truyền trong vài trăm ms.
//
// Driver: HTTP REST tương thích Upstash Redis / Vercel KV (đều nhận `GET/SET` qua REST + Bearer
// token), gọi bằ`fetch` có sẵn của Node 18+ — KHÔNG cần cài thêm package nào.
// Bật bằng .env:
//   ROTATION_STORE_URL=https://<...>.upstash.io
//   ROTATION_STORE_TOKEN=<token>
//   ROTATION_STORE_KEY=airotation:v1        (tuỳ chọn)
//   ROTATION_STORE_TTL_SEC=900              (tuỳ chọn)
// KHÔNG cấu hình -> hoạt động y hệt bản cũ (in-memory per-instance), không lỗi, không log ồn.

const STORE_URL = (process.env.ROTATION_STORE_URL || '').replace(/\/+$/, '');
const STORE_TOKEN = process.env.ROTATION_STORE_TOKEN || '';
const STORE_KEY = process.env.ROTATION_STORE_KEY || 'airotation:v1';
const STORE_TTL_SEC = Number(process.env.ROTATION_STORE_TTL_SEC) || 900;
// Không hydrate lại liên tục: 1 lần / HYDRATE_MIN_INTERVAL_MS là đủ để lan truyền cooldown mà không
// biến mỗi request thành 1 lượt gọi mạng phụ.
const HYDRATE_MIN_INTERVAL_MS = Number(process.env.ROTATION_STORE_HYDRATE_MS) || 2000;
const WRITE_DEBOUNCE_MS = Number(process.env.ROTATION_STORE_WRITE_MS) || 400;
const FETCH_TIMEOUT_MS = 1500;

function isEnabled() {
  return Boolean(STORE_URL && STORE_TOKEN);
}

let lastHydrateAt = 0;
let pendingWriteTimer = null;
let snapshotProvider = null; // () => object  (rotationManager cung cấp)
let snapshotApplier = null;  // (obj) => void (rotationManager cung cấp)
const stats = { hydrates: 0, writes: 0, errors: 0, slots: 0, lastError: null };

/**
 * rotationManager gọi hàm này 1 lần khi load để "cắm" 2 callback đọc/ghi trạng thái của nó. Nhờ vậy
 * module store KHÔNG cần biết gì về cấu trúc health/LRU (tách trách nhiệm), và rotationManager vẫn
 * chạy bình thường khi store không được cấu hình.
 */
function register({ getSnapshot, applySnapshot }) {
  snapshotProvider = getSnapshot;
  snapshotApplier = applySnapshot;
}

async function restFetch(pathParts, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${STORE_URL}/${pathParts.map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${STORE_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`store HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * hydrate() — nạp trạng thái dùng chung vào bộ nhớ. GỌI Ở ĐẦU REQUEST (đã nối vào
 * aiProviders.ensureProvidersReady) và KHÔNG BAO GIỜ throw: store lỗi/chậm thì request vẫn chạy
 * bình thường với trạng thái local (best-effort, không phải load-bearing).
 * @returns {Promise<boolean>} true nếu đã áp dụng được snapshot từ store.
 */
async function hydrate() {
  if (!isEnabled() || !snapshotApplier) return false;
  const now = Date.now();
  if (now - lastHydrateAt < HYDRATE_MIN_INTERVAL_MS) return false;
  lastHydrateAt = now;
  try {
    const json = await restFetch(['get', STORE_KEY]);
    const raw = json && json.result;
    if (!raw) return false;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    snapshotApplier(parsed);
    extraSnapshotAppliers.forEach((e) => {
      try { if (parsed[e.name]) e.applySnapshot(parsed[e.name]); } catch (_) { /* bỏ qua */ }
    });
    stats.hydrates += 1;
    return true;
  } catch (e) {
    stats.errors += 1;
    stats.lastError = e && e.message;
    return false;
  }
}

/**
 * scheduleWrite() — ghi write-behind, có debounce. Được gọi từ markSuccess/markFailure nên phải RẤT
 * rẻ và KHÔNG chặn: nó chỉ hẹn 1 timer, việc gọi mạng xảy ra sau đó, lỗi bị nuốt.
 */
function scheduleWrite() {
  if (!isEnabled() || !snapshotProvider) return;
  if (pendingWriteTimer) return;
  pendingWriteTimer = setTimeout(async () => {
    pendingWriteTimer = null;
    try {
      const snap = snapshotProvider();
      extraSnapshotProviders.forEach((e) => {
        try { snap[e.name] = e.getSnapshot(); } catch (_) { /* module phụ lỗi không được làm hỏng snapshot chính */ }
      });
      await restFetch(['set', STORE_KEY, ...(STORE_TTL_SEC ? ['EX', String(STORE_TTL_SEC)] : [])], JSON.stringify(snap));
      stats.writes += 1;
    } catch (e) {
      stats.errors += 1;
      stats.lastError = e && e.message;
    }
  }, WRITE_DEBOUNCE_MS);
  if (pendingWriteTimer.unref) pendingWriteTimer.unref(); // không giữ tiến trình sống (quan trọng với serverless)
}

// ============================================================================================
// FAIRNESS TUYỆT ĐỐI QUA ATOMIC INCR (sửa giới hạn "eventual consistency" của vòng trước)
// ============================================================================================
// VÌ SAO vòng trước chỉ đạt eventual: `orderByRotation()` là ĐỒNG BỘ (nằm giữa vòng failover) nên
// không await được → mọi instance chỉ đọc snapshot cũ → 2 request khởi động cùng lúc ở 2 instance
// có thể chọn TRÙNG target.
//
// CÁCH SỬA: KHÔNG cố làm `orderByRotation()` thành async (thay đổi đó lan ra toàn bộ call chain).
// Thay vào đó, ĐẶT TRƯỚC 1 "vé xoay" (rotation slot) ở ĐẦU REQUEST — nơi đã là async sẵn
// (ensureProvidersReady). Store INCR một bộ đếm toàn cục và trả về số nguyên DUY NHẤT cho request
// này; không request nào trên bất kỳ instance nào nhận cùng một số. `orderByRotation()` sau đó chỉ
// việc dùng số đó làm điểm bắt đầu vòng xoay — vẫn đồng bộ, nhưng đã mang thông tin TOÀN CỤC.
//
// INCR là toán tử nguyên tử phía Redis, nên đây là fairness THẬT SỰ, không phải xấp xỉ:
//   request thứ k trên toàn hệ thống  ->  slot k  ->  target thứ (k mod n) trong danh sách eligible.
// Khi store tắt/lỗi: trả null và rotation quay về LRU in-memory như cũ (không bao giờ chặn request).

const SLOT_KEY = `${STORE_KEY}:slot`;

/**
 * reserveRotationSlot() — lấy 1 số thứ tự xoay DUY NHẤT toàn cục cho request hiện tại.
 * @returns {Promise<number|null>} null khi store tắt hoặc lỗi (caller tự fallback sang LRU local).
 */
async function reserveRotationSlot() {
  if (!isEnabled()) return null;
  try {
    const json = await restFetch(['incr', SLOT_KEY]);
    const n = json && Number(json.result);
    if (!Number.isFinite(n)) return null;
    stats.slots += 1;
    return n;
  } catch (e) {
    stats.errors += 1;
    stats.lastError = e && e.message;
    return null;
  }
}

/**
 * Chia sẻ luôn dữ liệu HIỆU CHỈNH TOKEN qua cùng store (sửa tồn đọng #4 vòng trước: calibration
 * cũng là in-memory per-instance, nên instance mới luôn phải học lại từ đầu bằng 3 request đầu tiên).
 * Dùng chung snapshot với rotation để không phát sinh thêm lượt gọi mạng nào.
 */
let extraSnapshotProviders = [];
let extraSnapshotAppliers = [];
function registerExtra({ getSnapshot, applySnapshot, name }) {
  extraSnapshotProviders.push({ name, getSnapshot });
  extraSnapshotAppliers.push({ name, applySnapshot });
}

function getStoreStats() {
  return { enabled: isEnabled(), ...stats };
}

function _resetForTest() {
  lastHydrateAt = 0;
  stats.slots = 0;
  if (pendingWriteTimer) { clearTimeout(pendingWriteTimer); pendingWriteTimer = null; }
  stats.hydrates = 0; stats.writes = 0; stats.errors = 0; stats.lastError = null;
}

module.exports = {
  isEnabled, register, registerExtra, hydrate, scheduleWrite, reserveRotationSlot,
  getStoreStats, _resetForTest
};
