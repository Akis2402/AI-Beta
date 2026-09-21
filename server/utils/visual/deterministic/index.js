'use strict';

// ============================================================================================
// DETERMINISTIC SVG ENGINE — điểm vào duy nhất: câu hỏi -> dữ kiện có cấu trúc -> VALIDATE -> SVG.
// 0 token, 0 mạng, 0 lệnh gọi image model. KHÔNG BAO GIỜ nhờ LLM viết SVG: code render trực tiếp.
//   tryRender(question, subject) -> {status:'rendered'|'contradiction'|'not_deterministic', ...}
// Cache: specHash của dữ kiện đã chuẩn hoá (cùng dữ kiện = cùng SVG, không dựng lại).
// ============================================================================================

const K = require('./svgKit');
const U = require('./factUtils');
const geometry = require('./geometry');
const physics = require('./physics');
const chemistry = require('./chemistry');

const ENGINE_VERSION = 'svg-v1';
const CACHE_MAX = 300;
const cache = new Map(); // specHash -> artifact (LRU thô: xoá phần tử cũ nhất)
const stats = { renders: 0, cacheHits: 0, contradictions: 0, unsafe: 0 };

function cacheGet(k) { if (!cache.has(k)) return null; const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; }
function cacheSet(k, v) { cache.set(k, v); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

// Mô tả dễ hiểu (tiếng Việt) cho mã mâu thuẫn — hiển thị cho người dùng thay vì mã kỹ thuật.
const HUMAN = {
  'geometry_contradiction:pythagoras': 'các cạnh đã cho không thoả định lí Pythagore của tam giác vuông',
  'geometry_contradiction:triangle_inequality': 'độ dài ba cạnh không thoả bất đẳng thức tam giác',
  'geometry_contradiction:leg_not_shorter_than_hypotenuse': 'cạnh góc vuông không thể dài hơn hoặc bằng cạnh huyền',
  'geometry_contradiction:equilateral_sides_differ': 'tam giác đều nhưng các cạnh đã cho khác nhau',
  'geometry_contradiction:equilateral_angle_not_60': 'tam giác đều phải có mọi góc bằng 60°',
  'geometry_contradiction:isosceles_legs_differ': 'tam giác cân nhưng hai cạnh bên đã cho khác nhau',
  'geometry_contradiction:isosceles_base_too_long': 'cạnh đáy của tam giác cân phải nhỏ hơn hai lần cạnh bên',
  'geometry_contradiction:angle_sum': 'tổng các góc của tam giác phải bằng 180°',
  'geometry_contradiction:angle_range': 'số đo góc nằm ngoài khoảng cho phép',
  'geometry_contradiction:angle_vs_sides': 'số đo góc không khớp với độ dài các cạnh đã cho',
  'geometry_contradiction:ssa_no_solution': 'với dữ kiện cạnh–cạnh–góc đã cho, tam giác không tồn tại',
  'geometry_contradiction:degenerate_triangle': 'ba điểm thẳng hàng, không tạo thành tam giác',
  'geometry_contradiction:radius_not_positive': 'bán kính phải lớn hơn 0'
};
function humanize(detail) { return HUMAN[detail] || String(detail).replace(/^geometry_contradiction:/, '').replace(/_/g, ' '); }

/** Mã lỗi nghĩa là "engine chưa hỗ trợ" chứ KHÔNG phải "dữ kiện đề bài mâu thuẫn" -> rơi xuống nhánh khác, không báo mâu thuẫn. */
const OUT_OF_SCOPE_CODES = new Set(['unsupported_atomic_number', 'unknown_element', 'element_unknown', 'unsupported_element', 'molecule_not_supported', 'invalid_atomic_number', 'unknown_kind', 'chemistry_layout_required']);
const allOutOfScope = (errors) => Array.isArray(errors) && errors.length > 0 && errors.every((e) => OUT_OF_SCOPE_CODES.has(e.code));

const SUBJECT_ORDER = { math: ['math'], physics: ['physics'], chemistry: ['chemistry'] };
const DEFAULT_ORDER = ['chemistry', 'physics', 'math']; // môn chưa rõ: thử lần lượt (extractor nào cũng đòi từ khoá miền)

function supportedSubject(s) { return s === 'math' || s === 'physics' || s === 'chemistry'; }

function extractFor(domain, text) {
  if (domain === 'math') {
    const g = geometry.extractGeometry(text);
    if (!g) return null;
    if (g.error) return { domain, category: `geometry_${g.kind || 'shape'}`, error: { code: g.error, detail: g.detail || humanize(g.error) } };
    return { domain, category: `geometry_${g.shape}`, spec: g };
  }
  if (domain === 'physics') {
    const p = physics.extractPhysics(text);
    if (!p) return null;
    if (p.error) return { domain, category: `physics_${p.kind}`, error: { code: p.error, detail: p.detail } };
    return { domain, category: `physics_${p.kind}`, spec: p };
  }
  if (domain === 'chemistry') {
    const c = chemistry.extractChemistry(text);
    if (!c) return null;
    return { domain, category: `chemistry_${c.kind}`, spec: c };
  }
  return null;
}

function renderFor(ext) {
  if (ext.domain === 'math') { const r = geometry.renderGeometry(ext.spec); return { svg: r.svg, title: r.title, desc: r.desc, data: ext.spec }; }
  if (ext.domain === 'physics') { const r = physics.renderPhysics(ext.spec); return { svg: r.svg, title: r.title, desc: r.desc, data: ext.spec }; }
  const b = chemistry.buildChemistry(ext.spec);
  if (!b.ok) { const e = new Error('chemistry_validation_failed'); e.code = 'chemistry_validation_failed'; e.errors = b.errors; throw e; }
  return { svg: b.svg, title: b.title, desc: b.desc, data: b.data, category: b.category };
}

/**
 * tryRender() — thử dựng SVG tất định từ đề bài.
 * @param {string} question
 * @param {string} [subject] 'math'|'physics'|'chemistry'|'general'|...
 * @param {{supplementalText?:string}} [opts] văn bản phụ (vd. đầu approach) — CHỈ dùng khi đề chưa đủ dữ kiện.
 * @returns {{status:'rendered', domain, category, svg, title, desc, specHash, data, cacheHit, confidence, unlabeled}
 *   | {status:'contradiction', domain, category, errors:Array<{code,detail}>}
 *   | {status:'not_deterministic', reason:string}}
 */
function tryRender(question, subject, opts = {}) {
  const q = String(question || '');
  if (!q.trim()) return { status: 'not_deterministic', reason: 'empty_question' };
  const order = SUBJECT_ORDER[subject] || DEFAULT_ORDER;
  const sources = [q];
  if (opts.supplementalText) sources.push(`${q}\n${String(opts.supplementalText).slice(0, 1500)}`);
  for (const text of sources) {
    for (const domain of order) {
      let ext;
      try { ext = extractFor(domain, text); } catch (e) { ext = null; }
      if (!ext) continue;
      if (ext.error) { stats.contradictions += 1; return { status: 'contradiction', domain, category: ext.category, errors: [ext.error] }; }
      if (ext.domain === 'chemistry' && ext.spec.error) { stats.contradictions += 1; return { status: 'contradiction', domain, category: ext.category, errors: [ext.spec.error] }; }
      const hash = K.specHash({ domain, category: ext.category, spec: ext.spec }, ENGINE_VERSION);
      const hit = cacheGet(hash);
      if (hit) { stats.cacheHits += 1; return { ...hit, cacheHit: true }; }
      let out;
      try { out = renderFor(ext); } catch (e) {
        if (e && e.code === 'chemistry_validation_failed' && allOutOfScope(e.errors)) { continue; }
        if (e && (e.code === 'chemistry_validation_failed')) { stats.contradictions += 1; return { status: 'contradiction', domain, category: ext.category, errors: e.errors || [{ code: e.code, detail: e.message }] }; }
        if (e && e.code === 'physics_not_renderable') { continue; }
        continue; // renderer không dựng được từ dữ kiện này -> coi như không tất định (KHÔNG vẽ bừa)
      }
      try { K.assertSafeSvg(out.svg); } catch (e) { stats.unsafe += 1; return { status: 'not_deterministic', reason: `unsafe_svg:${(e.errors || []).join(',')}` }; }
      stats.renders += 1;
      const artifact = {
        status: 'rendered', domain, category: out.category || ext.category, svg: out.svg, title: out.title, desc: out.desc, specHash: hash,
        data: out.data, cacheHit: false, confidence: ext.spec.unlabeled ? 0.75 : 0.95, unlabeled: !!ext.spec.unlabeled
      };
      cacheSet(hash, artifact);
      return artifact;
    }
  }
  return { status: 'not_deterministic', reason: 'no_structured_facts' };
}

/** Dựng SVG từ DỮ LIỆU CÓ CẤU TRÚC (vd. AI extraction) — cùng validator, cùng renderer. */
function renderStructured(kind, spec) {
  if (kind === 'molecule' || kind === 'atom') {
    const b = chemistry.buildChemistry(kind === 'molecule' ? { kind: 'structured', molecule: spec } : { kind: 'atom', facts: spec });
    if (!b.ok) return { status: 'contradiction', domain: 'chemistry', category: `chemistry_${kind}`, errors: b.errors };
    K.assertSafeSvg(b.svg);
    return { status: 'rendered', domain: 'chemistry', category: b.category, svg: b.svg, title: b.title, desc: b.desc, specHash: K.specHash({ kind, spec }, ENGINE_VERSION), data: b.data, cacheHit: false, confidence: 0.98 };
  }
  return { status: 'not_deterministic', reason: 'unsupported_structured_kind' };
}

function clearCache() { cache.clear(); }
function engineStats() { return { ...stats, cacheSize: cache.size, version: ENGINE_VERSION }; }

module.exports = { tryRender, renderStructured, supportedSubject, clearCache, engineStats, ENGINE_VERSION, svgKit: K, factUtils: U, geometry, physics, chemistry };
