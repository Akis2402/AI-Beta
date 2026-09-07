'use strict';

// ---------- DRAWING CONSISTENCY / VALIDATION (mục X) ----------
// Sau khi sinh ra khối ```shape/solid3d/plot, phải validate CẤU TRÚC trước khi coi response là
// COMPLETE — JSON hỏng, point reference không tồn tại, id trùng, hay type không hợp lệ đều khiến
// public/js/geo2d-engine.js hoặc solid3d.js không vẽ được (hình "biến mất" mà không rõ vì sao).
// Đây là validate CẤU TRÚC (JSON hợp lệ, tham chiếu tồn tại) — KHÔNG validate đúng/sai TOÁN HỌC của
// toạ độ (việc đó do constraint engine phía trình duyệt tự giải khi dùng dạng "program").

const SHAPE_SIMPLE_TYPES = new Set(['polygon', 'circle', 'segment', 'points']);
const SOLID3D_PRIMITIVE_TYPES = new Set(['cuboid', 'cube', 'box', 'pyramid', 'prism', 'cone', 'cylinder', 'sphere']);
// Mục 6A/6B/6F: composable — "transform" bọc 1 node con, "boolean" ghép base+tool bằng 1 phép toán
// tập hợp, "group" gom nhiều node độc lập. SOLID3D_TYPES giữ nguyên tên export cũ (dùng ở nơi khác)
// nhưng nay là UNION của primitive + composable, để không phá vỡ chỗ nào đang import tên này.
const SOLID3D_COMPOSABLE_TYPES = new Set(['transform', 'boolean', 'group']);
const SOLID3D_TYPES = new Set([...SOLID3D_PRIMITIVE_TYPES, ...SOLID3D_COMPOSABLE_TYPES]);
const SOLID3D_BOOLEAN_OPS = new Set(['subtract', 'union', 'intersect']);
const MAX_SOLID3D_DEPTH = 6; // mục 6F: chặn recursion quá sâu / object quá lớn
const PROGRAM_OPS = new Set([
  'free', 'midpoint', 'foot', 'circumcenter', 'incenter', 'centroid', 'orthocenter', 'reflect',
  'intersectLines', 'intersectLineCircle', 'intersectCircles', 'pointOnLine', 'pointOnCircle',
  'diametricOpposite', 'angleBisectorFoot', 'rotate', 'tangentPoint'
]);

