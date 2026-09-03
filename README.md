# Trợ Giải — AI học tập (Full-stack)

Ứng dụng giải bài tập bằng AI, có trích nguồn từ tài liệu (PDF/Word/TXT), đọc ảnh đề bài, vẽ đồ thị/hình học, và xuất flashcard / đề cương ôn tập.

Kiến trúc **tách frontend – backend** đúng chuẩn web thực tế:

```
tro-giai-ai/
├── api/
│   └── index.js          ← Entry point RIÊNG cho Vercel (serverless function).
│                            Chỉ export lại server/app.js, Vercel tự nhận diện
│                            thư mục /api và gọi file này cho mọi request /api/*.
├── server/                ← Backend Node.js/Express (giữ API key, xử lý bảo mật)
│   ├── app.js             ← TOÀN BỘ cấu hình Express: middleware + routes
│   │                          (không gọi app.listen — dùng chung cho cả local lẫn Vercel)
│   ├── index.js            ← chỉ dùng khi chạy LOCAL (npm start/dev), gọi app.listen()
│   ├── middleware/
│   │   ├── security.js    ← helmet, CORS, rate-limit, khóa dùng chung
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── chat.js        ← POST /api/chat  (giải bài)
│   │   └── generate.js    ← POST /api/generate/flashcards, /api/generate/outline, /api/generate/mindmap
│   └── utils/
│       ├── anthropicClient.js  ← gọi Anthropic API bằng khóa server-side
│       ├── promptBuilder.js    ← server tự dựng system prompt (chống prompt injection)
│       └── validators.js       ← validate & sanitize mọi input từ client
├── public/                 ← Frontend tĩnh (HTML/CSS/JS thuần, không cần build)
│   │                          Trên Vercel, thư mục này được phục vụ trực tiếp làm site tĩnh
│   │                          (xem "outputDirectory" trong vercel.json).
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── config.js       ← cấu hình công khai phía client
│       ├── formulas.js     ← dữ liệu tĩnh: danh mục công thức cốt lõi theo môn/khối lớp
│       ├── solid3d.js      ← vẽ hình học không gian 3D xoay được (three.js)
│       └── app.js          ← toàn bộ logic giao diện, gọi backend qua fetch
├── vercel.json             ← cấu hình deploy cho Vercel (routing + thời gian chạy function)
├── package.json
├── .env.example
└── .gitignore
```

## 1. Cài đặt

Yêu cầu **Node.js ≥ 18** (dùng `fetch` có sẵn, không cần cài thêm thư viện HTTP).

```bash
cd tro-giai-ai
npm install
cp .env.example .env
```

