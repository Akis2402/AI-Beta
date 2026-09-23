'use strict';

// ============================================================================================
// V6.21.18/.19/.20 — GLOBAL WORKER POOL (interactive priority + reserved capacity)
// ============================================================================================
// TRƯỚC ĐÂY: không có cơ chế nào giới hạn/ưu tiên SỐ REQUEST đang xử lý đồng thời trong 1 tiến
// trình server — aiCallBudget.js chỉ đếm SỐ LỆNH GỌI AI *bên trong 1 request*, rotationManager.js
// chỉ lo fairness xoay API key *giữa các request*. Không module nào trả lời được câu: "nếu 1 việc
// nền (background) đang chiếm nhiều slot xử lý cùng lúc, request chat tương tác (interactive) có bị
// phải xếp hàng phía sau không?" — đây chính là kịch bản sự cố V6.21.19 mô tả ("YouTube indexing 20
// segments chiếm hết capacity rồi Quick chat phải đợi 40–60 giây").
//
// Module này là admission control CẤP REQUEST (1 acquire() = 1 request đang được xử lý), KHÔNG
// phải cấp lệnh gọi AI (đã có aiCallBudget.js lo, không đụng vào) — 2 tầng khác nhau, không thay
// thế nhau, giống hệt cách PHẦN D/DY/DZ tách "đếm token" khỏi "đếm lệnh gọi".
//
// GIỚI HẠN CHỦ ĐỘNG GHI RÕ (không giấu): đây là pool TRONG BỘ NHỚ CỦA 1 TIẾN TRÌNH. Đúng cho 1
// server Node/Express dài hạn (mọi request cùng 1 tiến trình cạnh tranh chung 1 pool — đúng kịch
// bản sự cố V6.21.19). Trên serverless-per-request (mỗi request = 1 tiến trình riêng, ví dụ Vercel
// Functions mặc định), pool này KHÔNG có tác dụng liên-request (không có state chia sẻ) — nhưng khi
// đó bản thân kịch bản "1 request nền chiếm slot của request khác" cũng không xảy ra theo cách này
// (mỗi request đã có tiến trình/container riêng, giới hạn concurrency khi đó nằm ở platform, không
// nằm ở tầng ứng dụng). Nếu deploy nhiều worker process dài hạn chia sẻ tải (PM2 cluster, nhiều
// container...), cần store dùng chung (Redis...) để pool đúng NGANG QUA các tiến trình — CÙNG giới
// hạn rotationManager.js đã ghi nhận cho fairness API key, KHÔNG giải quyết trong file này.

const PRIORITY = { INTERACTIVE: 'interactive', BACKGROUND: 'background' };

/**
 * createGlobalWorkerPool() — factory thuần, không có side-effect ngoài instance trả về. Cho phép
 * test tạo pool riêng (không đụng singleton `defaultPool` dùng chung toàn app).
 * @param {{globalCapacity?:number, interactiveReserve?:number}} [opts]
 */
