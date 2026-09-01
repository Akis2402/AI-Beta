'use strict';

const express = require('express');
const router = express.Router();
const {
  getActiveProviders, callWithFailover, callFastest, streamWithFailover,
  gatherCrossCheckCandidates
} = require('../utils/aiProviders');
// Timeout riêng cho LƯỢT TỔNG HỢP cuối (sau khi đã có candidates) — tách khỏi CROSS_CHECK_BUDGET_MS
// (ngân sách đó chỉ tính cho bước THU THẬP lượt giải). Có timeout riêng, rõ ràng để lượt tổng hợp
// không bị "thừa hưởng" một REQUEST_TIMEOUT_MS quá dài rồi cộng dồn vượt quá maxDuration của hosting.
const RECONCILE_TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS) || 25000;
const {
  buildChatSystemPrompt,
  buildGradeSystemPrompt,
  buildVariantAddendum,
  buildReconcileSystemPrompt
} = require('../utils/promptBuilder');
const { validateChatBody } = require('../utils/validators');

// ---------- Tiện ích SSE (Server-Sent Events) dùng cho phản hồi streaming ----------
// Sự kiện phát ra cho client: "delta" (1 đoạn văn bản mới), "status" (thông báo tiến trình, vd
// đang đối chiếu đa hướng ở chế độ Sâu — không có delta nào trong lúc này), "done" (kết thúc
// thành công, kèm metadata provider/crossChecked), "error" (kết thúc do lỗi).
function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseHeaders(res) {
  // QUAN TRỌNG: phải dùng res.setHeader() cho TỪNG header rồi mới gọi res.writeHead(200) KHÔNG kèm
  // object headers — KHÔNG được gộp headers vào chung 1 lệnh res.writeHead(200, {...}) như trước.
  // NGUYÊN NHÂN GỐC của lỗi "AI streaming không xuất hiện" (hiệu ứng gõ chữ mất hẳn, câu trả lời
  // xuất hiện dồn cục 1 lần): server/app.js có bật app.use(compression({filter:...})) TOÀN CỤC,
  // module compression dùng thư viện "on-headers" để tự kiểm tra Content-Type NGAY TRƯỚC KHI
  // header thực sự được ghi ra socket — nhưng listener của "on-headers" chạy TRƯỚC KHI các header
  // truyền trực tiếp làm THAM SỐ của lệnh res.writeHead(status, headersObj) được áp dụng vào
  // res.getHeader(); nó CHỈ thấy được các header đã được set từ trước bằng res.setHeader(). Vì
  // vậy khi gọi res.writeHead(200, {'Content-Type':'text/event-stream',...}) trực tiếp như cũ,
  // tại thời điểm filter của compression chạy, res.getHeader('Content-Type') vẫn trả về undefined
  // (chưa "thấy" giá trị vừa truyền) => điều kiện bỏ qua nén KHÔNG khớp => compression vẫn nén
  // gzip response SSE này như bình thường, mà gzip stream lại ĐỆM một lượng dữ liệu nhất định
  // trước khi flush ra ngoài — kết quả là client nhận được các đoạn "delta" dồn cục thành từng
  // cụm lớn/chậm thay vì từng chữ một theo thời gian thực, nhìn như "mất" hiệu ứng streaming.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // vô hiệu hoá đệm ở các proxy kiểu Nginx (không ảnh hưởng Vercel nhưng vô hại)
  res.writeHead(200);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Tắt thuật toán Nagle trên socket TCP — một số môi trường hosting/proxy trung gian vẫn gộp các
  // lần res.write() nhỏ, liên tiếp lại thành 1 gói TCP để tối ưu băng thông, gây độ trễ hiển thị
  // dù server đã gửi đi đúng từng đoạn nhỏ. setNoDelay(true) buộc gửi ngay lập tức từng res.write().
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
}