Mở file `.env` vừa tạo, điền khóa API Anthropic thật của bạn:

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx
```

## 2. Chạy

```bash
npm start        # chạy production
# hoặc
npm run dev       # tự khởi động lại khi sửa code (Node --watch)
```

Mở trình duyệt tại **http://localhost:3000**.

## 3. Vì sao tách backend thay vì gọi thẳng Anthropic API từ trình duyệt?

Nếu gọi thẳng từ frontend, khóa API bắt buộc phải nhúng vào mã JavaScript công khai — bất kỳ ai mở DevTools cũng lấy được và có thể dùng khóa đó tiêu tiền của bạn. Vì vậy dự án này dùng mô hình chuẩn:

```
Trình duyệt  →  Backend (giữ khóa API)  →  Anthropic API
```

Khóa `ANTHROPIC_API_KEY` **chỉ tồn tại trên server**, không bao giờ được gửi xuống client.

## 4. Các lớp bảo mật đã áp dụng

| Lớp | Vị trí | Mục đích |
|---|---|---|
| **Helmet** (CSP, HSTS, các security header) | `server/middleware/security.js` | Chặn XSS, clickjacking, MIME sniffing; khai báo rõ domain CDN được phép tải script/font |
| **CORS** | `server/middleware/security.js` | Tự động cho phép origin **cùng domain** với chính server (trường hợp mặc định của dự án — frontend & backend chung 1 domain Vercel), cộng thêm whitelist tùy chọn `ALLOWED_ORIGINS` cho các domain khác |
| **Rate limiting** | `server/middleware/security.js` | Giới hạn số request/15 phút theo IP — chống spam và giới hạn chi phí gọi Anthropic API (`RATE_LIMIT_CHAT`, `RATE_LIMIT_GENERATE`) |
| **Input validation & sanitize** | `server/utils/validators.js` | Giới hạn độ dài câu hỏi, số lượng/độ dài quy tắc, số đoạn trích nguồn, dung lượng ảnh (≤5MB), whitelist định dạng ảnh, loại bỏ ký tự điều khiển |
| **System prompt do server tự dựng** | `server/utils/promptBuilder.js` | Client **không thể** gửi thẳng "system prompt" xuống — mọi hành vi của AI luôn do server quyết định dựa trên dữ liệu đã kiểm duyệt, chống prompt injection ở tầng hệ thống |
| **Giới hạn kích thước request** | `express.json({limit:'8mb'})` trong `server/index.js` | Chặn request quá lớn gây tốn tài nguyên |
| **Ẩn chi tiết lỗi khi production** | `server/middleware/errorHandler.js` | Không lộ stack trace / thông tin nội bộ ra client khi `NODE_ENV=production` |
| **Khóa dùng chung tùy chọn** (`APP_SHARED_KEY`) | `server/middleware/security.js` + `public/js/config.js` | Lớp chặn cơ bản bổ sung khi deploy công khai — không thay thế xác thực người dùng thật |
| **`app.disable('x-powered-by')`** | `server/index.js` | Ẩn thông tin framework đang dùng |

**Lưu ý khi triển khai thật:**
- Luôn chạy sau HTTPS (Nginx/Caddy reverse proxy, hoặc nền tảng PaaS có sẵn TLS như Render/Railway/Fly.io).
- Đặt `NODE_ENV=production` và cập nhật `ALLOWED_ORIGINS` đúng domain thật.
- Nếu cần nhiều người dùng riêng biệt (tài khoản, lịch sử theo user), cần bổ sung lớp xác thực thật (JWT/session + database) — hiện tại quy tắc/lịch sử chỉ lưu cục bộ trên trình duyệt người dùng (`localStorage`), phù hợp cho dùng cá nhân/nhóm nhỏ.

## 5. Các cơ chế học tập

- **Trích nguồn từ tài liệu** (kiểu NotebookLM): nạp PDF/DOCX/TXT, AI chỉ dùng nguồn đang bật, trích dẫn `[1] [2]...` kèm đoạn văn bản gốc.
- **Đọc ảnh đề bài**: chụp/đính kèm ảnh (chữ viết tay hoặc đề in), AI đọc và giải trực tiếp.
- **Giải 2 giai đoạn — Hướng giải rồi mới Lời giải chi tiết**: AI luôn đưa **Hướng giải** (phương pháp, công thức sẽ dùng, các bước chính — chưa tính toán, chưa ra đáp số) trước, giống một người thầy gợi ý; người dùng bấm **"Xem cách giải chi tiết"** khi đã tự thử mà chưa ra hoặc muốn xem lời giải đầy đủ có đáp số.
- **Mindmap trực quan (sơ đồ tư duy nhiều màu)**: sau mỗi lời giải/đề cương, bấm nút **"Mindmap trực quan"**, hoặc gõ thẳng trong ô chat kiểu "vẽ sơ đồ tư duy cho chương này" / "tóm tắt bằng mindmap" — AI (`POST /api/generate/mindmap`, xem `buildMindmapSystemPrompt` trong `server/utils/promptBuilder.js`) hệ thống hóa nội dung thành cây phân cấp (chủ đề trung tâm → 3-7 nhánh chính, mỗi nhánh 1 màu riêng → ý con → ý cháu, tối đa 3 cấp). Client tự vẽ SVG bố cục tròn (radial layout, hàm `renderMindmap` trong `public/js/app.js`) — không cần thư viện ngoài — có thể **phóng to/thu nhỏ, kéo xem, toàn màn hình, tải ảnh PNG**.
- **Soạn đề cương = 1 lượt duy nhất, KHÔNG qua 2 giai đoạn ở trên** (khác với giải bài): khi câu hỏi được nhận diện là xin **soạn/tóm tắt/hệ thống hóa đề cương** (vd "cho mình đề cương chương 3", "tóm tắt lý thuyết bài này", hàm `isOutlineRequest()` trong `public/js/app.js`) — thay vì chạy qua "Hướng giải" rồi chờ bấm "Xem cách giải chi tiết" như 1 bài toán, hệ thống gọi **thẳng 1 lần duy nhất** `POST /api/generate/outline` (`handleOutlineOnlyTurn()`) và trả về **ngay 1 câu trả lời hoàn chỉnh** (định nghĩa + công thức + bài tập nếu có) hiển thị trong khung chat, **kèm sẵn nút tải file `.docx`** ngay bên dưới — không có bước trung gian nào khác. Cơ chế **"Đề cương .docx" theo modal** (bấm sau khi đã có 1 câu trả lời/lời giải bất kỳ, ở khối nút học tập) vẫn được giữ song song như một lựa chọn thủ công để chuyển đổi 1 câu trả lời **đã có sẵn** (vd 1 bài đã giải chi tiết) thành đề cương ôn tập — 2 luồng dùng chung `buildAndDownloadOutlineDocx()` nên file tạo ra luôn nhất quán về định dạng.
- **Chế độ "Suy nghĩ sâu" = đối chiếu đa mô hình, không AI nào cố định**: ở bước giải chi tiết, hệ thống gọi **song song từng nhà cung cấp AI đã cấu hình khóa API trong `.env`** (Claude, và tùy chọn thêm GPT/OpenAI, Gemini/Google — xem `server/utils/aiProviders.js`) để mỗi model giải **độc lập một lượt**, rồi dùng một lượt **tổng hợp cuối cùng** để **so sánh, kiểm tra chéo công thức giữa các mô hình khác nhau** và viết lại lời giải chính xác nhất. **Không có nhà cung cấp nào được ưu tiên cố định** — kể cả lượt tổng hợp cuối cũng được **chọn ngẫu nhiên** trong số các provider đang hoạt động ở mỗi lần gọi (xem `callWithFailover()` trong `aiProviders.js`), nên về lâu dài mọi model có khóa API đều được dùng công bằng như nhau, không có model nào "luôn là người quyết định". Lượt tổng hợp luôn ưu tiên đối chiếu công thức với **nguồn tài liệu do người dùng cung cấp** (PDF/Word/TXT đã nạp) nếu có; nếu câu hỏi **không có nguồn tài liệu riêng**, lượt tổng hợp dùng công cụ **tìm kiếm web tích hợp sẵn** (cả 3 nhà cung cấp — Claude, GPT, Gemini — trong dự án này đều hỗ trợ) để xác minh công thức trên các trang uy tín (SGK, trang giáo dục, Wikipedia, tài liệu học thuật...) trước khi chốt câu trả lời — giảm rủi ro AI "bịa" công thức. Nếu một provider báo lỗi (khóa API sai/hết hạn mức, bug tạm thời...) ở bất kỳ lượt nào, hệ thống **tự động chuyển sang provider khác còn hoạt động** (failover) mà không làm gián đoạn câu trả lời cho người dùng. Nếu `.env` chỉ cấu hình 1 nhà cung cấp, chính provider đó đảm nhiệm mọi lượt (không còn lựa chọn nào khác) — xem mục 8 để bật thêm nhà cung cấp AI.
- **Chế độ "Nhanh" cũng không cố định vào 1 AI, và được tối ưu tốc độ**: mỗi câu hỏi ở chế độ Nhanh (bước "Hướng giải" và bước "Lời giải chi tiết" khi tắt "Suy nghĩ sâu") **đua tốc độ đồng thời** vài provider chọn ngẫu nhiên (tối đa 2, hoặc ít hơn nếu chưa cấu hình đủ) và dùng ngay kết quả của provider trả lời **nhanh nhất** — không phải chờ tuần tự. Mỗi provider còn dùng riêng một **model "nhanh"** (vd Claude Haiku thay vì Sonnet, GPT-4.1-mini thay vì GPT-4.1, Gemini Flash-Lite thay vì Flash) để giảm độ trễ hơn nữa. Nếu (các) provider trong nhóm đua đều lỗi/quá chậm, hệ thống tự mở rộng đua sang provider còn lại trước khi báo lỗi. Giao diện hiển thị "Trả lời bởi: ..." bên dưới câu trả lời để người dùng luôn biết chính xác model nào đã trả lời.
- **Timeout + tự động chuyển provider khi lỗi (failover)**: mỗi lượt gọi 1 nhà cung cấp AI đều có giới hạn thời gian chờ (`REQUEST_TIMEOUT_MS` trong `.env`, mặc định 30s) — quá thời gian này, hoặc nếu API key sai/hết hạn mức/lỗi máy chủ, hệ thống **tự động chuyển sang nhà cung cấp khác** đang hoạt động mà không làm gián đoạn câu trả lời cho người dùng.
- **Thêm nhà cung cấp AI mới không cần sửa code**: các hãng có API tương thích chuẩn OpenAI (Grok/xAI, DeepSeek, Mistral, Groq, OpenRouter...) chỉ cần điền khóa API vào `.env` là được **tự động nhận diện** và đưa vào vòng xoay tua/đua tốc độ ngay — xem `server/config/extraProviders.js` và mục 8.
- **Vẽ đồ thị hàm số & hình học phẳng**: AI tự chèn minh họa khi cần (khảo sát hàm số, tam giác, đường tròn...).
- **Vẽ hình học không gian 3D xoay được**: với bài hình chóp/lăng trụ/hộp/nón/trụ/cầu, AI chèn mô hình 3D (three.js) có thể kéo để xoay, cuộn để phóng to/thu nhỏ, tự xoay nhẹ khi không tương tác.
- **Danh mục công thức cốt lõi**: tab **"Công thức"** ở khung bên trái, lọc theo **Cấp học & Khối/lớp** đặt trong ⚙️ Cài đặt → hiển thị công thức Toán/Lý/Hóa đúng chương trình đang học.
- **Ghi chú**: sau mỗi câu trả lời, bấm **"Lưu ghi chú"** để lưu câu hỏi + tóm tắt lời giải vào tab **"Ghi chú"**, xem lại bất cứ lúc nào.
- **Lịch sử nhiều cuộc trò chuyện**: tab **"Lịch sử"** liệt kê mọi cuộc trò chuyện đã lưu (kiểu danh sách chat hiện đại), bấm **"Cuộc trò chuyện mới"** để bắt đầu phiên mới, xóa từng cuộc trò chuyện riêng lẻ.
- **Flashcard ôn tập**: tạo bộ thẻ hỏi–đáp ngắn gọn, lật xem trực tiếp trong giao diện.
- **Xuất đề cương `.docx`**: bấm **"Đề cương .docx"** dưới bất kỳ lời giải/kiến thức nào để AI soạn lại thành một đề cương **định nghĩa + công thức quan trọng** theo từng chủ đề, rõ ràng và bám sát đúng nội dung đã trao đổi (chỉ bổ sung thêm kiến thức nền khi thực sự cần, dựa trên kiến thức chuẩn — không bịa công thức/định nghĩa). Có thể bật thêm tùy chọn **"Thêm bài tập luyện tập"** để đề cương kèm bài tập chia theo **4 mức độ** (Nhận biết → Thông hiểu → Vận dụng → Vận dụng cao), đáp số/gợi ý được gom riêng vào phần phụ lục cuối file cho gọn gàng. Backend (`POST /api/generate/outline`, xem `promptBuilder.js#buildOutlineSystemPrompt`) chỉ trả về dữ liệu JSON có cấu trúc; file `.docx` thật được **dựng và tải trực tiếp phía trình duyệt** bằng thư viện `docx.js` (`buildAndDownloadOutlineDocx()` trong `public/js/app.js`) — server không lưu hay tạo file nhị phân nào.
- **Quy tắc tự học**: người dùng tự đặt quy tắc riêng (VD: "luôn trình bày theo bước có đánh số"), AI ghi nhớ lâu dài.
- **Giao diện tương thích di động**: sidebar thu vào menu trượt, các nút/thẻ tự co giãn, modal Cài đặt hiển thị kiểu bottom-sheet trên màn hình nhỏ.