/** Trích mọi khối ```shape/solid3d/plot ... ``` (đã đóng) khỏi 1 văn bản. */
function extractDrawBlocks(text) {
  const blocks = [];
  const re = /```(shape|solid3d|plot)\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    blocks.push({ kind: m[1], raw: m[2].trim(), index: m.index });
  }
  return blocks;
}

function validatePlotBlock(json) {
  const errors = [];
  if (!Array.isArray(json.expressions) || !json.expressions.length) errors.push('plot.expressions phải là mảng không rỗng');
  if (json.expressions && json.expressions.length > 4) errors.push('plot.expressions vượt quá 4 biểu thức cho phép');
  if (!Array.isArray(json.xrange) || json.xrange.length !== 2) errors.push('plot.xrange phải là mảng 2 phần tử [min,max]');
  return errors;
}

function validatePointsExistInProgram(program) {
  const errors = [];
  const ids = new Set();
  const dupIds = new Set();
  (program.points || []).forEach((p) => {
    if (!p || typeof p.id !== 'string') { errors.push('có điểm trong "points" thiếu "id"'); return; }
    if (ids.has(p.id)) dupIds.add(p.id); else ids.add(p.id);
    if (p.op !== 'free' && !PROGRAM_OPS.has(p.op)) errors.push(`điểm "${p.id}" dùng op không hợp lệ: ${p.op}`);
  });
  if (dupIds.size) errors.push(`trùng id điểm: ${[...dupIds].join(', ')}`);

  const checkRef = (refId, ctx) => { if (refId && !ids.has(refId)) errors.push(`${ctx} tham chiếu tới điểm không tồn tại: "${refId}"`); };

  (program.segments || []).concat(program.auxSegments || []).forEach((s, i) => {
    (s && s.points || []).forEach((id) => checkRef(id, `segment[${i}]`));
  });
  (program.circles || []).forEach((c, i) => {
    checkRef(c && c.center, `circle[${i}]`);
    if (c && c.through) checkRef(c.through, `circle[${i}].through`);
  });
  (program.polygons || []).forEach((poly, i) => {
    (poly && poly.points || []).forEach((id) => checkRef(id, `polygon[${i}]`));
  });
  (program.arcs || []).forEach((a, i) => {
    checkRef(a && a.center, `arc[${i}]`); checkRef(a && a.from, `arc[${i}]`); checkRef(a && a.to, `arc[${i}]`);
  });
  (program.vectors || []).forEach((v, i) => {
    checkRef(v && v.from, `vector[${i}]`); checkRef(v && v.to, `vector[${i}]`);
  });
  return errors;
}

function validateShapeElement(el) {
  const errors = [];
  if (!el || typeof el !== 'object') return ['phần tử composite không phải object'];
  if (!SHAPE_SIMPLE_TYPES.has(el.type)) return [`type "${el.type}" không hợp lệ cho shape đơn giản/composite`];
  if (el.type === 'circle') {
    if (!Array.isArray(el.center) || el.center.length !== 2) errors.push('circle thiếu "center":[x,y]');
    if (typeof el.radius !== 'number') errors.push('circle thiếu "radius" dạng số');
  } else if (!Array.isArray(el.points) || !el.points.length) {
    errors.push(`${el.type} thiếu "points"`);
  }
  return errors;
}

function validateShapeBlock(json) {
  const errors = [];
  if (json.type === 'program') {
    if (!Array.isArray(json.points)) errors.push('shape "program" thiếu "points"');
    else errors.push(...validatePointsExistInProgram(json));
  } else if (json.type === 'composite') {
    if (!Array.isArray(json.elements) || !json.elements.length) errors.push('shape "composite" thiếu "elements"');
    else json.elements.forEach((el) => errors.push(...validateShapeElement(el)));
  } else if (SHAPE_SIMPLE_TYPES.has(json.type)) {
    errors.push(...validateShapeElement(json));
  } else {
    errors.push(`shape.type không hợp lệ: ${json.type}`);
  }
  return errors;
}

// ---------- Mục 6F: validate RECURSIVE cho schema solid3d composable ----------
// Trước đây chỉ kiểm tra đúng 1 dòng "type có trong allow-list primitive hay không". Với schema mới
// (transform/boolean/group lồng nhau) phải validate theo CÂY: thiếu base/tool, operation sai, size
// âm/không hợp lệ, reference sai kiểu, recursion quá sâu — đúng yêu cầu mục 6F.
function validateSolid3dNode(node, depth) {
  const errors = [];
  if (!node || typeof node !== 'object') return ['node solid3d rỗng hoặc không phải object'];
  if (depth > MAX_SOLID3D_DEPTH) return [`solid3d lồng quá sâu (vượt quá ${MAX_SOLID3D_DEPTH} cấp) — khả năng malformed`];

  if (SOLID3D_PRIMITIVE_TYPES.has(node.type)) {
    // Các trường số (a/b/c/radius/height/baseSize dạng số) nếu có mặt phải là số dương — không bắt
    // buộc phải có (renderer tự có default), chỉ chặn giá trị SAI KIỂU/ÂM lọt qua.
    ['a', 'b', 'c', 'radius', 'height'].forEach((k) => {
      if (node[k] !== undefined && !(typeof node[k] === 'number' && node[k] > 0)) {
        errors.push(`solid3d.${k} phải là số dương nếu có, nhận được: ${JSON.stringify(node[k])}`);
      }
    });
    return errors;
  }

  if (node.type === 'transform') {
    if (!node.child || typeof node.child !== 'object') errors.push('solid3d "transform" thiếu "child"');
    else errors.push(...validateSolid3dNode(node.child, depth + 1));
    ['position', 'rotation'].forEach((k) => {
      if (node[k] !== undefined && (!Array.isArray(node[k]) || node[k].length !== 3 || node[k].some((n) => typeof n !== 'number'))) {
        errors.push(`solid3d.transform.${k} phải là mảng 3 số [x,y,z] nếu có`);
      }
    });
    return errors;
  }

  if (node.type === 'boolean') {
    if (!SOLID3D_BOOLEAN_OPS.has(node.operation)) errors.push(`solid3d.boolean.operation không hợp lệ: ${node.operation} (chỉ nhận subtract|union|intersect)`);
    if (!node.base || typeof node.base !== 'object') errors.push('solid3d "boolean" thiếu "base"');
    else errors.push(...validateSolid3dNode(node.base, depth + 1).map((e) => `base: ${e}`));
    if (!node.tool || typeof node.tool !== 'object') errors.push('solid3d "boolean" thiếu "tool"');
    else errors.push(...validateSolid3dNode(node.tool, depth + 1).map((e) => `tool: ${e}`));
    return errors;
  }

  if (node.type === 'group') {
    if (!Array.isArray(node.children) || !node.children.length) errors.push('solid3d "group" thiếu "children" (mảng không rỗng)');
    else node.children.forEach((child, i) => errors.push(...validateSolid3dNode(child, depth + 1).map((e) => `children[${i}]: ${e}`)));
    return errors;
  }

  return [`solid3d.type không hợp lệ: ${node.type}`];
}

function validateSolid3dBlock(json) {
  return validateSolid3dNode(json, 0);
}

// ---------- CANONICAL DRAWING STATE — APPROACH -> DETAIL (mục 15) ----------
// "approach" (Hướng giải) và "detail" (Lời giải chi tiết) là 2 LƯỢT GỌI AI HOÀN TOÀN ĐỘC LẬP (xem
// chat.js) — model ở lượt "detail" chỉ ĐƯỢC DẶN bằng prompt phải copy nguyên văn khối vẽ cũ (xem
// promptBuilder.js: approachDrawMatch), nhưng không có gì CƯỠNG CHẾ ở tầng code nếu model vẫn tự vẽ
// lại/đổi toạ độ. Hàm dưới đây đối chiếu khối vẽ ĐẦU TIÊN của approach (canonical) với khối cùng loại
// trong detail: mọi phần tử/điểm ĐÃ CÓ ở approach phải xuất hiện Y HỆT (so JSON canonical) trong
// detail — detail CHỈ được phép THÊM phần tử mới vào cuối, không được xoá/sửa phần tử đã có.
// stableStringify() TRƯỚC ĐÂY dùng `JSON.stringify(v, Object.keys(v).sort())` — replacer dạng
// MẢNG chỉ giữ lại các key có trong mảng đó ở MỌI CẤP (không phải chỉ cấp gốc), nên với object lồng
// nhau (points: [{id,x,y}]), mảng replacer chỉ chứa ['points','type'] (top-level keys) khiến các key
// lồng bên trong (id/x/y) bị LỌC MẤT — 2 điểm khác toạ độ hoàn toàn vẫn stringify ra CÙNG 1 chuỗi
// (mảng object rỗng), khiến checkCanonicalDrawingConsistency() không bao giờ phát hiện được thay đổi
// toạ độ thật (bug im lặng, không throw, chỉ âm thầm coi mọi thứ là "consistent"). FIX: sort key ĐỆ
// QUY ở mọi cấp (không dùng replacer mảng), giữ nguyên toàn bộ giá trị.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * @param {string} approachText Nội dung "Hướng giải" (có thể chứa 1 khối shape/solid3d/plot).
 * @param {string} detailText Nội dung "Lời giải chi tiết" vừa nhận được, cần đối chiếu.
 * @returns {{checked:boolean, consistent:boolean, errors:string[]}} `checked=false` khi approach
 *   không có khối vẽ nào để đối chiếu (không áp dụng mục 15 cho trường hợp này).
 */
function checkCanonicalDrawingConsistency(approachText, detailText) {
  const approachBlocks = extractDrawBlocks(approachText || '');
  if (!approachBlocks.length) return { checked: false, consistent: true, errors: [] };

  const approachBlock = approachBlocks[0]; // quy tắc bắt buộc chỉ cho đúng 1 khối vẽ mỗi giai đoạn
  let approachJson;
  try { approachJson = JSON.parse(approachBlock.raw); } catch (e) { return { checked: false, consistent: true, errors: [] }; }

  const detailBlocks = extractDrawBlocks(detailText || '');
  const detailBlock = detailBlocks.find((b) => b.kind === approachBlock.kind);
  if (!detailBlock) {
    return {
      checked: true, consistent: false,
      errors: [`Hướng giải đã có khối \`${approachBlock.kind}\` nhưng lời giải chi tiết không có khối vẽ nào cùng loại — phải giữ lại hình đã dựng, không được bỏ.`]
    };
  }
  let detailJson;
  try { detailJson = JSON.parse(detailBlock.raw); }
  catch (e) { return { checked: true, consistent: false, errors: ['Khối vẽ ở lời giải chi tiết không phải JSON hợp lệ khi đối chiếu với canonical state của hướng giải.'] }; }

  const errors = [];
  if (approachJson.type !== detailJson.type) {
    errors.push(`Loại hình vẽ bị đổi so với hướng giải: đã có "${approachJson.type}" nhưng lời giải chi tiết đổi thành "${detailJson.type}" — phải giữ nguyên loại, chỉ được bổ sung thêm phần tử.`);
    return { checked: true, consistent: false, errors };
  }

  if (approachJson.type === 'program') {
    const byId = new Map((detailJson.points || []).map((p) => [p && p.id, p]));
    (approachJson.points || []).forEach((p) => {
      if (!p || typeof p.id !== 'string') return;
      const dp = byId.get(p.id);
      if (!dp) { errors.push(`Điểm "${p.id}" đã có ở hướng giải nhưng BỊ THIẾU ở lời giải chi tiết.`); return; }
      if (stableStringify(dp) !== stableStringify(p)) errors.push(`Điểm "${p.id}" bị THAY ĐỔI toạ độ/op so với hướng giải (chỉ được thêm điểm MỚI, không được sửa điểm đã có).`);
    });
  } else if (approachJson.type === 'composite') {
    const aEl = approachJson.elements || [];
    const dEl = detailJson.elements || [];
    if (dEl.length < aEl.length) {
      errors.push('Lời giải chi tiết có ít phần tử hình vẽ hơn hướng giải — không được xoá phần tử composite đã có.');
    } else {
      aEl.forEach((el, i) => {
        if (stableStringify(dEl[i]) !== stableStringify(el)) errors.push(`Phần tử composite thứ ${i + 1} bị thay đổi so với hướng giải — chỉ được thêm phần tử MỚI vào cuối mảng "elements".`);
      });
    }
  } else {
    // Shape đơn giản (polygon/circle/segment/points) hoặc solid3d/plot: không có khái niệm "thêm phần
    // tử" từng phần rõ ràng như program/composite — yêu cầu canonical bằng nhau hoàn toàn.
    if (stableStringify(approachJson) !== stableStringify(detailJson)) {
      errors.push('Hình vẽ (dạng đơn, không phải program/composite) bị thay đổi so với hướng giải — phải giữ nguyên toạ độ/thuộc tính đã dựng.');
    }
  }

  return { checked: true, consistent: errors.length === 0, errors };
}

