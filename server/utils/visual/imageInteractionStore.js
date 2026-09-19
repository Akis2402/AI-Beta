'use strict';

// ============================================================================================
// IMAGE INTERACTION STORE — MULTI-TURN IMAGE EDITING STATE
// ============================================================================================
// Lưu trữ interaction state của các lần tạo ảnh gần nhất để hỗ trợ multi-turn image editing.
// Khi người dùng yêu cầu "sửa hình vừa tạo", "thay đổi màu sắc...", hệ thống sử dụng:
//   previous_interaction_id + edit instruction
// Thay vì phải upload lại toàn bộ bối cảnh và sinh lại từ đầu.

const MAX_INTERACTIONS = 100;
const INTERACTION_TTL_MS = 30 * 60 * 1000; // 30 phút

const store = new Map(); // id (hoặc visualId) -> ImageInteractionState

function cleanupExpired() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.expiresAt < now) store.delete(k);
  }
}

/**
 * Lưu trạng thái interaction cho hình ảnh vừa sinh.
 * @param {string} visualId
 * @param {{ interactionId: string, provider: string, model: string, imageAssetId?: string, prompt?: string }} state
 */
function rememberInteraction(visualId, state = {}) {
  if (!visualId || !state.interactionId) return;
  cleanupExpired();
  if (store.size >= MAX_INTERACTIONS) {
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }

  const now = Date.now();
  store.set(String(visualId), {
    visualId: String(visualId),
    interactionId: state.interactionId,
    provider: state.provider || 'gemini-image',
    model: state.model || 'gemini-3.1-flash-image',
    imageAssetId: state.imageAssetId || null,
    prompt: state.prompt || null,
    createdAt: now,
    expiresAt: now + INTERACTION_TTL_MS
  });
}

/**
 * Lấy trạng thái interaction để phục vụ edit.
 * @param {string} visualId
 * @returns {object|null}
 */
function getInteraction(visualId) {
  if (!visualId) return null;
  const state = store.get(String(visualId));
  if (!state) return null;
  if (state.expiresAt < Date.now()) {
    store.delete(String(visualId));
    return null;
  }
  return state;
}

/**
 * Lấy interaction gần đây nhất của một session/request nếu không có visualId cụ thể.
 */
function getLatestInteraction() {
  cleanupExpired();
  let latest = null;
  for (const item of store.values()) {
    if (!latest || item.createdAt > latest.createdAt) {
      latest = item;
    }
  }
  return latest;
}

function _clearForTest() {
  store.clear();
}

module.exports = {
  rememberInteraction,
  getInteraction,
  getLatestInteraction,
  _clearForTest
};