Tất cả dữ liệu cá nhân lưu cục bộ trên chính thiết bị đang dùng — ứng dụng không có tài khoản người dùng, không cần đăng nhập. `localStorage` chỉ lưu dữ liệu nhỏ (quy tắc, cuộc trò chuyện, ghi chú, cài đặt, flag/theme); riêng **nguồn tài liệu đã nạp (PDF/DOCX/TXT đã parse, có thể rất lớn)** được lưu trong **IndexedDB** (`public/js/storage.js`, `window.docStore`) để tránh chạm giới hạn dung lượng/đồng bộ của `localStorage` — có migration tự động 1 lần từ dữ liệu cũ và fallback an toàn về `localStorage` nếu trình duyệt không hỗ trợ IndexedDB.

## 6. API nội bộ (dùng bởi frontend)

| Endpoint | Method | Mô tả |
|---|---|---|
| `/api/health` | GET | Kiểm tra server còn sống |
| `/api/chat` | POST | Giải bài — nhận `query`, `deep`, `stage` (`approach`\|`detail`), `approachText`, `image`, `rules`, `contexts`, `settings`, `history`. Trả `{text, crossChecked}` (chế độ Nhanh trả kèm `provider`; chế độ Sâu trả kèm `providers`, `reconciledBy`) |
| `/api/generate/flashcards` | POST | Nhận `content`, trả JSON bộ flashcard |
| `/api/generate/outline` | POST | Nhận `content` (+ tùy chọn bài tập luyện tập), trả JSON đề cương (định nghĩa + công thức) để dựng file `.docx` phía trình duyệt |
| `/api/generate/mindmap` | POST | Nhận `content`, trả JSON cây phân cấp (chủ đề → nhánh → ý con) để client tự vẽ SVG mindmap |
| `/api/recommend` | POST | Nhận `query` (câu hỏi vừa gửi), trả `{topic, links:[{url,title,note,domain}], isFallback}` — danh sách trang chứa bài tập/đề ôn tập liên quan, hiển thị ở khung "📚 Đề xuất ôn tập" bên phải màn hình. Xem mục 11. |