/**
 * Validate 1 khối vẽ đã trích xuất.
 * @param {{kind:'shape'|'solid3d'|'plot', raw:string}} block
 * @returns {{valid:boolean, errors:string[], json:object|null}}
 */
function validateDrawingBlock(block) {
  let json;
  try {
    json = JSON.parse(block.raw);
  } catch (e) {
    return { valid: false, errors: [`JSON không hợp lệ: ${e.message}`], json: null };
  }
  if (!json || typeof json !== 'object') return { valid: false, errors: ['nội dung không phải một JSON object'], json: null };

  let errors = [];
  if (block.kind === 'plot') errors = validatePlotBlock(json);
  else if (block.kind === 'shape') errors = validateShapeBlock(json);
  else if (block.kind === 'solid3d') errors = validateSolid3dBlock(json);

  return { valid: errors.length === 0, errors, json };
}

/** Validate MỌI khối vẽ trong 1 văn bản — dùng trong completeness/reconcile pipeline. */
function validateAllDrawingBlocks(text) {
  return extractDrawBlocks(text).map((block) => ({ ...block, ...validateDrawingBlock(block) }));
}

module.exports = {
  extractDrawBlocks, validateDrawingBlock, validateAllDrawingBlocks, checkCanonicalDrawingConsistency,
  SHAPE_SIMPLE_TYPES, SOLID3D_TYPES, SOLID3D_PRIMITIVE_TYPES, SOLID3D_COMPOSABLE_TYPES, PROGRAM_OPS
};
