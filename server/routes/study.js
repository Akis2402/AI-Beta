'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, callWithFailover } = require('../utils/aiProviders');
const { validateSelfCheckBody, validateSimilarBody } = require('../utils/validators');
const { calculateAdaptiveBudget } = require('../utils/adaptiveBudget');
const { parseJSONSafe } = require('../utils/jsonSafe');
const { createRequestDeadline } = require('../utils/requestDeadline');
const { createRequestLogger } = require('../utils/logger');
const {
  deterministicSelfCheck, buildSelfCheckPrompt,
  buildSimilarPrompt, tryDeterministicSimilarLinearEquation
} = require('../utils/studyTasks');

const STUDY_TIMEOUT_MS = Number(process.env.STUDY_TIMEOUT_MS) || 18000;

// ---------- Mục 3A: POST /api/study/self-check — KHÔNG đi qua buildChatSystemPrompt/pipeline giải bài ----------
router.post('/self-check', async (req, res, next) => {
  const reqLogger = createRequestLogger({ route: '/api/study/self-check', method: 'POST' });
  reqLogger.log({ stage: 'request_start' });
  res.on('finish', () => reqLogger.end({ statusCode: res.statusCode }));
  try {
    const input = validateSelfCheckBody(req.body);

    // ---------- Tầng 1 (mục 3A): deterministic — 0 lệnh gọi AI nếu kết luận được chắc chắn ----------
    const det = deterministicSelfCheck(input);
    if (det) {
      return res.json({ ...det, errors: [], hint: det.note, aiCalls: 0, tier: 'deterministic' });
    }

    // ---------- Tầng 2: targeted AI verification — output JSON ngắn, KHÔNG giải lại toàn bộ ----------
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error('Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào.');
      err.status = 500;
      throw err;
    }
    const { system, user } = buildSelfCheckPrompt(input);
    const deadline = createRequestDeadline(STUDY_TIMEOUT_MS + 5000);
    // Mục 3D: deepThinking=false, crossCheck=false tuyệt đối — không đi qua candidate/reconcile.
    const budget = calculateAdaptiveBudget({
      stage: 'selfCheck', problemText: input.problem, remainingMs: deadline.remaining()
    });
    const { text } = await callWithFailover(
      activeProviders,
      { system, messages: [{ role: 'user', content: user }], maxTokens: budget.target, timeoutMs: STUDY_TIMEOUT_MS, requestId: reqLogger.requestId },
      { deadline }
    );
    const parsed = parseJSONSafe(text) || {};
    res.json({
      status: parsed.status || 'incomplete',
      score: Number.isFinite(parsed.score) ? parsed.score : 0,
      errors: Array.isArray(parsed.errors) ? parsed.errors.slice(0, 8) : [],
      hint: typeof parsed.hint === 'string' ? parsed.hint : '',
      aiCalls: 1,
      tier: 'ai'
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Mục 3C: POST /api/study/similar — CHỈ sinh 1 bài tương tự, KHÔNG giải bài đó ----------
router.post('/similar', async (req, res, next) => {
  const reqLogger = createRequestLogger({ route: '/api/study/similar', method: 'POST' });
  reqLogger.log({ stage: 'request_start' });
  res.on('finish', () => reqLogger.end({ statusCode: res.statusCode }));
  try {
    const input = validateSimilarBody(req.body);

    // ---------- Similarity generator deterministic (mục 3C) — nhận diện dạng bài đơn giản ----------
    if (input.difficulty === 'same') {
      const template = tryDeterministicSimilarLinearEquation(input.problem);
      if (template) return res.json({ ...template, aiCalls: 0, tier: 'deterministic' });
    }

    // ---------- Bài phức tạp hơn: gọi AI, nhưng CHỈ sinh đề — không giải (mục 3C) ----------
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error('Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào.');
      err.status = 500;
      throw err;
    }
    const { system, user } = buildSimilarPrompt(input);
    const deadline = createRequestDeadline(STUDY_TIMEOUT_MS + 5000);
    const budget = calculateAdaptiveBudget({
      stage: 'similar', problemText: input.problem, remainingMs: deadline.remaining()
    });
    const { text } = await callWithFailover(
      activeProviders,
      { system, messages: [{ role: 'user', content: user }], maxTokens: budget.target, timeoutMs: STUDY_TIMEOUT_MS, requestId: reqLogger.requestId },
      { deadline }
    );
    const parsed = parseJSONSafe(text) || {};
    if (!parsed.problem) {
      const err = new Error('Không tạo được bài tương tự hợp lệ, vui lòng thử lại.');
      err.status = 502;
      throw err;
    }
    res.json({
      problem: String(parsed.problem),
      given: typeof parsed.given === 'string' ? parsed.given : '',
      question: typeof parsed.question === 'string' ? parsed.question : '',
      difficulty: ['easier', 'same', 'harder'].includes(parsed.difficulty) ? parsed.difficulty : input.difficulty,
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      aiCalls: 1,
      tier: 'ai'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