router.post('/', async (req, res, next) => {
  const wantsStream = req.body && req.body.stream === true;
  try {
    const input = validateChatBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY trong .env).'
      );
      err.status = 500;
      throw err;
    }

    const userContent = [];
    if (input.image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: input.image.mediaType, data: input.image.base64 }
      });
    }
    userContent.push({
      type: 'text',
      text: input.query || 'Hãy đọc kỹ và giải chi tiết bài tập có trong hình ảnh này.'
    });

    const messages = [
      ...input.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userContent }
    ];

    // ============================================================================================
    // ---------- NHÁNH STREAMING (SSE) — chỉ áp dụng khi client gửi { stream: true } ----------
    // Chế độ "hướng giải" và "giải chi tiết KHÔNG sâu" chỉ có 1 lượt gọi AI duy nhất nên stream trực
    // tiếp toàn bộ. Chế độ Sâu + giai đoạn "giải chi tiết" vẫn cần thu thập nhiều lượt giải độc lập
    // song song trước (không hiển thị cho người dùng) rồi mới tổng hợp — chỉ lượt TỔNG HỢP cuối
    // cùng (thứ người dùng thực sự đọc) được stream, các lượt thu thập trước đó báo tiến trình qua
    // sự kiện "status" vì bản thân chúng không hiển thị trực tiếp lên giao diện.
    // ============================================================================================
    if (wantsStream) {
      sseHeaders(res);
      req.on('close', () => { try { res.end(); } catch (e) { /* đã đóng — bỏ qua */ } });

      try {
        if (input.crossCheck && input.stage === 'detail') {
          const system = buildChatSystemPrompt(input);
          const variantSystem = system + buildVariantAddendum();

          sseWrite(res, 'status', { message: 'Đang đối chiếu đa hướng…' });

          // Heartbeat: trong lúc thu thập các lượt giải (có thể im lặng nhiều giây, đặc biệt khi
          // đang thử lại provider lỗi), gửi định kỳ 1 comment SSE rỗng (":\n\n" — không phải sự
          // kiện, trình duyệt bỏ qua) để giữ kết nối "sống" trong mắt các proxy/CDN trung gian (vd
          // Vercel Edge Network) — tránh bị coi là kết nối treo và đóng ngang trước khi có dữ liệu.
          const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch (e) { /* đã đóng */ } }, 8000);

          let candidates;
          try {
            const gathered = await gatherCrossCheckCandidates(activeProviders, {
              system, variantSystem, messages, maxTokens: 1600,
              onStatus: (message) => sseWrite(res, 'status', { message })
            });
            candidates = gathered.candidates;
          } finally {
            clearInterval(heartbeat);
          }

          if (!candidates.length) {
            sseWrite(res, 'error', { message: 'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi giải bài. Vui lòng kiểm tra lại API key trong .env.' });
            return res.end();
          }

          const hasWebSearch = input.contexts.length === 0;
          const reconcileSystem = buildReconcileSystemPrompt({
            // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
            // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
            candidates,
            contexts: input.contexts,
            settings: input.settings,
            hasWebSearch,
            deepThinking: input.deepThinking
          });

          sseWrite(res, 'status', { message: 'Đang tổng hợp lời giải cuối cùng…' });

          let full = '';
          const { provider: reconciler } = await streamWithFailover(
            activeProviders,
            { system: reconcileSystem, messages, maxTokens: 2200, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS },
            (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
            { preferWebSearch: hasWebSearch }
          );

          sseWrite(res, 'done', {
            text: full,
            crossChecked: true,
            providers: candidates.map((c) => c.label),
            reconciledBy: reconciler.label
          });
          return res.end();
        }

        // ---------- Giai đoạn "hướng giải", chế độ "Nhanh", hoặc "chấm bài" (stage:'grade'): stream
        // trực tiếp 1 lượt duy nhất. "grade" dùng prompt riêng (buildGradeSystemPrompt) — vẫn chỉ 1
        // lượt gọi như "approach", không qua 2 bước hướng giải/lời giải chi tiết.
        const system = input.stage === 'grade' ? buildGradeSystemPrompt(input) : buildChatSystemPrompt(input);
        let full = '';
        const { provider } = await streamWithFailover(
          activeProviders,
          {
            system,
            messages,
            // LỖI GỐC (ảnh mới nhất người dùng gửi): giai đoạn "hướng giải" (approach) bị cắt ngang
            // giữa câu ("- Khai thác tính") vì maxTokens cố định 700 bất kể độ dài đề bài hay có bật
            // Suy nghĩ sâu hay không. Hai vấn đề gộp lại: (1) đề bài NHIỀU Ý (a, b, c.i, c.ii...) thì
            // riêng phần liệt kê hướng giải cho từng ý đã vượt xa 700 token; (2) buildChatSystemPrompt()
            // vẫn nối deepBlock (yêu cầu khối <thinking> nội bộ) vào CẢ giai đoạn approach khi bật Suy
            // nghĩ sâu (xem promptBuilder.js dòng có ${deepBlock} ở nhánh 'approach'), nhưng ngân sách
            // token trước đây không hề tăng theo — cùng lỗi gốc với giai đoạn "detail" đã sửa ở trên.
            // FIX: tăng maxTokens cho approach theo độ dài kỳ vọng, có cộng thêm khi deepThinking bật.
            // "grade" cần đủ chỗ để nhận xét từng bước học sinh viết (có thể nhiều bước) nên dùng
            // ngân sách gần với "detail" — không phụ thuộc deepThinking (chấm bài không có bước Suy
            // nghĩ sâu riêng, phong cách chấm-từng-bước vốn đã yêu cầu đối chiếu kỹ).
            maxTokens: input.stage === 'grade'
              ? 2600
              : input.stage === 'approach'
                ? (input.deepThinking ? 2200 : 1400)
                : (input.deepThinking ? 4000 : 2000),
            fast: true
          },
          (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); }
        );

        sseWrite(res, 'done', { text: full, crossChecked: false, provider: provider.label });
        return res.end();
      } catch (streamErr) {
        // Header SSE đã gửi (200 text/event-stream) — không thể chuyển sang next(err) để trả JSON
        // lỗi như luồng thường (sẽ crash vì response đã bắt đầu). Phát sự kiện "error" riêng cho
        // client tự xử lý, rồi đóng kết nối.
        sseWrite(res, 'error', {
          message: (streamErr && streamErr.message) || 'Có lỗi khi kết nối tới máy chủ AI.'
        });
        return res.end();
      }
    }

    // ---------- Công tắc "Đối chiếu đa hướng" + giai đoạn "giải chi tiết": đối chiếu đa mô hình ----------
    // Đây là công tắc ĐỘC LẬP với "Suy nghĩ sâu" (deepThinking chỉ ảnh hưởng suy luận NỘI BỘ của
    // từng lượt gọi — xem promptBuilder.js) — bật/tắt riêng, không phụ thuộc lẫn nhau.
    // KHÔNG có nhà cung cấp AI nào "chính"/"phụ" — mọi provider đang cấu hình khóa API đều giải
    // 1 lượt ĐỘC LẬP SONG SONG (nếu chỉ có 1 provider thì chính provider đó tự làm cả 2 lượt với
    // 2 góc nhìn khác nhau, vì không còn lựa chọn nào khác). Nếu 1 provider báo lỗi ở lượt của nó,
    // hệ thống TỰ ĐỘNG thử lại lượt đó bằng 1 provider KHÁC còn hoạt động (failover) để không mất
    // đi cơ hội đối chiếu chéo. Lượt TỔNG HỢP cuối cùng cũng KHÔNG cố định vào 1 nhà cung cấp nào —
    // được chọn NGẪU NHIÊN trong số các provider đang hoạt động (ưu tiên provider hỗ trợ tìm kiếm
    // web khi cần xác minh công thức), và cũng có failover tự động nếu provider được chọn lỗi.
    // (Chỉ áp dụng cho giai đoạn giải chi tiết — giai đoạn "hướng giải" luôn dùng 1 lượt gọi, nhanh gọn.)
    // LƯU Ý: nhánh JSON thường (không streaming) này chỉ còn được dùng khi trình duyệt không hỗ
    // trợ ReadableStream (xem apiPostStream() ở public/js/app.js) — client bình thường luôn gửi
    // stream:true nên chạy qua nhánh SSE phía trên. Dùng chung gatherCrossCheckCandidates() (có
    // ngân sách thời gian tổng + thử lại provider lỗi SONG SONG) để tránh lặp logic và tránh cộng
    // dồn thời gian chờ tuần tự — xem giải thích chi tiết ở đầu server/utils/aiProviders.js.
    if (input.crossCheck && input.stage === 'detail') {
      const system = buildChatSystemPrompt(input);
      const variantSystem = system + buildVariantAddendum();

      const { candidates } = await gatherCrossCheckCandidates(activeProviders, {
        system, variantSystem, messages, maxTokens: 1600
      });

      if (!candidates.length) {
        const err = new Error('Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi giải bài. Vui lòng kiểm tra lại API key trong .env.');
        err.status = 502;
        throw err;
      }

      const hasWebSearch = input.contexts.length === 0;
      const reconcileSystem = buildReconcileSystemPrompt({
        // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
        // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
        candidates,
        contexts: input.contexts,
        settings: input.settings,
        hasWebSearch,
        deepThinking: input.deepThinking
      });

      const { text: finalText, provider: reconciler } = await callWithFailover(
        activeProviders,
        { system: reconcileSystem, messages, maxTokens: 2200, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS },
        { preferWebSearch: hasWebSearch }
      );

      return res.json({
        text: finalText,
        crossChecked: true,
        providers: candidates.map((c) => c.label),
        reconciledBy: reconciler.label
      });
    }

    // ---------- Giai đoạn "hướng giải", chế độ "Nhanh", hoặc "chấm bài": đua tốc độ giữa các provider ----------
    // Không cố định vào 1 nhà cung cấp — mỗi request ĐUA TỐC ĐỘ đồng thời vài provider ngẫu nhiên
    // (callFastest) và dùng ngay kết quả của provider trả lời nhanh nhất, kèm model "nhanh" riêng
    // (fast:true) để giảm độ trễ. Nếu (các) provider trong nhóm đua đều lỗi/timeout, tự động mở
    // rộng đua sang provider còn lại trước khi báo lỗi cho người dùng.
    const system = input.stage === 'grade' ? buildGradeSystemPrompt(input) : buildChatSystemPrompt(input);
    const { text, provider } = await callFastest(activeProviders, {
      system,
      messages,
      // Cùng lý do với nhánh streaming ở trên — approach cắt ngang khi đề nhiều ý hoặc bật Suy nghĩ
      // sâu (deepBlock vẫn được nối vào cả stage approach, xem promptBuilder.js). "grade" dùng ngân
      // sách riêng, xem giải thích ở nhánh streaming phía trên.
      maxTokens: input.stage === 'grade'
        ? 2600
        : input.stage === 'approach'
          ? (input.deepThinking ? 2200 : 1400)
          : (input.deepThinking ? 4000 : 2000),
      fast: true
    });

    res.json({ text, crossChecked: false, provider: provider.label });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
