# BÁO CÁO SỬA LỖI — RESUMABLE STREAM + FAIR ROTATION + SEMANTIC COMPRESSION

Lỗi được xử lý: **"Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành."**

---

## PHẦN A — ROOT CAUSE (4 nguyên nhân XẾP CHUỖI, không phải 1 lỗi đơn lẻ)

### 1. `streamWithFailover()` trả về `text: ''` khi provider chết GIỮA stream
`server/utils/aiProviders.js` (bản cũ):
```js
if (committed) { return { text: '', provider: p, tried, partialError: err }; }
```
- `text` RỖNG — toàn bộ phần đã sinh chỉ còn tồn tại trong biến `full` của closure `onDelta` ở chat.js.
- `partialError` **KHÔNG CÓ NƠI NÀO ĐỌC**: caller chỉ `destructure { provider, finishReason }`.
- Nhánh `catch` **không gọi** `filter.flush()`/`safetyFilter.flush()` → đoạn text còn đệm trong bộ
  lọc `<thinking>` bị mất trắng cùng lỗi.

### 2. Không tồn tại tín hiệu `interrupted` trong toàn hệ thống
Vì bị ngắt giữa stream, provider **chưa kịp** gửi `message_delta`/`stop_reason` → `finishReason = null`
→ `completenessCheck` phải ĐOÁN bằng heuristic hình thức. Nếu chỗ cắt tình cờ rơi sau dấu chấm hoặc
một con số (rất dễ xảy ra giữa lời giải toán), `ensClosedProperly()` trả `true` → **COMPLETE**.

Bằng chứng chạy được (test S4 trong `test/resumable-failover.test.js`):
```
cùng một đoạn text bị cắt:
  không có cờ interrupted -> status "COMPLETE"   ← giao câu trả lời BỊ CẮT, hệ thống tưởng đã xong
  có cờ interrupted       -> HARD (stream_interrupted)
```

### 3. Target vừa chết KHÔNG bị `markFailure()` → vòng lặp chết
Nhánh partial thoát ra mà không phân loại lỗi → không cooldown ở bất kỳ tầng nào (key/model/target)
→ target vẫn `eligible` → `orderByRotation()` có thể trao lại **ĐÚNG target vừa chết** cho lượt
continuation → chết y hệt → lặp tới khi cạn reserve → phát sự kiện `error` với **chính thông điệp
người dùng báo**.

### 4. Reserve batch được cấp một cách "mù"
`tokenEconomy.shouldUseReserve()` cấp `50% × reserve` (≈15% tổng budget), **không biết phần còn
thiếu dài bao nhiêu**. Câu trả lời bị ngắt ở 40% cần ~60% → lượt tiếp nối lại bị
`finish_reason=length` → sinh HARD mới → tiêu lô tiếp → cạn reserve **dù deadline còn dư rất nhiều**.

### Phát hiện thêm trong quá trình audit
- **PHẦN K — rotation không công bằng:** `orderByRotation()` giữ cursor theo *signature của tập
  eligible*. Mỗi lần một target vào/ra cooldown, signature đổi → `rotationCursor = 0` → **T1 lại
  được ưu tiên**. Đúng điều PHẦN K cấm ("Khi T2 quay lại: KHÔNG reset cursor về T1").
- **PHẦN J — telemetry chết:** đường streaming gọi `markSuccess(p)` **không kèm latency**, nên
  telemetry không bao giờ học được gì từ code path chạy nhiều nhất. `THROUGHPUT_TOKENS_PER_SEC = 60`
  áp cứng cho mọi provider.
- **UX nghiêm trọng:** `public/js/app.js` coi sự kiện `error` là **ném lỗi và xoá sạch preview** →
  90% lời giải dài đã hiển thị bị xoá, thay bằng đúng 1 dòng lỗi. Đây là thứ người dùng NHÌN THẤY.
- `tePlan.dedupedContexts` được tính rồi **không dùng** (dead optimization). Giữ nguyên có chủ ý:
  dedupe contexts sẽ đổi chỉ số citation `[n]` → phá `citationValidator`. Ghi vào "vấn đề còn tồn tại".

---

## PHẦN B — FIX: STREAM CHECKPOINT + RESUMABLE FAILOVER

### File mới `server/utils/streamSession.js`
Checkpoint DUY NHẤT cho 1 lượt trả lời, đủ mọi field PHẦN B: `accumulatedText`, `currentProvider`,
`currentTarget`, `finishReason`, `interrupted`, `continuationCount`, `resumeCount`, `attempts`,
`outputTokens`, `inputTokens`, `compressedInputTokens`, `totalBudget`, `recoveryBudget`,
`recoveryUsed`, `continuationTokens`, `deadlineRemaining()`, `triedTargets`, `failedTargets`,
`stage`, `recoveryReason`.

Chi tiết quan trọng: `absorbAttempt()` **XOÁ** cờ `interrupted` khi lượt sau chạy trọn vẹn. Nếu giữ
cờ cũ thì completeness sẽ HARD **mãi mãi** và vòng recovery không bao giờ dừng được.

### File mới `server/utils/resumableStream.js`
```
INITIAL ──(ok, COMPLETE)──────────────────────────────► DONE
   │
   ├──(lỗi TRƯỚC delta đầu)──► streamWithFailover tự đổi target  (CASE 1)
   │
   ├──(lỗi SAU delta: interrupted)─► RESUME       ─┐
   │                                               ├─► đánh giá lại ─► DONE / tiếp
   └──(finish_reason=length / cấu trúc hỏng)──────► CONTINUATION ─┘
```
`runResumableStream()` + `runResumableNonStream()` thay **4 vòng `while` gần-trùng-nhau** trong
chat.js (2 streaming + 2 JSON). Chính sự trùng lặp đó là môi trường sinh bug: sửa 1 nhánh thì 3
nhánh còn lại vẫn giữ lỗi.