Toàn bộ đều yêu cầu header `Content-Type: application/json`; nếu bật `APP_SHARED_KEY` thì cần thêm header `x-app-key`.

`POST /api/chat` khi bật "Suy nghĩ sâu" + `stage:"detail"` trả thêm `providers` (mảng tên các model đã tham gia đối chiếu chéo, vd `["Claude (claude-sonnet-5)", "GPT (gpt-4.1)"]`) và `reconciledBy` (tên model được **chọn ngẫu nhiên** để thực hiện lượt tổng hợp cuối — không cố định), hiển thị ngay trong huy hiệu "✔️ Đã đối chiếu..." trên giao diện. Ở chế độ Nhanh (không bật "Suy nghĩ sâu"), response trả thêm `provider`: tên model (chọn ngẫu nhiên trong số đang hoạt động) đã trả lời câu hỏi đó, hiển thị dưới dạng "Trả lời bởi: ..." trên giao diện.

## 7. Deploy lên Vercel

Vercel là nền tảng **serverless** — nó không chạy `app.listen()` như server thường mà chỉ gọi các file trong thư mục `/api` khi có request tới. Dự án đã được cấu trúc sẵn cho việc này (`api/index.js` + `vercel.json`), bạn chỉ cần:

1. **Đẩy code lên GitHub** (hoặc GitLab/Bitbucket).
2. Vào [vercel.com](https://vercel.com) → **Add New → Project** → chọn repo này.
3. Vercel sẽ tự nhận diện (không cần chọn Framework Preset, để **"Other"** là được — không cần Build Command).
4. **Environment Variables** trong phần cài đặt project (Settings → Environment Variables), điền y hệt các biến trong `.env.example`:
   - `ANTHROPIC_API_KEY` — **bắt buộc**, khóa API thật của bạn.
   - `ALLOWED_ORIGINS` — thường **để trống là được**: server tự động cho phép origin cùng domain với chính nó (trường hợp mặc định — frontend & backend chung 1 domain Vercel). Chỉ điền vào đây nếu bạn có domain KHÁC cần gọi API (custom domain riêng, app di động...).
   - `NODE_ENV=production`
   - Các biến còn lại (`RATE_LIMIT_CHAT`, `RATE_LIMIT_GENERATE`, `APP_SHARED_KEY`...) tùy chọn.
5. Nhấn **Deploy**. Sau khi xong, mở domain Vercel cấp và thử chat — request `/api/chat` giờ sẽ được `vercel.json` chuyển đúng vào `api/index.js`.

**Lỗi "Origin không được phép bởi chính sách CORS" (nếu gặp lại):** phiên bản trước của `server/middleware/security.js` chỉ whitelist origin lấy từ biến môi trường `ALLOWED_ORIGINS` (mặc định `http://localhost:3000`) — khi deploy lên Vercel mà không cấu hình biến này, domain Vercel thật (vd `https://ten-app.vercel.app`) không nằm trong whitelist nên MỌI request bị chặn ngay cả khi cùng origin. Bản hiện tại đã tự động so khớp origin với header `Host`/`X-Forwarded-Host` của chính request, nên trường hợp phổ biến (frontend + backend chung domain) hoạt động ngay không cần cấu hình gì thêm.

**Về thời gian chờ (đã fix lỗi timeout ở "Đối chiếu đa hướng"):** chế độ này ở bước giải chi tiết gọi API AI nhiều lần (mỗi provider giải 1 lượt song song, có thể thêm lượt thử lại nếu 1 provider lỗi, rồi 1 lượt tổng hợp/đối chiếu cuối kèm tra cứu web) nên chậm hơn hẳn chế độ Nhanh. Bản trước đây thử lại provider lỗi **tuần tự** (từng provider, từng ứng viên một) và **không có ngân sách thời gian tổng** cho cả pipeline — mỗi lượt có thể chờ tới hết `REQUEST_TIMEOUT_MS` (mặc định 30s) rồi mới coi là lỗi, nên với 2-3 provider và vài lần lỗi, tổng thời gian cộng dồn dễ dàng vượt quá thời gian tối đa mà Vercel cho phép 1 serverless function chạy → hàm bị **nền tảng hủy giữa chừng** (không phải AI trả lời chậm) → người dùng thấy "mất kết nối" ngay cả khi bài không quá khó.

Đã sửa ở 2 lớp:
1. **`server/utils/aiProviders.js` — `gatherCrossCheckCandidates()`**: toàn bộ bước thu thập lượt giải giờ dùng chung 1 ngân sách thời gian (`CROSS_CHECK_BUDGET_MS` trong `.env`, mặc định 45s), mọi lượt thử lại provider lỗi chạy **song song** (không còn tuần tự), và timeout của mỗi lượt tự co lại theo ngân sách còn dư — khi gần hết ngân sách, hệ thống dùng ngay số lượt đã có (tối thiểu 1) thay vì cố thử thêm rồi bị hủy toàn bộ. Lượt tổng hợp cuối có timeout riêng (`RECONCILE_TIMEOUT_MS`, mặc định 25s).
2. **`vercel.json`**: `maxDuration` nâng lên `300` (giây). **Lưu ý quan trọng nếu bạn đang ở gói Vercel Hobby (miễn phí)**: Hobby mặc định giới hạn CỨNG 10 giây/function bất kể `maxDuration` khai báo trong `vercel.json` — muốn dùng được tới 300s (kể cả trên Hobby) bạn phải bật **Fluid Compute** trong Project Settings → Functions trên dashboard Vercel (Hobby + Fluid Compute cũng được cấp tối đa 300s). Không bật Fluid Compute thì dù sửa code xong vẫn sẽ timeout ở khoảng 10s. Ở gói Pro, `maxDuration` tới 300s hoạt động không cần Fluid Compute.

Nếu vẫn gặp timeout với bài cực khó/nhiều provider, có thể giảm thêm `CROSS_CHECK_BUDGET_MS`/`RECONCILE_TIMEOUT_MS`/`maxTokens` trong `.env`/`routes/chat.js` để cắt lỗ sớm hơn, đổi lấy khả năng ít provider được đối chiếu hơn. Chế độ Nhanh không bị ảnh hưởng bởi vấn đề này — `callFastest()` đua tốc độ nhiều provider nên thường trả lời trong vài giây.

**Lỗi "Anthropic API trả về lỗi (HTTP 400)" (nếu gặp lại):** nguyên nhân phổ biến nhất là biến môi trường `ANTHROPIC_MODEL` (nếu bạn có đặt) trỏ tới một model string không hợp lệ/không còn tồn tại — Anthropic từ chối request ngay ở trường `model`. Bản hiện tại đã đổi model mặc định về `claude-sonnet-5` và server sẽ trả kèm nội dung lỗi gốc từ Anthropic (vd `"model: xxx is not a valid model ID"`) ngay trong thông báo lỗi hiển thị trên giao diện, kể cả khi `NODE_ENV=production`, để dễ tự chẩn đoán mà không cần vào xem log Vercel. Nếu vẫn gặp 400 với nội dung lỗi khác, đọc đúng câu chữ Anthropic trả về (hiển thị trên giao diện) — nó luôn nêu rõ trường nào trong request không hợp lệ.

## 8. Đa mô hình AI (Claude + GPT + Gemini + tự động nhận diện thêm) — kiến trúc, tốc độ, thêm provider mới

### Kiến trúc — không có provider "chính", tự động nhận diện, tự động failover, tối ưu tốc độ

```
server/utils/anthropicClient.js       ← gọi Claude (Anthropic Messages API), tùy chọn (ANTHROPIC_API_KEY)
server/utils/openaiClient.js          ← gọi GPT (OpenAI Responses API — hỗ trợ web_search_preview), tùy chọn (OPENAI_API_KEY)
server/utils/geminiClient.js          ← gọi Gemini (Google Generative Language API — hỗ trợ google_search), tùy chọn (GEMINI_API_KEY)
server/utils/openaiCompatibleClient.js← client DÙNG CHUNG cho mọi API tương thích chuẩn OpenAI Chat
                                          Completions (Grok, DeepSeek, Mistral, Groq, OpenRouter...)
server/config/extraProviders.js       ← DANH SÁCH KHAI BÁO các provider bổ sung dùng client dùng
                                          chung ở trên — THÊM PROVIDER MỚI = SỬA FILE NÀY, không
                                          cần viết code, xem chi tiết ngay trong file (có ví dụ sẵn)
server/utils/aiProviders.js           ← "registry" GỘP 3 provider lõi + mọi provider trong
                                          extraProviders.js đã có khóa API trong .env:
                                          - getActiveProviders(): đọc lại .env ở MỖI request,
                                            không cache — thêm khóa API là có hiệu lực ngay
                                          - callFastest(providers, args): ĐUA TỐC ĐỘ — gọi đồng thời
                                            vài provider ngẫu nhiên, lấy kết quả về TRƯỚC TIÊN. Dùng
                                            cho chế độ Nhanh (ưu tiên tốc độ).
                                          - callWithFailover(providers, args): thử LẦN LƯỢT theo thứ
                                            tự ngẫu nhiên tới khi có 1 lượt thành công. Dùng cho lượt
                                            TỔNG HỢP ở chế độ Sâu (chỉ cần 1 kết quả chắc chắn).
server/routes/chat.js                 ← Chế độ Nhanh: callFastest() — đua tốc độ + model "nhanh".
                                          Chế độ Sâu: MỌI provider đang hoạt động giải 1 lượt song
                                          song (model đầy đủ, ưu tiên độ chính xác); lượt nào lỗi
                                          được failover sang provider khác; lượt TỔNG HỢP cuối dùng
                                          callWithFailover() — chọn ngẫu nhiên, KHÔNG cố định vào
                                          Claude hay bất kỳ provider nào.
```

**Bắt buộc phải cấu hình ít nhất 1 khóa API** trong số tất cả provider đã khai báo (lõi + bổ sung) — không có provider nào là "bắt buộc" cố định; nếu `.env` không có khóa nào, `/api/chat` trả lỗi rõ ràng thay vì âm thầm dùng 1 hãng mặc định.

Mọi client đều dùng chung một **chữ ký hàm**: `async ({system, messages, maxTokens, temperature, webSearch, fast, timeoutMs}) => text` — trong đó `messages` là mảng theo định dạng nội bộ của dự án (giống Anthropic: mỗi phần tử `{role, content}`, `content` là chuỗi hoặc mảng block `{type:'text',text}` / `{type:'image',source:{...}}`); `webSearch:true` bật tool tìm kiếm web tích hợp sẵn của hãng (chỉ 3 provider lõi hỗ trợ); `fast:true` chuyển sang model "nhanh" riêng của provider đó (nếu có khai báo); `timeoutMs` giới hạn thời gian chờ trước khi tự hủy. Nhờ chữ ký thống nhất, `aiProviders.js` và `chat.js` không cần biết chi tiết API của từng hãng.

### Tự động nhận diện thêm nhà cung cấp AI — KHÔNG cần sửa code

Với các hãng có API **tương thích chuẩn OpenAI Chat Completions** (áp dụng cho hầu hết các hãng AI phổ biến ngoài Anthropic/Google: **Grok/xAI, DeepSeek, Mistral, Groq, OpenRouter, Together, Fireworks...**), `server/config/extraProviders.js` đã khai báo sẵn 5 provider mẫu (Grok, DeepSeek, Mistral, Groq, OpenRouter). Để **bật** một trong số này:

```
# Trong .env — chỉ cần điền khóa, không sửa gì khác:
GROK_API_KEY=xai-xxxxxxxxxxxxxxxxxxxxxxxx
```

Xong — lần request kế tiếp, provider đó tự động xuất hiện trong `getActiveProviders()` và được đưa vào vòng xoay tua/đua tốc độ của cả chế độ Nhanh lẫn Sâu, không cần khởi động lại code hay sửa `aiProviders.js`/`chat.js`.

Muốn thêm **1 hãng chưa có sẵn** trong `extraProviders.js` (nhưng vẫn có API tương thích OpenAI)? Chỉ cần thêm 1 object vào mảng `EXTRA_PROVIDERS` trong file đó (copy khuôn 1 provider có sẵn, đổi `key`/`label`/`apiKeyEnv`/`baseURL`/`modelEnv`/`defaultModel`), rồi thêm biến môi trường tương ứng vào `.env` — vẫn **không cần viết code mới**.

Chỉ khi nào hãng đó dùng API **không tương thích OpenAI** (kiểu Anthropic hoặc Gemini, mỗi hãng một định dạng riêng) mới cần viết 1 file client riêng như hướng dẫn dưới đây.

### Đa dạng hoá: nhập NHIỀU API key + NHIỀU model cho CÙNG 1 nhà cung cấp

Mọi biến môi trường `*_API_KEY` (kể cả 3 provider lõi Claude/GPT/Gemini lẫn mọi provider bổ sung
trong `extraProviders.js`) và `*_MODEL`/`*_MODEL_FAST` giờ nhận NHIỀU giá trị, phân tách bằng dấu
phẩy hoặc xuống dòng — không cần sửa code:

```
# Ví dụ: 3 khóa Gemini free-tier khác nhau (né giới hạn hạn mức/phút của từng khóa) + 2 model
GEMINI_API_KEY=AIzaKhoa1,AIzaKhoa2,AIzaKhoa3
GEMINI_MODEL=gemini-3.6-flash,gemini-3.6-pro
```

Mỗi khóa API khai thêm trở thành **1 "provider ảo" riêng** trong vòng xoay ngẫu nhiên/đua tốc
độ/failover đã có sẵn (`getActiveProviders()` → `callWithFailover()`/`callFastest()`) — khóa nào
lỗi (hết hạn mức, sai, quá tải) tự động nhường sang khóa/hãng khác mà không cần biết đó là cùng 1
hãng; khung "Đối chiếu đa hướng" ở chế độ Sâu cũng coi mỗi khóa là 1 ứng viên độc lập nên càng
nhiều khóa/model càng có nhiều góc nhìn để đối chiếu. Ở mỗi lượt gọi, model dùng cho khóa đó được
**chọn ngẫu nhiên** trong danh sách model đã khai (chỉ khai 1 model thì luôn dùng đúng model đó —
không đổi hành vi cấu hình cũ). Nhãn hiển thị (label) tự thêm số thứ tự `#1`/`#2`... khi có từ 2
khóa trở lên để phân biệt, ví dụ `Claude #1 · 2 model`, `Claude #2 · 2 model`.

Áp dụng được cho **mọi** provider đã khai trong `server/utils/aiProviders.js` (`CORE_DEFS`) lẫn
`server/config/extraProviders.js` (`EXTRA_PROVIDERS`) — không phân biệt provider lõi hay bổ sung.

### Bật thêm GPT / Gemini (2 provider lõi còn lại)

Chỉ cần điền khóa API tương ứng vào `.env` (xem `.env.example`) — tương tự cách bật provider bổ sung ở trên, không cần sửa code:

```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxx
```

**Lưu ý chi phí/độ trễ:** ở chế độ Sâu, mỗi provider cấu hình thêm = thêm 1 lệnh gọi API tốn phí (chạy song song nên tổng thời gian ≈ thời gian của provider chậm nhất, không cộng dồn). Ở chế độ Nhanh, `callFastest()` chỉ đua tối đa 2 provider mỗi lần (không phải tất cả) nên chi phí luôn ở mức thấp và ổn định dù bạn cấu hình bao nhiêu provider — càng nhiều provider chỉ càng tăng độ tin cậy (failover) và cơ hội "trúng" provider nhanh trong mỗi lượt đua.

### Thêm một nhà cung cấp AI có API riêng biệt (không tương thích OpenAI)

1. Tạo `server/utils/<ten>Client.js`, copy khuôn của `anthropicClient.js` hoặc `geminiClient.js`,
   đổi URL endpoint + cách chuyển đổi `messages`/response cho đúng API của hãng đó, giữ nguyên
   chữ ký hàm `async ({system, messages, maxTokens, temperature, webSearch, fast, timeoutMs}) => text`
   (bỏ qua `webSearch`/`fast` nếu hãng đó không hỗ trợ tương ứng).
2. Trong `server/utils/aiProviders.js`, import client vừa tạo và thêm 1 object vào mảng
   `CORE_REGISTRY`, vd:
   ```js
   const { callGrok, isConfigured: grokConfigured, MODEL: GROK_MODEL } = require('./grokClient');
   // ... thêm vào CORE_REGISTRY:
   { key: 'grok', label: `Grok (${GROK_MODEL})`, configured: grokConfigured, supportsWebSearch: false, call: callGrok }
   ```
3. Thêm các biến môi trường tương ứng vào `.env.example` và `.env`.
4. Không cần sửa `chat.js` hay `promptBuilder.js` — cả hai đều xử lý theo số lượng provider động,
   đua tốc độ/chọn ngẫu nhiên và failover tự động mà không cần biết tên provider cụ thể.

## 9. Thêm tính năng mới trong tương lai

Nhờ tách `server/app.js` riêng khỏi phần khởi động server, việc thêm tính năng mới **không đòi hỏi động vào cấu hình Vercel** — chỉ cần code theo đúng khuôn Express bình thường:

**Thêm một API endpoint mới** (ví dụ: chấm điểm bài làm)
1. Tạo `server/routes/grade.js` theo khuôn của `chat.js`/`generate.js` (dùng `express.Router()`).
2. Trong `server/app.js`, thêm:
   ```js
   const gradeRoutes = require('./routes/grade');
   app.use('/api/grade', chatLimiter, gradeRoutes); // dùng lại rate-limiter có sẵn, hoặc tạo limiter riêng trong security.js
   ```
3. Deploy lại (`git push`) — Vercel tự build lại, route mới hoạt động ngay tại `/api/grade` mà **không cần sửa `vercel.json`** (vì rewrite `/api/:path*` đã bắt mọi đường dẫn con của `/api`).

**Thêm giao diện/chức năng phía frontend:** chỉ cần sửa `public/index.html`, `public/js/app.js`, `public/css/styles.css` như một trang tĩnh thông thường — không ảnh hưởng gì đến backend.

**Lưu ý khi thêm tính năng MỚI cần lưu trạng thái:** bản thân serverless function không giữ trạng thái giữa các lần gọi (đây là điểm khác biệt lớn nhất so với chạy server truyền thống). Ứng dụng hiện không có tài khoản người dùng/database — mọi dữ liệu cá nhân chỉ lưu ở `localStorage` phía trình duyệt; nếu sau này cần lưu trạng thái phía server, phải tự thêm 1 lớp lưu trữ (database/KV...) tương ứng.

**Test trước khi deploy:** chạy `npm run dev` ở local để thử nhanh; muốn test đúng môi trường serverless như trên Vercel thật, cài `vercel` CLI (`npm i -g vercel`) rồi chạy `vercel dev` trong thư mục project.

## 10. Đề xuất ôn tập (khung bên phải màn hình)

Mỗi khi gửi câu hỏi, khung nổi **"📚 Đề xuất ôn tập"** tự bật lên ở góc phải màn hình (góc dưới trên di động), liệt kê các trang chứa **bài tập/đề thi/đề ôn tập** liên quan đúng chủ đề vừa hỏi — chạy **song song, không chặn** luồng giải bài chính.

### Cách hoạt động

- **Backend** (`server/routes/recommend.js` + `callClaudeWebSearch()` trong `server/utils/anthropicClient.js`): dùng công cụ tìm kiếm web thật của Claude (`web_search`), ưu tiên tìm trên các trang tài liệu tiếng Việt uy tín (`studocu.vn`, `loigiaihay.com`, `vietjack.com`, `tailieumoi.vn`, `hoc247.net`, `download.vn`, `thuvienhoclieu.com`, `hocmai.vn`, `doctailieu.com`...). Model được yêu cầu trả lời bằng 1 khối JSON chọn ra tối đa 6 link phù hợp nhất kèm ghi chú ngắn.
- **Chống bịa link (quan trọng)**: server đối chiếu MỌI url trong JSON model trả về với danh sách URL **thật** lấy trực tiếp từ kết quả `web_search_tool_result` của chính lượt gọi đó — url nào không khớp bị loại bỏ ngay, không bao giờ hiển thị 1 URL do model "tự nhớ"/tự bịa mà chưa được xác minh qua tìm kiếm thật.
- **Dự phòng khi không tìm được** (chưa cấu hình `ANTHROPIC_API_KEY`, timeout, lỗi mạng...): tự chuyển sang link tìm kiếm Google giới hạn theo từng trang uy tín (`site:studocu.vn <câu hỏi>`...) — luôn hợp lệ, không có rủi ro link chết.
- **Chỉ xin đề, không cần giải**: `isExamOnlyRequest()` trong `public/js/app.js` nhận diện các câu hỏi kiểu "cho mình xin đề ôn tập chương này", "tìm đề kiểm tra..." (KHÔNG kèm nội dung 1 bài toán cụ thể) — gặp trường hợp này, `sendMessage()` bỏ qua hoàn toàn việc gọi AI giải bài (`/api/chat`), chỉ hiện khung đề xuất kèm 1 dòng thông báo ngắn. Đây là **suy đoán dựa trên mẫu câu (heuristic)**, không phải phân loại bằng AI — có thể chỉnh sửa/thêm mẫu câu trực tiếp trong hàm này nếu bỏ sót trường hợp nào.

### Tùy chỉnh

- **Thêm/bớt trang ưu tiên**: sửa mảng `PRIORITY_SITES` trong `server/routes/recommend.js` (dùng chung cho cả lời nhắc tìm kiếm lẫn link dự phòng).
- **Giới hạn tần suất**: biến `RATE_LIMIT_RECOMMEND` trong `.env` (mặc định 40 lượt/15 phút/IP, tách riêng khỏi `RATE_LIMIT_CHAT`).
- **Tắt hẳn tính năng này**: xóa/không mount `app.use('/api/recommend', ...)` trong `server/app.js`, và bỏ lời gọi `scheduleRecommend(query)` trong `sendMessage()` (`public/js/app.js`) — phần UI (`#recommendPanel`) sẽ không bao giờ được kích hoạt nếu không có gì gọi nó.
