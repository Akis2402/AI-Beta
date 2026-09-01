/* ================================================================================================
 * geo2d-engine.js — 2D Geometry Engine (thuần toán học, không đoán/ước lượng toạ độ)
 * ------------------------------------------------------------------------------------------------
 * Kiến trúc theo đúng pipeline yêu cầu:
 *   spec (program hoặc legacy) -> resolvePoints() -> validateScene() -> computeLayout()
 *   -> placeLabels() -> renderSceneSVG() -> (validateSVGResult ở tầng gọi, có thể auto-repair)
 *
 * Không có DOM dependency trong phần toán học/resolve => test được bằng Node thuần.
 * Xuất ra window.Geo2D (browser) và module.exports (Node, dùng cho script test).
 * ============================================================================================== */
(function (root) {
  'use strict';

  var EPSILON = 1e-9;

  /* ---------------------------------- 1. PRIMITIVES ------------------------------------------ */

  function pt(x, y) { return { x: +x, y: +y }; }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function isValidPoint(p) { return !!p && isFiniteNum(p.x) && isFiniteNum(p.y); }

  function add(a, b) { return pt(a.x + b.x, a.y + b.y); }
  function sub(a, b) { return pt(a.x - b.x, a.y - b.y); }
  function scl(a, k) { return pt(a.x * k, a.y * k); }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function length(a) { return Math.hypot(a.x, a.y); }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function normalize(a) {
    var l = length(a);
    if (l < EPSILON) return pt(0, 0);
    return pt(a.x / l, a.y / l);
  }
  function lerp(a, b, t) { return pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }
  function midpoint(a, b) { return lerp(a, b, 0.5); }

  // Góc tại đỉnh b tạo bởi 2 cạnh ba và bc, trả về độ (0..180)
  function angleAt(a, b, c) {
    var v1 = sub(a, b), v2 = sub(c, b);
    var l1 = length(v1), l2 = length(v2);
    if (l1 < EPSILON || l2 < EPSILON) return NaN;
    var cosv = dot(v1, v2) / (l1 * l2);
    cosv = Math.max(-1, Math.min(1, cosv));
    return Math.acos(cosv) * 180 / Math.PI;
  }

  // Diện tích tam giác (có dấu, dùng để test suy biến/thẳng hàng)
  function signedArea(a, b, c) { return 0.5 * cross(sub(b, a), sub(c, a)); }
  function isCollinear(a, b, c, eps) { return Math.abs(signedArea(a, b, c)) < (eps == null ? EPSILON : eps); }

  // Hình chiếu vuông góc của p lên đường thẳng qua a,b
  function projectPoint(p, a, b) {
    var ab = sub(b, a);
    var len2 = dot(ab, ab);
    if (len2 < EPSILON) return null; // a,b trùng nhau -> không xác định đường thẳng
    var t = dot(sub(p, a), ab) / len2;
    return add(a, scl(ab, t));
  }

  function reflectPoint(p, a, b) {
    var f = projectPoint(p, a, b);
    if (!f) return null;
    return add(f, sub(f, p)); // p' = 2f - p
  }

  // Giao điểm 2 đường thẳng (không giới hạn đoạn), null nếu song song/trùng
  function intersectLines(a1, a2, b1, b2) {
    var d1 = sub(a2, a1), d2 = sub(b2, b1);
    var denom = cross(d1, d2);
    if (Math.abs(denom) < EPSILON) return null; // song song hoặc trùng
    var t = cross(sub(b1, a1), d2) / denom;
    return add(a1, scl(d1, t));
  }

  // Giao điểm 2 đoạn thẳng (giới hạn trong đoạn), null nếu không cắt nhau thực sự
  function intersectSegments(a1, a2, b1, b2) {
    var d1 = sub(a2, a1), d2 = sub(b2, b1);
    var denom = cross(d1, d2);
    if (Math.abs(denom) < EPSILON) return null;
    var t = cross(sub(b1, a1), d2) / denom;
    var u = cross(sub(b1, a1), d1) / denom;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
    return add(a1, scl(d1, t));
  }

  // Giao điểm đường thẳng (qua a,b) với đường tròn (center,r) -> mảng 0/1/2 điểm
  function intersectLineCircle(a, b, center, r) {
    var d = sub(b, a);
    var f = sub(a, center);
    var A = dot(d, d);
    if (A < EPSILON) return [];
    var B = 2 * dot(f, d);
    var C = dot(f, f) - r * r;
    var disc = B * B - 4 * A * C;
    if (disc < -EPSILON) return [];
    disc = Math.max(disc, 0);
    var sq = Math.sqrt(disc);
    var t1 = (-B - sq) / (2 * A);
    var t2 = (-B + sq) / (2 * A);
    if (Math.abs(disc) < EPSILON) return [add(a, scl(d, t1))];
    return [add(a, scl(d, t1)), add(a, scl(d, t2))];
  }

  // Giao điểm 2 đường tròn -> mảng 0/1/2 điểm
  function intersectCircles(c1, r1, c2, r2) {
    var d = distance(c1, c2);
    if (d < EPSILON) return []; // đồng tâm
    if (d > r1 + r2 + EPSILON) return []; // quá xa
    if (d < Math.abs(r1 - r2) - EPSILON) return []; // lồng nhau không cắt
    var a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    var h2 = r1 * r1 - a * a;
    var h = Math.sqrt(Math.max(0, h2));
    var dir = normalize(sub(c2, c1));
    var perp = pt(-dir.y, dir.x);
    var base = add(c1, scl(dir, a));
    if (h < EPSILON) return [base];
    return [add(base, scl(perp, h)), add(base, scl(perp, -h))];
  }

  function circumcenter(a, b, c) {
    var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < EPSILON) return null; // 3 điểm thẳng hàng
    var a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    var ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    var uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return pt(ux, uy);
  }

  function incenter(a, b, c) {
    var la = distance(b, c), lb = distance(a, c), lc = distance(a, b);
    var per = la + lb + lc;
    if (per < EPSILON) return null;
    return pt((la * a.x + lb * b.x + lc * c.x) / per, (la * a.y + lb * b.y + lc * c.y) / per);
  }

  function centroid3(a, b, c) { return pt((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3); }

  function orthocenter(a, b, c) {
    var o = circumcenter(a, b, c);
    if (!o) return null;
    // H = A + B + C - 2O  (tính chất vector Euler line)
    return pt(a.x + b.x + c.x - 2 * o.x, a.y + b.y + c.y - 2 * o.y);
  }

  function rotatePoint(p, center, angleDeg) {
    var th = angleDeg * Math.PI / 180;
    var v = sub(p, center);
    var cs = Math.cos(th), sn = Math.sin(th);
    return add(center, pt(v.x * cs - v.y * sn, v.x * sn + v.y * cs));
  }

  function pointOnCircleAtAngle(center, r, angleDeg) {
    var th = angleDeg * Math.PI / 180;
    return pt(center.x + r * Math.cos(th), center.y + r * Math.sin(th));
  }

  // D trên BC sao cho AD là phân giác góc A (định lý phân giác: BD/DC = AB/AC)
  function angleBisectorFoot(a, b, c) {
    var ab = distance(a, b), ac = distance(a, c);
    var s = ab + ac;
    if (s < EPSILON) return null;
    var t = ab / s; // D = B + t*(C-B)
    return lerp(b, c, t);
  }

  function diametricOpposite(center, p) { return pt(2 * center.x - p.x, 2 * center.y - p.y); }

  var Geo = {
    EPSILON: EPSILON, pt: pt, isValidPoint: isValidPoint, isFiniteNum: isFiniteNum,
    add: add, sub: sub, scl: scl, dot: dot, cross: cross, length: length, distance: distance,
    normalize: normalize, lerp: lerp, midpoint: midpoint, angleAt: angleAt,
    signedArea: signedArea, isCollinear: isCollinear, projectPoint: projectPoint,
    reflectPoint: reflectPoint, intersectLines: intersectLines, intersectSegments: intersectSegments,
    intersectLineCircle: intersectLineCircle, intersectCircles: intersectCircles,
    circumcenter: circumcenter, incenter: incenter, centroid3: centroid3, orthocenter: orthocenter,
    rotatePoint: rotatePoint, pointOnCircleAtAngle: pointOnCircleAtAngle,
    angleBisectorFoot: angleBisectorFoot, diametricOpposite: diametricOpposite
  };

  /* ---------------------------------- 2. CONSTRUCTION RESOLVER -------------------------------- */
  /*
   * spec.points: mảng {id, op, ...} — mỗi điểm được TÍNH từ quan hệ hình học, không hardcode.
   * Cho phép khai báo không theo đúng thứ tự phụ thuộc (resolver tự lặp nhiều pass).
   */

  function resolveCircleRef(ref, points) {
    // ref: {center:'O', radius:number} hoặc {center:'O', through:'A'}
    if (!ref) return null;
    var center = points[ref.center];
    if (!isValidPoint(center)) return null;
    var r = null;
    if (ref.radius != null && isFiniteNum(+ref.radius)) r = +ref.radius;
    else if (ref.through && isValidPoint(points[ref.through])) r = distance(center, points[ref.through]);
    if (r == null || !isFiniteNum(r) || r <= EPSILON) return null;
    return { center: center, r: r };
  }

  function resolvePointOp(node, points, errors) {
    var id = node.id;
    try {
      switch (node.op) {
        case 'free':
          return pt(+node.x, +node.y);
        case 'midpoint': {
          var A = points[node.of[0]], B = points[node.of[1]];
          if (!isValidPoint(A) || !isValidPoint(B)) return undefined;
          return midpoint(A, B);
        }
        case 'foot': {
          var P = points[node.from], La = points[node.line[0]], Lb = points[node.line[1]];
          if (!isValidPoint(P) || !isValidPoint(La) || !isValidPoint(Lb)) return undefined;
          var f = projectPoint(P, La, Lb);
          if (!f) { errors.push(id + ': đường thẳng ' + node.line.join('') + ' suy biến (2 điểm trùng nhau), không tính được hình chiếu.'); return null; }
          return f;
        }
        case 'reflect': {
          var Pp = points[node.point], A2 = points[node.line[0]], B2 = points[node.line[1]];
          if (!isValidPoint(Pp) || !isValidPoint(A2) || !isValidPoint(B2)) return undefined;
          var rf = reflectPoint(Pp, A2, B2);
          if (!rf) { errors.push(id + ': không tính được điểm đối xứng (đường suy biến).'); return null; }
          return rf;
        }
        case 'circumcenter': case 'incenter': case 'centroid': case 'orthocenter': {
          var of3 = node.of.map(function (k) { return points[k]; });
          if (of3.some(function (p) { return !isValidPoint(p); })) return undefined;
          if (isCollinear(of3[0], of3[1], of3[2], 1e-7)) {
            errors.push(id + ': 3 điểm ' + node.of.join('') + ' thẳng hàng, không xác định được ' + node.op + '.');
            return null;
          }
          if (node.op === 'circumcenter') return circumcenter(of3[0], of3[1], of3[2]);
          if (node.op === 'incenter') return incenter(of3[0], of3[1], of3[2]);
          if (node.op === 'centroid') return centroid3(of3[0], of3[1], of3[2]);
          return orthocenter(of3[0], of3[1], of3[2]);
        }
        case 'intersectLines': {
          var l1a = points[node.line1[0]], l1b = points[node.line1[1]];
          var l2a = points[node.line2[0]], l2b = points[node.line2[1]];
          if (![l1a, l1b, l2a, l2b].every(isValidPoint)) return undefined;
          var ip = intersectLines(l1a, l1b, l2a, l2b);
          if (!ip) { errors.push(id + ': ' + node.line1.join('') + ' song song với ' + node.line2.join('') + ', không có giao điểm.'); return null; }
          return ip;
        }
        case 'intersectLineCircle': {
          var lla = points[node.line[0]], llb = points[node.line[1]];
          if (!isValidPoint(lla) || !isValidPoint(llb)) return undefined;
          var circ = resolveCircleRef(node.circle, points);
          if (!circ) return undefined;
          var sols = intersectLineCircle(lla, llb, circ.center, circ.r);
          if (!sols.length) { errors.push(id + ': đường thẳng không cắt đường tròn đã cho.'); return null; }
          return pickSolution(sols, node, points);
        }
        case 'intersectCircles': {
          var c1 = resolveCircleRef(node.circle1, points), c2 = resolveCircleRef(node.circle2, points);
          if (!c1 || !c2) return undefined;
          var sols2 = intersectCircles(c1.center, c1.r, c2.center, c2.r);
          if (!sols2.length) { errors.push(id + ': hai đường tròn không cắt nhau.'); return null; }
          return pickSolution(sols2, node, points);
        }
        case 'pointOnLine': {
          var pla = points[node.line[0]], plb = points[node.line[1]];
          if (!isValidPoint(pla) || !isValidPoint(plb)) return undefined;
          return lerp(pla, plb, +node.t);
        }
        case 'pointOnCircle': {
          var pc = resolveCircleRef(node, points);
          if (!pc) return undefined;
          return pointOnCircleAtAngle(pc.center, pc.r, +node.angleDeg);
        }
        case 'diametricOpposite': {
          var oc = points[node.center], op = points[node.point];
          if (!isValidPoint(oc) || !isValidPoint(op)) return undefined;
          return diametricOpposite(oc, op);
        }
        case 'angleBisectorFoot': {
          var ba = points[node.from], bb = points[node.line[0]], bc = points[node.line[1]];
          if (!isValidPoint(ba) || !isValidPoint(bb) || !isValidPoint(bc)) return undefined;
          var abf = angleBisectorFoot(ba, bb, bc);
          if (!abf) { errors.push(id + ': không tính được chân đường phân giác.'); return null; }
          return abf;
        }
        case 'rotate': {
          var rp = points[node.point], rc = points[node.center];
          if (!isValidPoint(rp) || !isValidPoint(rc)) return undefined;
          return rotatePoint(rp, rc, +node.angleDeg);
        }
        default:
          errors.push(id + ': op "' + node.op + '" không được hỗ trợ.');
          return null;
      }
    } catch (e) {
      errors.push(id + ': lỗi khi tính (' + e.message + ').');
      return null;
    }
  }

  // pick: 'near'|'far' so với node.hint (id điểm tham chiếu, mặc định điểm đầu tiên liên quan),
  // hoặc số nguyên (chỉ số 0/1 trực tiếp trong mảng nghiệm).
  function pickSolution(sols, node, points) {
    if (sols.length === 1) return sols[0];
    if (typeof node.pick === 'number') return sols[Math.max(0, Math.min(sols.length - 1, node.pick))];
    var hintId = node.hint || (node.line ? node.line[0] : null);
    var hint = hintId ? points[hintId] : null;
    if (node.pick === 'far' && hint) {
      return distance(sols[0], hint) > distance(sols[1], hint) ? sols[0] : sols[1];
    }
    // mặc định 'near' hoặc không có hint: lấy điểm gần hint nhất, nếu không có hint thì lấy sols[0]
    if (hint) return distance(sols[0], hint) < distance(sols[1], hint) ? sols[0] : sols[1];
    return sols[0];
  }

  // Trả về {points: {id: {x,y}}, errors: [...]} — lỗi cứng (undefined ref/circular) khiến hàm ném exception.
  function resolvePoints(pointDefs) {
    var points = {};
    var errors = [];
    var pending = pointDefs.slice();
    var maxPasses = pointDefs.length + 3;
    for (var pass = 0; pass < maxPasses && pending.length; pass++) {
      var next = [];
      for (var i = 0; i < pending.length; i++) {
        var node = pending[i];
        var val = resolvePointOp(node, points, errors);
        if (val === undefined) { next.push(node); continue; } // phụ thuộc chưa sẵn sàng, thử lại pass sau
        if (val === null || !isValidPoint(val)) {
          // lỗi hình học cứng đã được log ở resolvePointOp (hoặc NaN) — vẫn gán để phát hiện ở validate
          points[node.id] = pt(NaN, NaN);
          continue;
        }
        points[node.id] = val;
      }
      pending = next;
    }
    if (pending.length) {
      pending.forEach(function (node) {
        errors.push(node.id + ': không giải được (tham chiếu tới điểm không tồn tại hoặc phụ thuộc vòng lặp).');
        points[node.id] = pt(NaN, NaN);
      });
    }
    return { points: points, errors: errors };
  }

  /* ---------------------------------- 3. VALIDATION -------------------------------------------- */

  function validateScene(scene) {
    var issues = [];
    var ids = Object.keys(scene.points);
    if (!ids.length) { issues.push({ level: 'error', msg: 'Không có điểm nào trong hình.' }); return issues; }

    var xs = [], ys = [];
    ids.forEach(function (id) {
      var p = scene.points[id];
      if (!isValidPoint(p)) issues.push({ level: 'error', msg: 'Điểm ' + id + ' có toạ độ không hợp lệ (NaN/Infinity).' });
      else { xs.push(p.x); ys.push(p.y); }
    });
    if (issues.length) return issues; // không đo scale được nếu đã có NaN

    var diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
    var eps = diag * 1e-6;

    // Điểm trùng bất thường (2 id khác nhau nhưng không được khai là trùng)
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        if (distance(scene.points[ids[i]], scene.points[ids[j]]) < eps) {
          issues.push({ level: 'warn', msg: 'Điểm ' + ids[i] + ' và ' + ids[j] + ' trùng nhau (hoặc rất gần nhau).' });
        }
      }
    }

    (scene.segments || []).concat(scene.auxSegments || []).forEach(function (seg) {
      var a = scene.points[seg.a], b = scene.points[seg.b];
      if (a && b && distance(a, b) < eps) issues.push({ level: 'warn', msg: 'Đoạn ' + seg.a + seg.b + ' có độ dài ≈ 0.' });
    });

    (scene.polygons || []).forEach(function (poly) {
      if (poly.ids.length === 3) {
        var A = scene.points[poly.ids[0]], B = scene.points[poly.ids[1]], C = scene.points[poly.ids[2]];
        if (A && B && C && Math.abs(signedArea(A, B, C)) < eps * diag * 0.02) {
          issues.push({ level: 'error', msg: 'Tam giác ' + poly.ids.join('') + ' suy biến (3 đỉnh gần thẳng hàng).' });
        }
      }
    });

    return issues;
  }

  /* ---------------------------------- 4. LEGACY / PROGRAM -> SCENE ADAPTER --------------------- */
  /*
   * Scene chuẩn nội bộ:
   * { points: {id:{x,y}}, labels:{id:label}, segments:[{a,b}], auxSegments:[{a,b}],
   *   circles:[{center:{x,y}|id, r}], polygons:[{ids:[...] , dashed}], pointsOrder:[id,...] }
   */

  function sceneFromProgram(spec) {
    var resolved = resolvePoints(spec.points || []);
    var scene = {
      points: resolved.points,
      labels: {},
      segments: [], auxSegments: [], circles: [], polygons: [],
      pointsOrder: (spec.points || []).map(function (p) { return p.id; }),
      errors: resolved.errors.slice()
    };
    (spec.points || []).forEach(function (p) { scene.labels[p.id] = (p.label != null ? p.label : p.id); });

    (spec.segments || []).forEach(function (s) {
      for (var k = 0; k < s.points.length - 1; k++) scene.segments.push({ a: s.points[k], b: s.points[k + 1] });
    });
    (spec.auxSegments || []).forEach(function (s) {
      for (var k = 0; k < s.points.length - 1; k++) scene.auxSegments.push({ a: s.points[k], b: s.points[k + 1] });
    });
    (spec.circles || []).forEach(function (c) {
      var circ = resolveCircleRef(c, scene.points);
      if (circ) scene.circles.push({ center: circ.center, r: circ.r, dashed: !!c.dashed });
      else scene.errors.push('Đường tròn tâm ' + c.center + ' không xác định được (thiếu bán kính/điểm đi qua hợp lệ).');
    });
    (spec.polygons || []).forEach(function (p) { scene.polygons.push({ ids: p.points, dashed: !!p.dashed }); });

    var visible = spec.onlyPoints ? new Set(spec.onlyPoints) : null;
    scene.visiblePoints = scene.pointsOrder.filter(function (id) { return !visible || visible.has(id); });
    return scene;
  }

  // Chuyển định dạng cũ (raw coordinates, không có construction) sang cùng 1 Scene để tái dùng
  // toàn bộ pipeline validate/layout/label/render — đảm bảo tương thích ngược, không phá vỡ các
  // khối \`shape\` đơn giản đã có sẵn từ trước.
  function sceneFromLegacy(spec) {
    var elements = (spec && spec.type === 'composite' && Array.isArray(spec.elements) && spec.elements.length)
      ? spec.elements.filter(Boolean) : [spec];
    var scene = { points: {}, labels: {}, segments: [], auxSegments: [], circles: [], polygons: [], pointsOrder: [], errors: [] };
    var counter = 0;
    function newId(prefix) { return prefix + (counter++); }

    elements.forEach(function (elmt, ei) {
      if (!elmt) return;
      var type = elmt.type || 'polygon';
      var isAux = !!elmt.dashed;
      var pts = (elmt.points || []).map(function (p) { return pt(+p[0], +p[1]); });
      var ids = pts.map(function (p, i) {
        var id = newId('_p');
        scene.points[id] = p;
        scene.labels[id] = (elmt.labels && elmt.labels[i]) || null;
        scene.pointsOrder.push(id);
        return id;
      });

      if (type === 'circle' && elmt.center && elmt.radius != null) {
        var cid = newId('_c');
        scene.points[cid] = pt(+elmt.center[0], +elmt.center[1]);
        scene.circles.push({ center: scene.points[cid], r: +elmt.radius, dashed: isAux });
      } else if (type === 'segment' && ids.length >= 2) {
        for (var k = 0; k < ids.length - 1; k++) (isAux ? scene.auxSegments : scene.segments).push({ a: ids[k], b: ids[k + 1] });
      } else if (type === 'points') {
        // chỉ chấm điểm, không cần thêm gì
      } else if (ids.length >= 2) {
        scene.polygons.push({ ids: ids, dashed: isAux });
      }
    });

    scene.visiblePoints = scene.pointsOrder.filter(function (id) { return scene.labels[id] != null; });
    return scene;
  }

  function buildScene(spec) {
    if (spec && spec.type === 'program' && Array.isArray(spec.points)) return sceneFromProgram(spec);
    return sceneFromLegacy(spec);
  }

  /* ---------------------------------- 5. AUTO LAYOUT -------------------------------------------- */

  function computeLayout(scene, W, H, pad) {
    var xs = [], ys = [];
    Object.keys(scene.points).forEach(function (id) {
      var p = scene.points[id];
      if (isValidPoint(p)) { xs.push(p.x); ys.push(p.y); }
    });
    scene.circles.forEach(function (c) {
      if (isValidPoint(c.center) && isFiniteNum(c.r)) {
        xs.push(c.center.x - c.r, c.center.x + c.r);
        ys.push(c.center.y - c.r, c.center.y + c.r);
      }
    });
    if (!xs.length) { xs = [0, 1]; ys = [0, 1]; }
    var xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    if (xmax - xmin < EPSILON) { xmin -= 1; xmax += 1; }
    if (ymax - ymin < EPSILON) { ymin -= 1; ymax += 1; }
    var mx = (xmax - xmin) * 0.1 + 0.35, my = (ymax - ymin) * 0.1 + 0.35;
    xmin -= mx; xmax += mx; ymin -= my; ymax += my;
    var scale = Math.min((W - 2 * pad) / (xmax - xmin), (H - 2 * pad) / (ymax - ymin));
    var ox = (W - (xmax - xmin) * scale) / 2;
    var oy = (H - (ymax - ymin) * scale) / 2;
    var sx = function (x) { return ox + (x - xmin) * scale; };
    var sy = function (y) { return H - (oy + (y - ymin) * scale); };
    var cx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    var cy = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    return { sx: sx, sy: sy, scale: scale, centroid: pt(cx, cy), W: W, H: H, pad: pad };
  }

  /* ---------------------------------- 6. LABEL PLACEMENT ENGINE --------------------------------- */
  /*
   * Generate candidates -> collision detection -> score -> chọn vị trí tốt nhất.
   * Tránh: điểm khác, cạnh, đường phụ, đường tròn, label khác, mép canvas.
   */

  function distPointToSegmentPx(p, a, b) {
    var ab = { x: b.x - a.x, y: b.y - a.y };
    var len2 = ab.x * ab.x + ab.y * ab.y;
    if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2));
    var proj = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    return Math.hypot(p.x - proj.x, p.y - proj.y);
  }

  function rectsOverlap(r1, r2) {
    return !(r1.x2 < r2.x1 || r2.x2 < r1.x1 || r1.y2 < r2.y1 || r2.y2 < r1.y1);
  }

  function estimateLabelBox(cx, cy, text, anchor) {
    var w = Math.max(11, String(text).length * 9.4) + 4;
    var h = 18;
    var x1 = anchor === 'start' ? cx - 3 : anchor === 'end' ? cx - w + 3 : cx - w / 2;
    return { x1: x1, y1: cy - h / 2, x2: x1 + w, y2: cy + h / 2 };
  }

  function placeLabels(scene, layout) {
    var placedBoxes = [];
    var W = layout.W, H = layout.H, pad = layout.pad * 0.55;
    var strokesPx = []; // {a:{x,y}, b:{x,y}} trong toạ độ pixel, cho segment
    scene.segments.concat(scene.auxSegments).forEach(function (s) {
      var a = scene.points[s.a], b = scene.points[s.b];
      if (isValidPoint(a) && isValidPoint(b)) strokesPx.push({ a: { x: layout.sx(a.x), y: layout.sy(a.y) }, b: { x: layout.sx(b.x), y: layout.sy(b.y) } });
    });
    scene.polygons.forEach(function (poly) {
      for (var k = 0; k < poly.ids.length; k++) {
        var a = scene.points[poly.ids[k]], b = scene.points[poly.ids[(k + 1) % poly.ids.length]];
        if (isValidPoint(a) && isValidPoint(b)) strokesPx.push({ a: { x: layout.sx(a.x), y: layout.sy(a.y) }, b: { x: layout.sx(b.x), y: layout.sy(b.y) } });
      }
    });
    var circlesPx = scene.circles.filter(function (c) { return isValidPoint(c.center); }).map(function (c) {
      return { cx: layout.sx(c.center.x), cy: layout.sy(c.center.y), r: c.r * layout.scale };
    });
    var pointsPx = Object.keys(scene.points).filter(function (id) { return isValidPoint(scene.points[id]); }).map(function (id) {
      return { x: layout.sx(scene.points[id].x), y: layout.sy(scene.points[id].y) };
    });

    var result = {};
    var order = scene.visiblePoints || Object.keys(scene.points);
    order.forEach(function (id) {
      var label = scene.labels ? scene.labels[id] : id;
      if (!label) return;
      var p = scene.points[id];
      if (!isValidPoint(p)) return;
      var px = layout.sx(p.x), py = layout.sy(p.y);
      var dirToOut = { x: px - layout.sx(layout.centroid.x), y: py - layout.sy(layout.centroid.y) };
      var dLen = Math.hypot(dirToOut.x, dirToOut.y) || 1;
      dirToOut.x /= dLen; dirToOut.y /= dLen;

      var candidates = [];
      var dirs = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
      [18, 25, 34].forEach(function (radius) {
        dirs.forEach(function (d) {
          var l = Math.hypot(d[0], d[1]) || 1;
          var ux = d[0] / l, uy = d[1] / l;
          var cx = px + ux * radius, cy = py + uy * radius;
          var anchor = ux > 0.3 ? 'start' : ux < -0.3 ? 'end' : 'middle';
          var alignBonus = (ux * dirToOut.x + uy * dirToOut.y); // ưu tiên hướng ra xa tâm hình
          candidates.push({ cx: cx, cy: cy, anchor: anchor, alignBonus: alignBonus, radius: radius });
        });
      });

      var best = null, bestScore = Infinity;
      candidates.forEach(function (cand) {
        var box = estimateLabelBox(cand.cx, cand.cy, label, cand.anchor);
        var score = 0;
        if (box.x1 < pad || box.x2 > W - pad || box.y1 < pad || box.y2 > H - pad) score += 500; // mép canvas
        placedBoxes.forEach(function (pb) { if (rectsOverlap(box, pb)) score += 400; }); // label khác
        pointsPx.forEach(function (pp) {
          var d = Math.hypot(pp.x - cand.cx, pp.y - cand.cy);
          if (d < 12.5) score += 250; // đè lên điểm khác
        });
        strokesPx.forEach(function (s) {
          var d = distPointToSegmentPx({ x: cand.cx, y: cand.cy }, s.a, s.b);
          if (d < 10) score += 60 * (10 - d) / 10; // gần/đè cạnh, đường phụ
        });
        circlesPx.forEach(function (c) {
          var d = Math.abs(Math.hypot(cand.cx - c.cx, cand.cy - c.cy) - c.r);
          if (d < 10) score += 60 * (10 - d) / 10; // gần/đè đường tròn
        });
        score += (1 - cand.alignBonus) * 6; // ưu tiên hướng ra xa tâm
        score += cand.radius * 0.15; // ưu tiên gần điểm hơn nếu các yếu tố khác ngang nhau
        if (score < bestScore) { bestScore = score; best = { cand: cand, box: box }; }
      });

      if (best) {
        placedBoxes.push(best.box);
        result[id] = { x: best.cand.cx, y: best.cand.cy, anchor: best.cand.anchor };
      }
    });
    return result;
  }

  /* ---------------------------------- 7. RENDER (SVG STRING) ------------------------------------ */

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function renderSceneSVG(scene, opts) {
    var W = opts.W, H = opts.H, pad = opts.pad;
    var MAIN = opts.mainColor || 'var(--primary)';
    var AUX = opts.auxColor || '#0EA8B0';
    var layout = computeLayout(scene, W, H, pad);
    var labelPos = placeLabels(scene, layout);
    var sx = layout.sx, sy = layout.sy;

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px" class="geo-svg">';
    svg += '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="10" fill="var(--paper-3)" stroke="var(--rule)" stroke-width="1"/>';

    // Layer 1: circles
    scene.circles.forEach(function (c) {
      if (!isValidPoint(c.center)) return;
      var stroke = c.dashed ? AUX : MAIN;
      var dashAttr = c.dashed ? ' stroke-dasharray="7,6"' : '';
      svg += '<circle cx="' + sx(c.center.x).toFixed(1) + '" cy="' + sy(c.center.y).toFixed(1) + '" r="' + (c.r * layout.scale).toFixed(1) + '" fill="' + MAIN + '" fill-opacity="0.045" stroke="' + stroke + '" stroke-width="2.4"' + dashAttr + '/>';
    });
    // Layer 2: auxiliary (dashed) segments/polygons
    scene.auxSegments.forEach(function (s) {
      var a = scene.points[s.a], b = scene.points[s.b];
      if (!isValidPoint(a) || !isValidPoint(b)) return;
      svg += '<line x1="' + sx(a.x).toFixed(1) + '" y1="' + sy(a.y).toFixed(1) + '" x2="' + sx(b.x).toFixed(1) + '" y2="' + sy(b.y).toFixed(1) + '" stroke="' + AUX + '" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="7,6"/>';
    });
    // Layer 3: main geometry (segments + polygons)
    scene.segments.forEach(function (s) {
      var a = scene.points[s.a], b = scene.points[s.b];
      if (!isValidPoint(a) || !isValidPoint(b)) return;
      svg += '<line x1="' + sx(a.x).toFixed(1) + '" y1="' + sy(a.y).toFixed(1) + '" x2="' + sx(b.x).toFixed(1) + '" y2="' + sy(b.y).toFixed(1) + '" stroke="' + MAIN + '" stroke-width="2.2" stroke-linecap="round"/>';
    });
    scene.polygons.forEach(function (poly) {
      var pts = poly.ids.map(function (id) { return scene.points[id]; });
      if (!pts.every(isValidPoint)) return;
      var stroke = poly.dashed ? AUX : MAIN;
      var dashAttr = poly.dashed ? ' stroke-dasharray="7,6"' : '';
      var path = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1); }).join(' ') + ' Z';
      svg += '<path d="' + path + '" fill="' + MAIN + '" fill-opacity="0.09" stroke="' + stroke + '" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"' + dashAttr + '/>';
    });
    // Layer 4: point markers
    (scene.visiblePoints || Object.keys(scene.points)).forEach(function (id) {
      var p = scene.points[id];
      if (!isValidPoint(p)) return;
      var px = sx(p.x), py = sy(p.y);
      svg += '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="5.6" fill="var(--paper-3)" stroke="var(--text)" stroke-width="2"/>';
      svg += '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="2.4" fill="var(--text)"/>';
    });
    // Layer 5: labels (luôn trên cùng)
    (scene.visiblePoints || Object.keys(scene.points)).forEach(function (id) {
      var label = scene.labels ? scene.labels[id] : null;
      var lp = labelPos[id];
      if (!label || !lp) return;
      svg += '<text x="' + lp.x.toFixed(1) + '" y="' + lp.y.toFixed(1) + '" font-size="18" font-family="Inter,sans-serif" fill="var(--text)" font-weight="700" text-anchor="' + lp.anchor + '" dominant-baseline="middle" paint-order="stroke" stroke="var(--paper-3)" stroke-width="4" stroke-linejoin="round">' + esc(label) + '</text>';
    });

    svg += '</svg>';
    return svg;
  }

  /* ---------------------------------- 8. TOP-LEVEL PIPELINE -------------------------------------- */

  // Trả về {svg} khi thành công, hoặc {error} khi hình học không hợp lệ (KHÔNG render scene lỗi).
  function renderGeometry(spec, opts) {
    opts = opts || {};
    var W = opts.W || 640, H = opts.H || 460, pad = opts.pad || 60;
    var scene;
    try {
      scene = buildScene(spec);
    } catch (e) {
      return { error: 'Lỗi phân tích cấu trúc hình học: ' + e.message };
    }
    if (scene.errors && scene.errors.length) {
      return { error: scene.errors.join(' | '), scene: scene };
    }
    var issues = validateScene(scene);
    var hardErrors = issues.filter(function (i) { return i.level === 'error'; });
    if (hardErrors.length) {
      return { error: hardErrors.map(function (i) { return i.msg; }).join(' | '), scene: scene, issues: issues };
    }
    var svg = renderSceneSVG(scene, { W: W, H: H, pad: pad, mainColor: opts.mainColor, auxColor: opts.auxColor });
    return { svg: svg, scene: scene, issues: issues };
  }

  Geo.buildScene = buildScene;
  Geo.resolvePoints = resolvePoints;
  Geo.validateScene = validateScene;
  Geo.computeLayout = computeLayout;
  Geo.placeLabels = placeLabels;
  Geo.renderSceneSVG = renderSceneSVG;
  Geo.renderGeometry = renderGeometry;

  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  else root.Geo2D = Geo;
})(typeof window !== 'undefined' ? window : globalThis);