### `aiProviders.streamWithFailover()` — hợp đồng mới
```js
// CASE 2: lỗi SAU khi đã gửi delta
try { filter.flush(); safetyFilter.flush(); } catch (e) {}   // lấy nốt phần còn đệm
const cls = markFailure(p, err);                             // ← MẤU CHỐT: cooldown target chết
return { text: attemptText, provider: p, tried, interrupted: true,
         partialError: err, errorScope: cls.scope, finishReason: null };
```
`markFailure` ở đây là điều kiện để RESUME chắc chắn đi sang target KHÁC.
`finishReason: null` — bị ngắt thì tuyệt đối không giả định `'stop'`.

---

## PHẦN C — COMPLETENESS CHECK

`stream_interrupted` được thêm vào `HARD_REASONS`, đánh giá **TRƯỚC** mọi heuristic và **không thể**
bị `finishReason === 'stop'` ghi đè (điều kiện `hard.length === 0` tự loại vì nó nằm trong HARD).

Phân loại giữ nguyên: HARD (interrupted, length, unclosed latex/fence/drawing, cut_mid_step,
invalid_citation, invalid_drawing_json, drawing_canonical_mismatch) buộc recovery; SOFT
(missing_coverage, missing_conclusion) **không bao giờ** kích hoạt recovery.

### Trạng thái cuối: mô hình 3 trạng thái (`runtimeState.classifyFinalOutcome`)
| state | điều kiện |
|---|---|
| `COMPLETED` | COMPLETE thật, hoặc chỉ còn SOFT warning |
| `PARTIAL` | còn HARD **nhưng** đã hết đường recovery **và** text ≥ 400 ký tự |
| `FAILED` | INVALID/rỗng/quá ngắn |

`COMPLETED` **không bao giờ** được gắn cho response còn HARD (cam kết cũ giữ 100%). Nhưng `PARTIAL`
**giao phần đã sinh** kèm nhãn + `incompleteReasons` thay vì xoá sạch — tôn trọng nguyên tắc ưu tiên
#1 "Không mất phần câu trả lời đã sinh". `public/js/app.js` render banner `.partial-warning`.

---

## PHẦN D/E/F — SEMANTIC COMPRESSION (file mới `server/utils/contextCompressor.js`)

- **Importance scoring 5 mức:** CRITICAL / HIGH / MEDIUM / LOW / REDUNDANT.
- **Tiers:** TIER 0 IMMUTABLE_CORE → TIER 4 REDUNDANT_META. Tier là *vị trí*, importance là *giá
  trị nội dung* — lấy mức **bảo vệ cao hơn** của cả hai (lượt rất cũ chứa drawing state vẫn được đối
  xử như ACTIVE STATE).
- **Budget-aware:** dưới `COMPRESSION_MIN_TOKENS = 1200` → **không nén**. Target thích ứng
  10% / 15% / 20% theo tổng tải input.
- **Budget-capped:** nén theo thứ tự **giá trị thấp nhất trước**, **dừng ngay khi đạt mục tiêu** —
  không nén quá mức cần thiết.
- **Quality gate + rollback:** so tập "hạt ngữ nghĩa" (numbers, latex, assignments, citations,
  drawingIds, labels, units, unfinished) trước/sau. Thiếu bất kỳ hạt nào → **rollback item đó** về
  mức lossless, không rollback toàn bộ.
- **Chống nén 2 lần:** đóng dấu `compressedFrom = fingerprint(original)`; gặp lại → bỏ qua.
- **PHẦN E:** compression **chỉ** tối ưu phía INPUT. Output budget vẫn tính hoàn toàn theo độ phức
  tạp bài + deadline. Đã kiểm chứng bằng đo: `output target before=3480 after=3480`.

---

## PHẦN G/H — COMPACT CONTINUATION + SMART RESUME PROMPT

`buildMinimalContinuationContext()` trong `continuation.js`:
- **LUÔN GIỮ:** đề bài gốc (nguyên trong `messages`), sườn đánh số/heading, **mọi** dòng chứa dữ
  liệu, **mọi** khối vẽ nguyên vẹn, và **TAIL nguyên văn** quanh điểm cắt.
