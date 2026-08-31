'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, callWithFailover } = require('../utils/aiProviders');
const {
  buildPPTSystemPrompt, buildFlashcardSystemPrompt, buildOutlineSystemPrompt,
  buildMindmapSystemPrompt, MINDMAP_COLOR_KEYS
} = require('../utils/promptBuilder');
const { validateGenerateBody, validateOutlineBody } = require('../utils/validators');
// parseJSONSafe (nhiều lớp vá lỗi JSON của AI) đã tách sang server/utils/jsonSafe.js để dùng chung
// với server/routes/recommend.js (route đó giờ cũng cần AI trả JSON có cấu trúc — xem file đó).
const { parseJSONSafe } = require('../utils/jsonSafe');

router.post('/ppt-outline', async (req, res, next) => {
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
    const system = buildPPTSystemPrompt();
    // Dùng cùng cơ chế xoay tua/tự động chuyển provider (failover) như /api/chat — trước đây route
    // này gọi cứng callClaude() nên riêng tính năng "Xuất slide PPT" sẽ ngừng hoạt động hoàn toàn
    // mỗi khi Anthropic lỗi/hết hạn mức, dù các nhà cung cấp khác (GPT/Gemini/...) vẫn hoạt động
    // tốt — không có provider nào được ưu tiên cố định.
    // maxTokens trước đây (1400) quá thấp cho nội dung tiếng Việt nhiều slide — model dễ bị CẮT
    // NGANG giữa chừng trước khi kịp đóng xong JSON, khiến JSON luôn cụt và KHÔNG cách nào vá được
    // bằng cú pháp (dù đã có lớp closeTruncatedJSON ở trên, càng ít bị cắt càng giữ được nhiều nội
    // dung thật hơn là phần bù đắp cụt lủn) — tăng lên mức đủ rộng rãi cho ~10-12 slide.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành slide:\n\n' + content }],
      maxTokens: 2800
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

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
    // Tương tự /ppt-outline — tăng maxTokens để giảm nguy cơ bị cắt ngang giữa chừng (8 thẻ đầy đủ
    // câu hỏi + câu trả lời cho nội dung tiếng Việt dễ vượt quá 1200 token cũ).
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
// thư viện docx.js (xem public/js/app.js: buildAndDownloadOutlineDocx), giữ đúng kiến trúc "server
// không lưu/tạo file nhị phân" đã áp dụng cho /ppt-outline và /flashcards ở trên.
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
    // Đề cương có bài tập cần nhiều token hơn (4 mức độ x nhiều bài) nên tăng maxTokens khi bật.
    // Cả 2 mức đều tăng thêm đáng kể so với trước (1800/3200) — đề cương có tới 6 "sections", mỗi
    // section nhiều định nghĩa/công thức, rất dễ vượt ngưỡng cũ và bị cắt ngang giữa chừng.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành đề cương:\n\n' + content }],
      maxTokens: includeExercises ? 4500 : 2800
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
