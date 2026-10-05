# AWAIT-AUDIT — `server/routes/chat.js`

Khoá kiểm tra bởi `test/await-audit.test.js` (W1): **số dòng chứa `await ` trong `chat.js` phải bằng số dòng của bảng dưới**.
Thêm một `await` mới vào `chat.js` thì phải thêm một dòng vào bảng và ghi rõ nó có bắt buộc tuần tự hay không.

> **Ghi chú nguồn gốc:** file này không có sẵn trong bản `tro-giai-ai-v6_23` (test W1 báo ENOENT khi chạy `npm test` local) và
> đã có lần biến mất khỏi thư mục gốc sau khi được tạo lại. **File phải nằm đúng ở thư mục gốc dự án** (cạnh `package.json`) —
> test đọc đúng đường dẫn đó; nếu bạn dọn file `.md` ở gốc, đừng xoá file này. Nên commit vào git.
> Bảng được dựng lại từ mã hiện tại và đã đối chiếu tự động: 28 hàng khớp đúng 28 dòng `await` của `chat.js`; các dòng #5, #9, #11 đã
> đọc lại ngữ cảnh. Cột "Phân loại" là đánh giá theo đọc mã, **chưa đo bằng trace thời gian thật** — chủ dự án nên rà lại.
> Số dòng chỉ mang tính tham chiếu (test chỉ đếm số hàng, không kiểm số dòng).

Phân loại:
- **BẮT BUỘC TUẦN TỰ** — kết quả dùng ngay cho bước sau, hoặc là điểm chặn (backpressure / dedupe / ngân sách).
- **ĐÃ SONG SONG** — bản thân hàm được await đã gộp các I/O chạy song song bên trong (xem test W2).
- **CÓ THỂ TỐI ƯU** — không phụ thuộc dữ liệu vào bước kế; chỉ giữ tuần tự để bảo toàn thứ tự/ghi nhận.

