'use strict';

// Lớp mỏng gọi các hàm Postgres ai_* (xem supabase/migrations). Mọi logic atomic nằm TRONG database.

const sb = require('../supabase/client');
const { getConfig } = require('./config');

function cfg() { return getConfig().quota; }

async function reserve({ userId, requestId, kind, estimate }) {
  const q = cfg();
  return sb.rpc('ai_reserve', {
    p_user: userId,
    p_request_id: requestId,
    p_kind: kind,
    p_estimate: Math.max(1, Math.round(estimate)),
    p_default_limit: q.tokenLimit,
    p_cooldown_minutes: q.cooldownMinutes,
    p_max_concurrent: q.maxConcurrent,
    p_reservation_ttl_sec: q.reservationTtlSeconds,
    p_min_request: q.minRequestTokens
  });
}

async function settle({ userId, requestId, input, output, cached, total, provider, model }) {
  return sb.rpc('ai_settle', {
    p_user: userId,
    p_request_id: requestId,
    p_input: Math.round(input || 0),
    p_output: Math.round(output || 0),
    p_cached: Math.round(cached || 0),
    p_total: Math.round(total || 0),
    p_provider: provider || null,
    p_model: model || null,
    p_cooldown_minutes: cfg().cooldownMinutes
  });
}

async function release({ userId, requestId }) {
  return sb.rpc('ai_release', { p_user: userId, p_request_id: requestId });
}

async function status(userId) {
  return sb.rpc('ai_quota_status', { p_user: userId, p_default_limit: cfg().tokenLimit });
}

module.exports = { reserve, settle, release, status };
