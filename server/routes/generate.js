'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, callWithFailover } = require('../utils/aiProviders');
const {
  buildFlashcardSystemPrompt, buildOutlineSystemPrompt,
  buildMindmapSystemPrompt, MINDMAP_COLOR_KEYS
} = require('../utils/promptBuilder');
const { validateGenerateBody, validateOutlineBody } = require('../utils/validators');
// parseJSONSafe (nhiều lớp vá lỗi JSON của AI) đã tách sang server/utils/jsonSafe.js để dùng chung
// với server/routes/recommend.js (route đó giờ cũng cần AI trả JSON có cấu trúc — xem file đó).
const { parseJSONSafe } = require('../utils/jsonSafe');

router.post('/flashcards', async (req, res, next) => {
  try {
    const { content } = validateGenerateBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildFlashcardSystemPrompt();
    // Tương tự — trước đây route này cũng gọi cứng callClaude(), giờ dùng chung failover đa provider.
    // Tăng maxTokens để giảm nguy cơ bị cắt ngang giữa chừng (8 thẻ đầy đủ câu hỏi + câu trả lời cho
    // nội dung tiếng Việt dễ vượt quá 1200 token cũ).
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần tạo flashcard:\n\n' + content }],
      maxTokens: 2000
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

// POST /api/generate/outline — soạn dữ liệu đề cương (định nghĩa + công thức quan trọng, tùy chọn
// kèm bài tập chia mức độ). Server CHỈ trả JSON có cấu trúc; client tự dựng file .docx thật bằng
// thư viện docx.js (xem public/js/app.js: buildOutlineDocxBlob), giữ đúng kiến trúc "server
// không lưu/tạo file nhị phân" đã áp dụng cho /flashcards ở trên. Chỉ được gọi khi người dùng CHỦ
// ĐỘNG yêu cầu soạn đề cương ngay trong khung chat (xem isOutlineRequest/handleOutlineOnlyTurn ở
// app.js) — không còn nút bấm nào tự động tạo file này dưới mỗi câu trả lời.
router.post('/outline', async (req, res, next) => {
  try {
    const { content, includeExercises } = validateOutlineBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildOutlineSystemPrompt(includeExercises);
    // Tăng thêm lần nữa theo yêu cầu (trước đây 1800/3200 rồi 2800/4500, rồi 6500/4200) — đề cương
    // .docx có tới 6 "sections", mỗi section nhiều định nghĩa/công thức, bản có kèm bài tập (4 mức
    // độ x nhiều bài) càng cần rộng rãi hơn để không bị cắt ngang giữa chừng.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành đề cương:\n\n' + content }],
      maxTokens: includeExercises ? 8000 : 5500
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

// Dọn nhẹ 1 node mindmap trước khi trả về client: giới hạn độ sâu (tối đa 3 cấp dưới gốc), giới hạn
// số nhánh/con ở mỗi cấp (phòng model trả dư), ép "color" về đúng 1 giá trị trong danh sách cho phép
// (xoay vòng theo thứ tự nhánh nếu model bịa màu ngoài danh sách/bỏ trống) — vẽ mindmap ở client dựa
// hoàn toàn vào các giá trị này nên cần chắc chắn hợp lệ, không thể để lỗi JSON tự do làm vỡ layout.
function sanitizeMindmapNode(node, depth, branchIdx) {
  if (!node || typeof node !== 'object') return null;
  const label = String(node.label || '').trim().slice(0, 80);
  if (!label) return null;
  const clean = { label };
  if (depth === 1) {
    clean.color = MINDMAP_COLOR_KEYS.includes(node.color)
      ? node.color
      : MINDMAP_COLOR_KEYS[branchIdx % MINDMAP_COLOR_KEYS.length];
  }
  if (depth < 3 && Array.isArray(node.children)) {
    const maxChildren = depth === 0 ? 7 : depth === 1 ? 5 : 4;
    clean.children = node.children
      .slice(0, maxChildren)
      .map((c, i) => sanitizeMindmapNode(c, depth + 1, depth === 0 ? i : branchIdx))
      .filter(Boolean);
  }
  return clean;
}

router.post('/mindmap', async (req, res, next) => {
  try {
    const { content } = validateGenerateBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildMindmapSystemPrompt();
    // Tăng maxTokens (từ 1600) cùng lý do với 3 endpoint trên — tối đa 7 nhánh x 5 con x 4 cháu dễ
    // vượt ngưỡng cũ với nội dung tiếng Việt.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành sơ đồ tư duy (mindmap):\n\n' + content }],
      maxTokens: 2400
    });
    const raw = parseJSONSafe(text);
    const title = String(raw.title || 'Sơ đồ tư duy').trim().slice(0, 60);
    const branches = Array.isArray(raw.branches)
      ? raw.branches.slice(0, 7).map((b, i) => sanitizeMindmapNode(b, 1, i)).filter(Boolean)
      : [];
    if (!branches.length) {
      const err = new Error('AI không tạo được sơ đồ tư duy từ nội dung này, vui lòng thử lại.');
      err.status = 502;
      throw err;
    }
    res.json({ title, branches });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