- **KHÔNG GỬI LẠI:** prose diễn giải đã hoàn thành (thay bằng 1 marker cố định).
- `findSafeCutIndex()` không bao giờ cắt giữa ```` ``` ````, `$$`, hàng bảng; không có newline thì
  lùi về ranh giới câu, rồi tới khoảng trắng — **không bao giờ cắt giữa từ/số**.
- `createSeamDedupe()` giữ 240 ký tự đầu của lượt tiếp nối, cắt phần chồng lặp với đuôi text cũ
  **trước khi** phát ra SSE → người dùng không thấy đoạn lặp.
- `joinContinuation()` nối liền khi cắt giữa từ (`"nửa tích hai cạ" + "nh góc vuông"`), thay vì
  chèn `\n` như bản cũ.

---

## PHẦN I/J — TOKEN ECONOMY + ADAPTIVE BUDGET

- `shouldUseReserve(..., { deficitTokens })` + `estimateRemainingWork()`: lô reserve được cấp
  **đúng mức cần hoàn thành** (+20% đệm), vẫn bị `Math.min(remaining, …)` chặn nên **không bao giờ
  vượt reserve**.
- `makeRecoveryResolver()` trong chat.js **trừ** `reserveState.used` ngay khi cấp — thiếu bước này
  thì reserve không bao giờ cạn và vòng recovery chạy tới safety cap ở mọi request lỗi.
- File mới `server/utils/throughputStats.js`: EMA throughput theo **model** rồi **provider**, bound
  `[12, 220]` tok/s, bỏ mẫu < 80 token / < 400 ms (phần lớn là TTFT, không đại diện).
  `timeRemainingBudget(remainingMs, tokensPerSec)`: `110 tok/s → 3080`, `30 tok/s → 840`,
  mặc định `→ 1680`.

---

## PHẦN K/L — ROTATION FAIRNESS

Thay cursor-theo-signature bằng **LRU trên bộ đếm đơn điệu toàn cục** (`selectionSeq` +
`selectionState` theo `targetId`). Trạng thái gắn theo TARGET ID, không theo tập eligible.

Đo được (test S14/S15):
```
4 target khoẻ:        R1→T1, R2→T2, R3→T3, R4→T4, R5→T1   ✓
T1 xong, T2 cooldown: R2 → T3 (KHÔNG phải T1)             ✓  ← bản cũ trả về T1
T2 quay lại:          có mốc cũ nhất → được ưu tiên bù     ✓
```
`noteSelection()` được gọi từ **cả** `markSuccess` và `markFailure` — nếu chỉ ghi khi thành công,
target lỗi sẽ mãi có mốc "cũ nhất" và luôn được thử đầu tiên ngay khi hết cooldown.

---

## PHẦN T — ĐO THẬT (`node scripts/measure-tokens.js`)

### Input token lượt đầu
| scenario | before | after | giảm | mục tiêu |
|---|---|---|---|---|
| MICRO (không history) | 1712 | 1712 | **0.0%** | cố ý không nén |
| SHORT | 2106 | 1972 | 6.4% | 10% |
| STANDARD | 7693 | 7085 | 7.9% | 15% |
| COMPLEX | 5009 | 4200 | **16.2%** | 15% |
| VERY_COMPLEX | 12315 | 9831 | **20.2%** | 20% |

### Input token lượt continuation (nguồn lãng phí lớn nhất của bản cũ)
| answer đã sinh | before | after | giảm |
|---|---|---|---|
| 10 bước | 816 | 757 | 7.2% |
| 25 bước | 1608 | 1113 | 30.8% |
| 50 bước | 2934 | 1712 | 41.6% |
| 80 bước | 4527 | 2434 | **46.2%** |

Trung bình continuation: **−31.4%**. STANDARD chỉ đạt 7.9% vì history ở đó chỉ ~1000/7693 token —
**nén an toàn được bấy nhiêu thì lấy bấy nhiêu**, đúng yêu cầu "chỉ nén an toàn được 7% => giữ 7%,
KHÔNG ép 20%".

---

## 2 LỖI THẬT CHỈ LỘ RA KHI ĐO, KHÔNG PHẢI KHI ĐỌC CODE

**Lỗi 1 — regex khớp nhầm prose tiếng Việt.**
`\b(vậy|kết luận|…)\b` khớp "như vậy", "vì vậy", "vậy nên" — xuất hiện dày đặc trong văn diễn giải
→ **gần như mọi dòng prose bị coi là dòng dữ liệu** → compaction đo được **0%**.
Sửa: neo đầu dòng `^\s*(vậy|…)`. Kết quả: **0% → 46.2%**.
Cùng họ lỗi đã xảy ra với danh sách đơn vị đo 1 ký tự `\b(cm|m|g|A|N|V|W|J)\b` (khớp nhầm từ tiếng
Việt) — sửa thành `\d\s*(cm|mm|…)`: đơn vị chỉ mang dữ liệu khi gắn với số.

**Lỗi 2 — resume prompt quá dài gây regression.**
Bản nháp ~200 token khiến continuation của câu trả lời NGẮN **tốn nhiều hơn bản cũ 25%** — phần tiết
kiệm từ nén priorText không bù được chi phí prompt cố định. Viết cô đặc, giữ đủ 6 chỉ thị PHẦN H:
**−25% → +7.2%**.

---

## PHẦN U — TEST ĐÃ CHẠY

| lệnh | kết quả |
|---|---|
| `npm ci` | OK |
| `npm test` (36 file) | **RESULT: PASS** |
| `test/token-compression.test.js` (mới, PHẦN R) | **22/22** |
| `test/resumable-failover.test.js` (mới, PHẦN S) | **42/42** |
| `npm run build` | OK |
| `npm run check-static-assets` | **60/60** |
| `npm run smoke-test` | **13/13** |

### Test mới bao phủ
A→B→C, A→B→C→D, interrupted vs length, unclosed latex/fence/drawing, SOFT không trigger recovery,
continuation > 2 lượt, rotation fairness R1..R5, cooldown không reset cursor, key/model cooldown,
invalid_request không retry, client disconnect, abort signal, PARTIAL không cache, compact
continuation, seam dedupe, giữ variables/drawing state, deadline chung, safety cap, adaptive
continuation budget, telemetry đủ field + không lộ key/nội dung, throughput per-provider,
non-stream A→B→C, sentinel reserveExhausted, và 19 case compression của PHẦN R.

### 5 assertion đã CẬP NHẬT (không phải "sửa test cho pass")
1-3. `test/hard-budget-cap.test.js` — grep *vị trí cũ* của 4 vòng continuation trùng lặp. Chuyển
   sang `resumableStream.js` và **làm mạnh hơn**: thêm assertion "chat.js KHÔNG còn vòng lặp
   continuation viết tay nào" (bản cũ chỉ đếm guard, không cấm sinh bản thứ 5) + assertion mới
   "reserve ĐƯỢC TRỪ ngay khi cấp".
4. `test/model-routing-wiring.test.js` — `fast: useFastModel` giảm 4→3 vì initial + continuation
   nay dùng CHUNG 1 `buildArgs()` factory. Giữ nguyên assertion phủ định (chống hồi quy thật) và
   **thêm** assertion `buildArgs` phải truyền `fast: useFastModel`.
5. `scripts/smoke-test.js` — SPA fallback. **Đã FAIL từ TRƯỚC bản refactor này** (đã verify bằng
   cách giải nén bản gốc và chạy riêng: cũng 404). `server/app.js` giải thích rõ fallback bị **xoá
   có chủ ý** vì từng trả HTML cho request xin `*.js` → "Unexpected token '<'". Assertion cũ sai so
   với thiết kế; sửa thành kiểm tra điều quan trọng thật: path lạ **không được trả HTML**.

---

## PHẦN V — TỰ REVIEW (17 câu)

1. **Root cause?** 4 nguyên nhân xếp chuỗi: `text:''` + `partialError` bị bỏ qua → không có tín hiệu
   `interrupted` → target chết không cooldown nên bị gọi lại → reserve batch mù quá nhỏ. Xem PHẦN A.
2. **Partial stream resume thế nào?** `streamWithFailover` trả text đã sinh + `interrupted:true` +
   `markFailure`; `runResumableStream` giữ checkpoint, gửi ngữ cảnh tối thiểu, rotation trao target
   khác, seam dedupe cắt phần lặp.
3. **A→B→C→D được không?** Được — test S6 (A→B→C) và S7 (A→B→C→D) pass, với **mọi tổ hợp lý do**
   (interrupted và length trộn lẫn — test S34).
4. **Continuation có lặp text?** Không: prompt cấm rõ + `createSeamDedupe` cắt phần chồng ở tầng vận
   chuyển trước khi phát SSE (test S24) + `joinContinuation` không đứt từ (test S27).
5. **Input token giảm bao nhiêu?** Lượt đầu: 0% (bài nhẹ) → 20.2% (ngữ cảnh rất dư). Continuation:
   trung bình 31.4%, cao nhất 46.2%.
6. **Compression giảm ở đâu?** Prose diễn giải đã hoàn thành trong history cũ; boilerplate/dòng chỉ
   thị lặp trong system prompt; khoảng trắng/dòng trang trí; và lớn nhất là priorText của lượt
   continuation.
7. **Có mất thông tin quan trọng?** Không — 19 test PHẦN R kiểm tra từng loại (đề bài, constraints,
   variables, equations, numbers, unfinished section, drawing canonical state, citations). Test 18
   còn chứng minh compression **không sinh text mới** (mọi dòng còn lại là dòng gốc hoặc marker).
8. **Quality gate thế nào?** So tập 8 loại hạt ngữ nghĩa trước/sau; thiếu bất kỳ hạt nào →
   rollback đúng item đó về mức lossless.
9. **Output budget có bị giảm vì compression?** Không. Đo trực tiếp: `before=3480 after=3480`
   (test R15 + `measure-tokens.js`).
10. **Rotation có fair?** Có — LRU, R1..R4 mỗi target đúng 1 lần, R5 quay lại T1 (test S14).
11. **Cooldown có reset rotation?** Không — trạng thái gắn theo `targetId`, không theo tập eligible
    (test S15 assert `notStrictEqual('T1')`).
12. **Long answer có đủ recovery budget?** Có — `estimateRemainingWork()` cấp theo phần còn thiếu
    thật, `extendReserveIfTruncated()` mở rộng động khi deadline còn dư (test S32/S34).
13. **Client disconnect có dừng?** Có — `isDisconnected()` + `signal.aborted` kiểm tra ở mỗi vòng
    (test S19/S20: đúng 1 lệnh gọi provider).
14. **Partial có bị cache?** Không — `if (!tePlan.cacheBypassed && !outcome.partial)` ở cả 4 nhánh.
15. **Test mới?** `token-compression.test.js` (22) + `resumable-failover.test.js` (42) +
    `scripts/measure-tokens.js`.
16. **npm test PASS?** Có — `RESULT: PASS`, 36 file.
17. **Regression còn lại?** Xem mục dưới — có, và tôi nêu thẳng.

---

## VÒNG 2 — ĐÃ XỬ LÝ 4 VẤN ĐỀ CÒN TỒN ĐỌNG

### Vấn đề #1 — `dedupedContexts` là dead code → ĐÃ BẬT (file mới `server/utils/citationIndex.js`)

**Vì sao trước đây không bật được:** số `[n]` không phải danh tính, nó là **vị trí trong mảng**,
được sinh độc lập ở 3 nơi: `promptBuilder` (`i + 1`), `citationValidator` (`1 <= n <= length`),
`app.js` (`contexts[n - 1]` của **mảng phía client**). Bỏ 1 context trùng là mọi số sau nó dịch →
prompt nói `[5]` là đoạn X, client vẽ đoạn Y.

**Cách sửa:** tách danh tính khỏi vị trí. `citeNo` gán **một lần** cho cả request; bản trùng được gộp
và citeNo của nó thành **alias** (model trích số cũ vẫn resolve đúng, không bị coi là bịa). Tập
citeNo hợp lệ có thể **không liên tục** (`[1],[2],[4]`) — nên:
- `promptBuilder` in `c.citeNo`, và `citeNoRangeLabel()` liệt kê **đúng tập số** khi không liên tục
  (nói "đánh số [1]-[6]" khi thiếu [3] là **mời model bịa** ra [3]);
- `citationValidator` validate theo **TẬP** + alias, không theo khoảng;
- server trả `citationMap` trong payload, client dùng nó thay vì `i + 1`, và **lưu lại** trên message
  để render từ lịch sử vẫn đúng đoạn.

### Vấn đề #2 — STANDARD chỉ 7.9% → nén nội dung đoạn trích (`compressSourceExcerpts`)

Nguồn dư thật nằm ở excerpt: các đoạn cắt từ cùng 1 tài liệu mang header/footer trang **lặp y nguyên**
("Tài liệu ôn tập — Trường…", "Bản quyền tổ Toán…"). Chỉ loại dòng xuất hiện ở **≥2 excerpt cùng
tài liệu**, **≤80 ký tự**, **không chứa dữ liệu**. Không bao giờ loại cả một đoạn (đó là việc của
citationIndex). Excerpt `truncated` chỉ nén lossless. Mọi excerpt qua quality gate.

Cố ý **không** nén sâu system prompt: đó là chỉ thị an toàn/định dạng, nén sai là mất chất lượng.

| số đoạn nguồn | before | after | giảm | đoạn gộp | dòng boilerplate bỏ |
|---|---|---|---|---|---|
| 4 | 293 | 125 | **57.3%** | 1 | 6 |
| 8 | 593 | 256 | **56.8%** | 2 | 12 |
| 16 | 1179 | 469 | **60.2%** | 5 | 22 |

### Vấn đề #3 — rotation in-memory per-instance → store dùng chung (`rotationStore.js`)

Trên Vercel, 10 instance = 10 vòng xoay độc lập; tệ hơn, instance B không biết instance A vừa nhận
429 nên vẫn gọi vào đúng khóa đang rate-limit.

Mô hình: **HYDRATE** (đầu request) → quyết định **đồng bộ trong bộ nhớ** → **WRITE-BEHIND** (debounce,
fire-and-forget). `orderByRotation()` nằm giữa vòng failover nên bắt buộc đồng bộ, không thể await —
vì vậy nhất quán ở đây là **EVENTUAL, không tuyệt đối**: 2 request khởi động đồng thời ở 2 instance
vẫn có thể chọn trùng target. Đây là đánh đổi có chủ ý, ghi rõ trong code.

Merge theo hướng **thận trọng**: `cooldownUntil` lấy **max**, `invalid` là **OR**, LRU seq lấy **max**
— snapshot không bao giờ **xoá** được cooldown đang có ở local. Driver REST tương thích Upstash/Vercel
KV qua `fetch` có sẵn — **không thêm dependency**. Không cấu hình `ROTATION_STORE_URL/TOKEN` → chạy y
hệt bản cũ.

### Vấn đề #4 — `ký tự/3.2` → token counter tự hiệu chỉnh (`tokenCounter.js`)

**Không dùng thư viện tokenizer:** `tiktoken` chỉ đúng cho OpenAI; Anthropic/Google không có tokenizer
offline. Thêm 1-2MB bundle để vẫn sai 2/3 provider là đánh đổi tồi cho serverless.

**Thay vào đó — học từ số liệu thật:** mọi provider đều trả `usage` trong response. Đã thêm trích xuất
usage vào **cả 3 client** (Anthropic non-stream + `message_delta`, OpenAI-compatible, Gemini
`usageMetadata`), rồi đối chiếu (token thật) với (độ dài ký tự) để học `charsPerToken` theo từng
provider bằng EMA. `throughputStats` cũng ưu tiên token thật thay vì ước lượng.

Đo được: tiếng Việt hội tụ về **~2.4 ký tự/token**, không phải 3.2 — tức bản cũ ước lượng **thiếu ~25%**
cho nội dung tiếng Việt. Khi chưa đủ mẫu (`< 3`) → trả về **đúng 3.2 như cũ**, nên hành vi hiện tại và
mọi test không đổi cho tới khi có số liệu thật.

---

## KẾT QUẢ TEST (sau vòng 2)

| lệnh | kết quả |
|---|---|
| `npm test` (**37** file) | **RESULT: PASS** |
| `test/pending-issues.test.js` (mới) | **31/31** |
| `test/token-compression.test.js` | 22/22 |
| `test/resumable-failover.test.js` | 42/42 |
| `npm run build` / `check-static-assets` / `smoke-test` | OK / 60/60 / 13/13 |

---

## VÒNG 3 — ĐÃ ĐÓNG 8 TỒN ĐỌNG CỦA VÒNG 2

### #1 Rotation "eventual consistency" → FAIRNESS TUYỆT ĐỐI (atomic INCR)

Vòng 2 chỉ đạt eventual vì `orderByRotation()` là ĐỒNG BỘ (nằm giữa vòng failover) nên không await
được → mọi instance chỉ đọc snapshot cũ.

**Không** cố biến nó thành async (thay đổi đó lan ra toàn bộ call chain). Thay vào đó **đặt trước
"vé xoay"** ở đầu request — nơi đã async sẵn (`ensureProvidersReady`): store `INCR` một bộ đếm toàn
cục, trả về số nguyên **duy nhất trên toàn hệ thống**. `orderByRotation()` dùng số đó làm điểm bắt
đầu — vẫn đồng bộ nhưng đã mang thông tin toàn cục:

```
slot 1..8 -> T2 T3 T4 T1 T2 T3 T4 T1      (round-robin XÁC ĐỊNH)
```

Chi tiết dễ bỏ sót: danh sách eligible được **sắp theo id** trước khi chia slot. Nếu sắp theo thứ tự
tự nhiên của mảng, 2 instance có cấu hình khác nhau sẽ map **cùng 1 slot vào 2 target khác nhau** và
fairness lại vỡ. Có test riêng cho việc này (đảo mảng đầu vào → cùng kết quả).

Slot vẫn chỉ xoay trong tập **eligible**, nên cooldown luôn được tôn trọng. Store lỗi → slot `null` →
tự về LRU local.

### #2 "Chưa test với Upstash thật" → TEST DRIVER BẰNG MOCK HTTP SERVER (13/13)

Không có credential thì vẫn verify được **đúng cái đáng verify: giao thức**. `test/rotation-store-driver.test.js`
dựng HTTP server nói đúng phương ngữ REST của Upstash/Vercel KV (`GET /get/<key>`,
`POST /set/<key>/EX/<ttl>`, `GET /incr/<key>`, Bearer auth) rồi chạy **driver thật** vào nó.

Bắt được đúng loại lỗi mà "đọc code rồi tin" bỏ sót: sai path/method, thiếu `Authorization`, parse sai
`{"result":…}`, không tôn trọng timeout, INCR không nguyên tử. Gồm cả: 500 → không throw; token sai →
401 → trả null; store treo 2.5s → bị `AbortController` cắt ở 1.5s; JSON hỏng → không throw;
20 lượt `INCR` đồng thời → **20 số khác nhau**.

### #3 `charsPerToken` chưa theo loại nội dung → HIỆU CHỈNH THEO LỚP

Trong cùng 1 provider, tỷ lệ ký tự/token phụ thuộc rất mạnh vào loại nội dung. Gộp một EMA làm sai
**cả hai chiều**: response nặng công thức bị đánh giá **thiếu** token (dễ vỡ giới hạn), văn xuôi bị
đánh giá **thừa** (cắt sớm vô cớ).

`classifyContent()` phân 3 lớp theo mật độ ký hiệu (`prose` <5%, `mixed` 5-12%, `symbolic` ≥12%).
Khoá hiệu chỉnh thành `${provider}::${class}`, ghi vào **cả** mức lớp và mức provider, fallback dần:
lớp → provider → hằng số. Đo được: prose **2.40**, symbolic **1.40** ký tự/token → cùng 1000 ký tự cho
**417 vs 715** token.

### #4 Calibration in-memory per-instance → CHIA SẺ QUA CÙNG SNAPSHOT

`rotationStore.registerExtra()` cho tokenCounter gắn dữ liệu hiệu chỉnh vào **đúng snapshot rotation**
— không phát sinh thêm lượt gọi mạng nào. Instance mới không phải "học lại" bằng 3 request đầu sau mỗi
cold start.

Merge có chủ đích: lấy bên **nhiều mẫu hơn**, không trung bình mù — trung bình giữa 1 mẫu nhiễu
(ratio 5.0) và 200 mẫu ổn định (2.4) sẽ phá cái ổn định. Có test cả 2 chiều.

### #5 Ngưỡng Jaccard 0.9 cứng → CẤU HÌNH ĐƯỢC, kẹp an toàn

`CITATION_NEAR_DUP_THRESHOLD` trong `.env`, luôn kẹp `[0.75, 1]` để không thể vô tình gộp bừa. Mặc
định giữ 0.9: gộp nguồn **không hoàn tác được** về mặt trích dẫn, nên thà bỏ sót vài đoạn trùng (chỉ
tốn token) hơn gộp nhầm 2 đoạn khác nội dung (câu trả lời dẫn nguồn sai).

### #6 Chưa test với API key thật → `npm run live-smoke`

Đây là thứ **duy nhất** tôi không thể chạy thay bạn. Nhưng tôi biến nó thành một lệnh, kiểm đúng
những gì **chỉ chạy thật mới lộ ra**:
1. Trường `usage` có tồn tại và tên field có đúng như code giả định (chỗ dễ sai nhất — các hãng đổi API
   không báo trước);
2. `finishReason` thật khi chạm maxTokens có map đúng sang `'length'`;
3. Throughput thật (tok/s) của từng model;
4. Tỷ lệ ký tự/token thật cho tiếng Việt **và** cho LaTeX (kiểm chứng con số 2.4 đo bằng mẫu giả);
5. Continuation **thật** xuyên provider: text stream khớp text cuối, và **không lặp câu** ở điểm nối.

Script tự đếm và in ước tính số lượt gọi trước khi chạy (~4 lượt/provider). `--quick` bỏ bài
continuation (tốn token nhất).

**Script này đã bắt được 1 lỗi thật ngay lần chạy đầu:** `setGlobalRotationSlot is not defined` —
import bị thiếu trong `aiProviders.js`. Không có nó thì lỗi này chỉ nổ ở production.

### #7 `estimateTokens` là xấp xỉ → đã tốt hơn hẳn, và nêu rõ giới hạn còn lại
Nay là ước lượng **được hiệu chỉnh bằng số liệu thật theo provider + loại nội dung**, thay vì một hằng
số. Vẫn không phải đếm chính xác từng token (chỉ tokenizer của chính hãng làm được), nhưng sai số đã
giảm từ "cố định ~25% cho tiếng Việt" xuống mức tự hội tụ theo dữ liệu thật.

### #8 `appendContinuationTurn` còn export → ĐÁNH DẤU `@deprecated` + test chống hồi quy
Có test khẳng định `chat.js` **không còn gọi** hàm cũ. Giữ lại chỉ để (a) tương thích test hiện có,
(b) làm baseline "before" cho `measure-tokens.js` so sánh trung thực.

---

## KẾT QUẢ TEST (sau vòng 3)

| lệnh | kết quả |
|---|---|
| `npm test` (**38** file) | **RESULT: PASS** |
| `test/pending-issues.test.js` | **44/44** |
| `test/rotation-store-driver.test.js` (mới) | **13/13** |
| `test/resumable-failover.test.js` | 42/42 |
| `test/token-compression.test.js` | 22/22 |
| `npm run build` / `check-static-assets` / `smoke-test` | OK / 60/60 / 13/13 |
| `npm run live-smoke` | cần API key thật — **bạn chạy** |

---

## GIỚI HẠN CÒN LẠI (bản chất, không phải việc chưa làm)

1. **`npm run live-smoke` phải do bạn chạy** — tôi không có khóa API của bạn. Đây là việc còn lại duy
   nhất và không ai khác làm được thay.
2. **Fairness tuyệt đối CHỈ khi bật rotation store.** Không cấu hình `ROTATION_STORE_URL/TOKEN` thì
   vẫn là LRU per-instance như bản gốc (đúng như thiết kế: không có store thì không thể có thứ tự toàn
   cục — đây là giới hạn vật lý, không phải thiếu sót code).
3. **Đếm token chính xác tuyệt đối là không thể offline** cho Anthropic/Google (không công bố
   tokenizer). Ước lượng hiệu chỉnh là mức tốt nhất đạt được mà không thêm dependency.
4. **Slot toàn cục tốn 1 lượt gọi store mỗi request** (~vài chục ms cùng khu vực). Đã dùng debounce cho
   write nhưng `INCR` thì bắt buộc phải đồng bộ với request — đó là giá của fairness tuyệt đối.
5. **Dedupe không gộp 2 đoạn diễn đạt khác nhau cùng nội dung** (ngưỡng 0.9) — cố ý, xem #5.

---

# NÂNG CẤP: Puter + Multi-conversation + 3D + i18n + Token optimization

## 1. Files added

```
public/js/scene3d.js                          PHẦN J-S: engine 3D mới (compact scene JSON + patch)
public/js/i18n/translations.js                PHẦN W/X: từ điển vi/en (~190 khoá mỗi ngôn ngữ)
public/js/i18n/languageStore.js               PHẦN T/U/V: nguồn ngôn ngữ trung tâm + persist
public/js/i18n/i18n.js                        PHẦN W/AF/AG: t(), tError(), applyStaticTranslations()
public/js/providers/puterAdapter.js           PHẦN A: adapter Puter.js (SDK js.puter.com/v2)
public/js/providers/providerRouter.js         PHẦN B/C: provider router + fallback
public/js/tasks/conversationTaskManager.js    PHẦN E-I: background task manager
test/upgrade-integration.test.js              PHẦN AT-AV: 50 assertion cho toàn bộ hạng mục mới
```

## 2. Files modified

```
public/index.html               nạp 7 file JS mới (đúng thứ tự phụ thuộc); 78 thuộc tính data-i18n
public/js/app.js                bỏ chatAbortController toàn cục -> task manager; snapshot settings
                                (language lock); scene3d/scenepatch parsing; 35 chuỗi -> t();
                                error code -> tError(); syncSendButtonForActiveConversation()