| # | Dòng | Biểu thức | Phân loại | Lý do |
|---|------|-----------|-----------|-------|
| 1 | 137 | `await callWithFailover(` (maybeRepairApproach) | BẮT BUỘC TUẦN TỰ | Bản sửa approach phải xong mới trả text; đúng 1 lượt, có try/catch |
| 2 | 244 | `await runResumableNonStream({` | BẮT BUỘC TUẦN TỰ | Sinh câu trả lời non-stream, kết quả là đầu vào của mọi bước sau |
| 3 | 398 | `await callWithFailover(` | BẮT BUỘC TUẦN TỰ | Lượt gọi provider chính của helper; failover nội bộ dùng deadline chung |
| 4 | 432 | `await visualSystem.runVisualPipeline(opts)` | BẮT BUỘC TUẦN TỰ | Cần `finalAnswer` đã hoàn chỉnh để dựng hình; chỉ approach/image_only mới sinh |
| 5 | 438 | `await visualSystem.stateStore.saveVisualState(` | CÓ THỂ TỐI ƯU | Ghi trạng thái hình cho Detail dùng lại; lỗi đã được nuốt (try/catch) nên không ảnh hưởng response. Chạy nền được nếu chấp nhận state có thể mất khi instance serverless bị thu hồi sớm |
| 6 | 650 | `await aiJobStore.getJob(clientRequestId)` | BẮT BUỘC TUẦN TỰ | Dedupe/khôi phục job theo requestId phải biết trước khi bắt đầu việc nặng |
| 7 | 712 | `await globalWorkerPool.defaultPool.acquire({` | BẮT BUỘC TUẦN TỰ | Backpressure: không chạy việc AI khi chưa có slot |
| 8 | 779 | `await ensureProvidersReady()` | ĐÃ SONG SONG | `hydrate` + `reserveRotationSlot` chạy song song (~1 RTT), lỗi được nuốt có kiểm soát |
| 9 | 1353 | `await visualSystem.stateStore.loadVisualState(visualKey)` | BẮT BUỘC TUẦN TỰ | Detail phải biết Approach đã có hình chưa trước khi quyết định không sinh mới |
| 10 | 1441 | `await tokenEconomy.globalCache.getAsync('L1', ...)` | BẮT BUỘC TUẦN TỰ | Cache hit rút ngắn toàn bộ luồng; phải biết trước khi gọi provider |
| 11 | 1516 | `? await (async () => {` | BẮT BUỘC TUẦN TỰ | Chỉ khi bật tường minh `IMAGE_CAPTION_MODEL=1` (mặc định caption là deterministic, không có await); caption là đầu vào của bước tạo hình, phải qua cửa admit ngân sách trước |
| 12 | 1562 | `await runVisualsFor({` | BẮT BUỘC TUẦN TỰ | Chạy hình sau khi text xong (cần `finalAnswer`) |
| 13 | 1580 | `await runVisualsFor({ ...imageVisualBase, ...` | BẮT BUỘC TUẦN TỰ | Nhánh image_only: chờ caption rồi mới tạo hình |
| 14 | 1619 | `await gatherCrossCheckCandidates(activeProviders, {` | BẮT BUỘC TUẦN TỰ | Ứng viên cross-check là đầu vào của reconcile (song song hoá nằm bên trong hàm) |
| 15 | 1702 | `await runResumableStream({` | BẮT BUỘC TUẦN TỰ | Reconcile stream: chính là câu trả lời gửi về client |
| 16 | 1800 | `await runVisualsFor({` | BẮT BUỘC TUẦN TỰ | Hình sau reconcile, cần text cuối |
| 17 | 1839 | `await runResumableStream({` | BẮT BUỘC TUẦN TỰ | Nhánh stream trực tiếp: câu trả lời gửi về client |
| 18 | 1911 | `full = await maybeRepairApproach({` | BẮT BUỘC TUẦN TỰ | Kiểm tra/sửa approach trước khi chốt `full`; tối đa 1 lượt |
| 19 | 1933 | `await runVisualsFor({` | BẮT BUỘC TUẦN TỰ | Hình cho nhánh stream trực tiếp, sau khi text chốt |
| 20 | 1987 | `await gatherCrossCheckCandidates(activeProviders, {` | BẮT BUỘC TUẦN TỰ | Nhánh JSON: ứng viên cross-check cho reconcile |
| 21 | 2028 | `await callWithFailover(` | BẮT BUỘC TUẦN TỰ | Lượt reconcile/initial của nhánh JSON |
| 22 | 2042 | `await ensureCompleteNonStream(` | BẮT BUỘC TUẦN TỰ | Đảm bảo hoàn chỉnh (continuation deficit-aware) trước khi trả |
| 23 | 2080 | `await runVisualsFor({` | BẮT BUỘC TUẦN TỰ | Hình cho nhánh JSON sau reconcile |
| 24 | 2117 | `await directCaller(` | BẮT BUỘC TUẦN TỰ | Lượt gọi trực tiếp của nhánh JSON không cross-check |
| 25 | 2141 | `await ensureCompleteNonStream(` | BẮT BUỘC TUẦN TỰ | Hoàn chỉnh câu trả lời direct-JSON |
| 26 | 2162 | `text = await maybeRepairApproach({` | BẮT BUỘC TUẦN TỰ | Sửa approach direct-JSON, tối đa 1 lượt |
| 27 | 2169 | `await runVisualsFor({` | BẮT BUỘC TUẦN TỰ | Hình cho direct-JSON sau khi text chốt |
| 28 | 2218 | `await aiJobStore.getJob(requestId)` | BẮT BUỘC TUẦN TỰ | Route `GET /api/chat/jobs/:requestId` trả đúng trạng thái job |

Tổng: 28 await. Ứng viên tối ưu đáng đo trước (cần trace trước khi đổi): #5 (`saveVisualState`) có thể chạy nền nếu chấp nhận rủi ro mất state khi instance bị thu hồi sớm.