function createGlobalWorkerPool({ globalCapacity = 12, interactiveReserve = 4 } = {}) {
  if (interactiveReserve > globalCapacity) {
    throw new Error(`globalWorkerPool: interactiveReserve (${interactiveReserve}) không được lớn hơn globalCapacity (${globalCapacity})`);
  }
  let activeInteractive = 0;
  let activeBackground = 0;
  const waitQueue = []; // { priority, resolve, reject, enqueuedAt, timer }

  const activeTotal = () => activeInteractive + activeBackground;
  // Slot "background" bị chặn ở (globalCapacity - interactiveReserve) NGAY CẢ KHI interactive đang
  // rảnh — đây là phần "reservation" thật sự (V6.21.20), không chỉ là ưu tiên thứ tự xử lý hàng đợi.
  const backgroundCapacity = () => Math.max(0, globalCapacity - interactiveReserve);

  function canAdmit(priority) {
    if (activeTotal() >= globalCapacity) return false;
    if (priority === PRIORITY.BACKGROUND) return activeBackground < backgroundCapacity();
    return true;
  }

  function admit(priority) {
    if (priority === PRIORITY.INTERACTIVE) activeInteractive++; else activeBackground++;
  }

  function makeRelease(priority) {
    let released = false;
    // Idempotent — release() gọi 2 lần (vd cả res.on('finish') LẪN res.on('close') cùng bắn) không
    // được trừ 2 lần, tránh activeInteractive/-Background bị âm.
    return function release() {
      if (released) return;
      released = true;
      if (priority === PRIORITY.INTERACTIVE) activeInteractive = Math.max(0, activeInteractive - 1);
      else activeBackground = Math.max(0, activeBackground - 1);
      drainQueue();
    };
  }

  function drainQueue() {
    if (!waitQueue.length) return;
    // Hàng đợi 2 mức: TOÀN BỘ interactive đang chờ luôn được xét trước background đang chờ, bất kể
    // ai xếp hàng trước — đúng tinh thần "interactive priority" (V6.21.19), FIFO chỉ áp dụng TRONG
    // cùng 1 mức ưu tiên.
    waitQueue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === PRIORITY.INTERACTIVE ? -1 : 1;
      return a.enqueuedAt - b.enqueuedAt;
    });
    for (let i = 0; i < waitQueue.length; i++) {
      const item = waitQueue[i];
      if (!canAdmit(item.priority)) continue;
      waitQueue.splice(i, 1);
      i--;
      if (item.timer) clearTimeout(item.timer);
      admit(item.priority);
      item.resolve(makeRelease(item.priority));
    }
  }

  /**
   * acquire() — xin 1 slot xử lý. Nếu còn chỗ, admit NGAY (đồng bộ về mặt logic, bọc Promise cho
   * API nhất quán). Nếu hết chỗ, xếp hàng theo `priority` tới khi có slot trống hoặc quá `timeoutMs`.
   * @param {{priority?:string, timeoutMs?:number}} [opts]
   * @returns {Promise<Function>} release() — PHẢI được gọi đúng 1 lần khi request xử lý xong (nên
   *   gọi qua res.on('finish')/res.on('close') để đảm bảo chạy kể cả khi lỗi/client ngắt kết nối).
   */
  function acquire({ priority = PRIORITY.INTERACTIVE, timeoutMs = Infinity } = {}) {
    return new Promise((resolve, reject) => {
      if (canAdmit(priority)) {
        admit(priority);
        resolve(makeRelease(priority));
        return;
      }
      const item = { priority, resolve, enqueuedAt: Date.now(), timer: null };
      waitQueue.push(item);
      if (Number.isFinite(timeoutMs)) {
        item.timer = setTimeout(() => {
          const idx = waitQueue.indexOf(item);
          if (idx === -1) return; // đã được admit đúng lúc timer bắn — bỏ qua
          waitQueue.splice(idx, 1);
          const err = new Error('Hệ thống đang xử lý nhiều yêu cầu, vui lòng thử lại sau ít giây.');
          err.code = 'WORKER_POOL_TIMEOUT';
          err.status = 503;
          reject(err);
        }, timeoutMs);
        // KHÔNG unref() timer này: nếu đây là timer duy nhất còn treo (vd script ngắn/test), Node coi
        // event loop "rỗng" và THOÁT TIẾN TRÌNH NGAY, khiến callback timeout KHÔNG BAO GIỜ chạy —
        // Promise treo lơ lửng vĩnh viễn, không resolve/reject, không log lỗi (phát hiện được chính
        // nhờ chạy test bên dưới: tiến trình thoát sạch giữa chừng, không có exception nào cả). Trong
        // server Express thật, HTTP server đang listen() đã tự giữ process sống — không cần unref ở
        // đây; correctness (timeout phải THẬT SỰ bắn) quan trọng hơn tối ưu nhỏ này.
      }
    });
  }

  function snapshot() {
    return {
      globalCapacity, interactiveReserve, backgroundCapacity: backgroundCapacity(),
      activeInteractive, activeBackground, activeTotal: activeTotal(),
      queued: waitQueue.length,
      queuedInteractive: waitQueue.filter((i) => i.priority === PRIORITY.INTERACTIVE).length,
      queuedBackground: waitQueue.filter((i) => i.priority === PRIORITY.BACKGROUND).length
    };
  }

  return { acquire, snapshot, PRIORITY };
}

// ---------- Singleton dùng chung cho cả app (đúng phạm vi: 1 tiến trình — xem ghi chú đầu file) ----------
const defaultPool = createGlobalWorkerPool({
  globalCapacity: Number(process.env.GLOBAL_WORKER_POOL_SIZE) || 12,
  interactiveReserve: Number(process.env.GLOBAL_WORKER_POOL_INTERACTIVE_RESERVE) || 4
});

module.exports = { createGlobalWorkerPool, defaultPool, PRIORITY };