public/js/solid3d.js            export buildPrimitiveGeometryAndVertices cho scene3d tái dùng
public/css/styles.css           .scene3d-* (toolbar/canvas/fallback), .hist-generating-dot
server/utils/promptBuilder.js   LANGUAGE_RULE_STATIC + buildLanguageContract(); scene3d schema;
                                PROMPT_VERSION -> chat-prompt-v5
server/utils/drawingValidator.js validate scene3d/scenepatch
server/middleware/security.js   CSP: script-src + connect-src cho Puter (KHÔNG unsafe-inline/eval)
vercel.json                     CSP khớp helmet
scripts/build.js                fingerprint asset ở js/i18n, js/providers, js/tasks
test/subject-detection.test.js  cập nhật assertion PROMPT_VERSION theo bump
```

## 3-5. Puter architecture / Provider routing / Streaming

Puter.js là SDK CHẠY Ở TRÌNH DUYỆT, xác thực bằng phiên đăng nhập Puter của người dùng — KHÔNG
phải khoá API server-to-server như Anthropic/OpenAI/Gemini. Vì vậy Puter KHÔNG thể là execution
target gọi từ server; adapter chạy client-side và cắm vào vị trí "Puter" của Provider Router như
một nhánh thực thi riêng. Điều này TÔN TRỌNG yêu cầu "không hard-code Puter API key" (Puter không
phát hành loại khoá đó cho mục đích này).

Thứ tự: LUÔN thử provider hiện có trước (server đã có rotation/failover/token-economy/context
compression). Chỉ fallback Puter khi lỗi là "rotation đã cạn" (503/429/hết execution target), tối
đa 1 lần mỗi request. Abort do người dùng bấm Dừng KHÔNG kích hoạt fallback. Request có ảnh chỉ
fallback nếu model Puter xác nhận vision, ngược lại coi Puter là không khả dụng.

streamViaProviderRouter() trả cùng interface { onDelta, onStatus, signal } với apiPostStream() nên
tầng trên (render, task manager, resumable) không cần biết đang nói chuyện với provider nào.

## 6-9. Resumable / Multi-conversation / Concurrency / Persistence

Toàn bộ resumable/continuation phía server GIỮ NGUYÊN (không sửa) — chỉ đổi nơi gọi.

conversationTaskManager: registry theo conversationId, mỗi task có
{conversationId, requestId, status, provider, model, text, partial, startedAt, updatedAt,
completedAt, error, usage, requestLanguage, uiLanguageAtStart, answerLanguage, explanationLanguage}.
Concurrency limit CTM_MAX_CONCURRENT (mặc định 3), vượt -> queue. Mọi event mang conversationId +
requestId. attach/detach tách rời vòng đời task. BroadcastChannel + OWNER_TOKEN chống duplicate
đa tab. Task hoàn tất: giải phóng slot, xoá khỏi registry sau 30s, kết quả đã persist vào
conversation.

Chuyển chat: loadConversation() KHÔNG gọi abort ở bất kỳ đâu (có test khẳng định). Nút Dừng chỉ
abort task của conversation ĐANG XEM.

## 10-12. 3D architecture / Scene schema / Patch

```scene3d  {"v":1,"cam":[6,5,7],"objs":[{"t":"pt","p":[1,2,1],"l":"A"},...]}
```scenepatch {"v":1,"op":[["add","pt",{...}],["del","obj0"]]}
```
t: pt|line|seg|vec|plane|surf|axes|grid|cube|box|sphere|cylinder|cone|pyramid|prism
Renderer tự dựng geometry procedural (BoxGeometry/SphereGeometry/ArrowHelper/sampled
BufferGeometry) — AI KHÔNG gửi vertex list, KHÔNG sinh code Three.js. Khối rắn tái dùng
buildPrimitiveGeometryAndVertices() của solid3d.js. surf: z=f(x,y) sample với n giới hạn theo
quality tier. Quality high/medium/low tự chọn theo thiết bị (pixelRatio/antialias/surfaceN).
WebGL không khả dụng -> fallback mô tả text, KHÔNG làm AI request fail. Mọi tương tác
(orbit/zoom/pan/select/hover/reset/fit/fullscreen/axes/grid) là 0 AI request — có test khẳng định
scene3d.js không chứa fetch/apiPost.

solid3d.js GIỮ NGUYÊN — khối ```solid3d``` cũ hoạt động y như trước.

## 13-14. Token optimization / Prompt caching

Phần TĨNH (CORE_DIRECTIVE + LANGUAGE_RULE_STATIC + format rules + schema) nằm ở ĐẦU system prompt,
giống nhau giữa mọi request -> cache-friendly. Phần ĐỘNG chỉ là dòng contract ngắn (<220 ký tự) +
query + context. Từ điển i18n KHÔNG BAO GIỜ gửi cho model (có test khẳng định). Scene dùng patch
thay vì gửi lại full scene. tokenEconomy/contextCompressor/semanticCompression giữ nguyên.

LƯU Ý TRUNG THỰC: đây là cache-friendly STRUCTURING. Breakpoint `cache_control: ephemeral` của
Anthropic CHƯA được gắn vào anthropicClient.js (project gốc cũng chưa có) — xem mục "Chưa làm".

## 15-19. i18n / Language state / AI contract / Bug fix / Background isolation

languageStore = nguồn DUY NHẤT cho uiLanguage, persist localStorage, pub/sub -> UI rerender không
reload. Mọi text UI qua t()/data-i18n.

AI contract: `LANG=en ANSWER=en EXPLANATION=en UI=en` (nén) + static rule đã cache:
"Answer and step-by-step explanation MUST use the same language."

FIX BUG PHẦN Y: nguyên nhân gốc là chỉ thị cũ chỉ nói "trả lời bằng X" mà không liệt kê tường minh
rằng đáp án + từng bước + tiêu đề + DÒNG TIÊU ĐỀ BẢNG + kết luận phải CÙNG một ngôn ngữ, nên model
trả đáp số đúng ngôn ngữ yêu cầu nhưng giải thích theo ngôn ngữ đề bài / ngôn ngữ của prompt xung
quanh (vốn toàn tiếng Việt). Static rule nay liệt kê tường minh từng phần.

Language lock: settingsSnapshot = {...state.settings} chốt tại thời điểm bắt đầu request. Đổi
Settings giữa stream KHÔNG đổi ngôn ngữ task đang chạy. Fallback Puter và continuation kế thừa
đúng ngôn ngữ đã chốt. Lịch sử cũ KHÔNG bị dịch lại.

Schema key máy đọc (t/p/s/o/d/eq/r/n) giữ tiếng Anh; chỉ nhãn hiển thị "l" theo ngôn ngữ.

## 20-22. CSP / Mobile / Vercel

CSP: thêm https://js.puter.com (script-src) + https://api.puter.com (connect-src). KHÔNG có
unsafe-inline/unsafe-eval. Đã xác minh trên server thật:
  script-src 'self' https://js.puter.com
  connect-src 'self' https://api.puter.com https://js.puter.com
Mobile: quality tier tự giảm, surface resolution giảm, pixelRatio cap, touch orbit/pinch zoom.
Vercel: build pass, 17 asset fingerprint, header parity test pass.

## 23-25. Tests / Regression / Token comparison

npm test              39/39 file PASS (38 file gốc + 1 file mới)
upgrade-integration   50/50 assertion PASS
npm run build         PASS (17 asset)
check-static-assets   88/88 PASS
smoke-test            13/13 PASS (server thật)

Test mới tự phát hiện và đã sửa 4 lỗi thật, trong đó có: scene3d thiếu whitelist type khối rắn
(sphere/cylinder rơi vào nhánh fallback im lặng -> "hình biến mất" không rõ lý do).

Token: i18n thêm 1 dòng contract (<220 ký tự) mỗi request + 1 khối static rule nằm trong vùng
cache. Từ điển dịch (~190 khoá × 2 ngôn ngữ) hoàn toàn ở frontend, 0 token. Chưa đo được số token
thực tế trước/sau vì cần khoá API thật (`npm run measure-tokens`).

## CHƯA LÀM — cần biết trước khi deploy

1. `cache_control: ephemeral` chưa gắn vào anthropicClient.js (chỉ structuring, chưa có breakpoint).
2. Task manager chỉ bọc 2 luồng chính (approach/detail). Self-check, similar-problem, outline,
   mindmap vẫn chạy ngoài task manager.
3. CHƯA TEST TRÊN BROWSER THẬT: render Three.js, orbit/fullscreen, popup đăng nhập Puter,
   BroadcastChannel đa tab. Node không kiểm được các phần này — cần chạy thử thủ công.
4. Chưa đo token thực tế (cần khoá API thật).
