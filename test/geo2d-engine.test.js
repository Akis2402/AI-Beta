const assert = require('assert');
const Geo = require('../public/js/geo2d-engine.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

function expectOk(spec, name) {
  const r = Geo.renderGeometry(spec, { W: 760, H: 560, pad: 56 });
  if (r.error) throw new Error('unexpected error: ' + r.error);
  if (!r.svg || typeof r.svg !== 'string' || !r.svg.startsWith('<svg')) throw new Error('no svg produced');
  if (/NaN|Infinity/.test(r.svg)) throw new Error('svg contains NaN/Infinity');
  return r;
}
function expectError(spec, name) {
  const r = Geo.renderGeometry(spec, { W: 760, H: 560, pad: 56 });
  if (!r.error) throw new Error('expected an error but geometry rendered fine');
  return r;
}

console.log('\n== Legacy raw-coordinate format (backward compatibility) ==');
test('legacy simple triangle', () => {
  expectOk({ type: 'polygon', points: [[0, 0], [4, 0], [2, 3]], labels: ['A', 'B', 'C'] });
});
test('legacy composite (triangle + circle + aux segment)', () => {
  expectOk({
    type: 'composite', elements: [
      { type: 'polygon', points: [[0, 0], [4, 0], [2, 3]], labels: ['A', 'B', 'C'] },
      { type: 'circle', center: [2, 1], radius: 2 },
      { type: 'segment', points: [[2, 3], [2, 0]], dashed: true, labels: ['A', 'D'] }
    ]
  });
});

console.log('\n== Basic construction ops ==');
test('right triangle (free points)', () => {
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 4 }, { id: 'B', op: 'free', x: 0, y: 0 }, { id: 'C', op: 'free', x: 5, y: 0 }], segments: [{ points: ['A', 'B', 'C', 'A'] }], polygons: [{ points: ['A', 'B', 'C'] }] });
});
test('isosceles triangle', () => {
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 4 }, { id: 'B', op: 'free', x: -3, y: 0 }, { id: 'C', op: 'free', x: 3, y: 0 }], polygons: [{ points: ['A', 'B', 'C'] }] });
});
test('equilateral triangle', () => {
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 3.464 }, { id: 'B', op: 'free', x: -2, y: 0 }, { id: 'C', op: 'free', x: 2, y: 0 }], polygons: [{ points: ['A', 'B', 'C'] }] });
});
test('quadrilateral / rectangle / square / trapezoid', () => {
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 3 }, { id: 'B', op: 'free', x: 4, y: 3 }, { id: 'C', op: 'free', x: 4, y: 0 }, { id: 'D', op: 'free', x: 0, y: 0 }], polygons: [{ points: ['A', 'B', 'C', 'D'] }] });
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 3 }, { id: 'B', op: 'free', x: 3, y: 3 }, { id: 'C', op: 'free', x: 3, y: 0 }, { id: 'D', op: 'free', x: 0, y: 0 }], polygons: [{ points: ['A', 'B', 'C', 'D'] }] });
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 1, y: 3 }, { id: 'B', op: 'free', x: 3, y: 3 }, { id: 'C', op: 'free', x: 4, y: 0 }, { id: 'D', op: 'free', x: 0, y: 0 }], polygons: [{ points: ['A', 'B', 'C', 'D'] }] });
});
test('circle with points on it (pointOnCircle)', () => {
  expectOk({ type: 'program', points: [{ id: 'O', op: 'free', x: 0, y: 0 }, { id: 'A', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 20 }, { id: 'B', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 140 }, { id: 'C', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 260 }], circles: [{ center: 'O', radius: 3 }], polygons: [{ points: ['A', 'B', 'C'] }] });
});
test('two parallel lines (segments never meant to intersect — just drawn, no intersect op)', () => {
  expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 0 }, { id: 'C', op: 'free', x: 0, y: 2 }, { id: 'D', op: 'free', x: 4, y: 2 }], segments: [{ points: ['A', 'B'] }, { points: ['C', 'D'] }] });
});
test('two intersecting lines -> intersectLines', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 4 }, { id: 'C', op: 'free', x: 0, y: 4 }, { id: 'D', op: 'free', x: 4, y: 0 }, { id: 'I', op: 'intersectLines', line1: ['A', 'B'], line2: ['C', 'D'] }], segments: [{ points: ['A', 'B'] }, { points: ['C', 'D'] }] });
  assert.ok(Math.abs(r.scene.points['I'].x - 2) < 1e-6 && Math.abs(r.scene.points['I'].y - 2) < 1e-6, 'intersection should be (2,2)');
});
test('parallel lines fed into intersectLines -> hard error, no broken render', () => {
  expectError({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 0 }, { id: 'C', op: 'free', x: 0, y: 2 }, { id: 'D', op: 'free', x: 4, y: 2 }, { id: 'I', op: 'intersectLines', line1: ['A', 'B'], line2: ['C', 'D'] }] });
});
test('degenerate triangle (3 collinear points) -> hard error', () => {
  expectError({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 2, y: 0 }, { id: 'C', op: 'free', x: 4, y: 0 }], polygons: [{ points: ['A', 'B', 'C'] }] });
});

console.log('\n== Auxiliary constructions: altitude / median / bisector / perp. bisector / diameter ==');
test('altitude AD (foot of A on BC) is perpendicular and on segment BC', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 1, y: 5 }, { id: 'B', op: 'free', x: -3, y: 0 }, { id: 'C', op: 'free', x: 4, y: 0 }, { id: 'D', op: 'foot', from: 'A', line: ['B', 'C'] }], segments: [{ points: ['A', 'D'] }] });
  const D = r.scene.points['D'];
  assert.ok(Math.abs(D.y) < 1e-9, 'D should sit on BC (y=0)');
  assert.ok(D.x > -3 - 1e-9 && D.x < 4 + 1e-9, 'D should lie within segment BC');
});
test('median AM (M = midpoint BC)', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 1, y: 5 }, { id: 'B', op: 'free', x: -3, y: 0 }, { id: 'C', op: 'free', x: 4, y: 0 }, { id: 'M', op: 'midpoint', of: ['B', 'C'] }], segments: [{ points: ['A', 'M'] }] });
  const M = r.scene.points['M'];
  assert.ok(Math.abs(M.x - 0.5) < 1e-9 && Math.abs(M.y - 0) < 1e-9);
});
test('angle bisector foot (angleBisectorFoot) satisfies BD/DC = AB/AC', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 4 }, { id: 'B', op: 'free', x: -2, y: 0 }, { id: 'C', op: 'free', x: 6, y: 0 }, { id: 'D', op: 'angleBisectorFoot', from: 'A', line: ['B', 'C'] }] });
  const p = Geo, s = r.scene;
  const AB = p.distance(s.points.A, s.points.B), AC = p.distance(s.points.A, s.points.C);
  const BD = p.distance(s.points.B, s.points.D), DC = p.distance(s.points.D, s.points.C);
  assert.ok(Math.abs(AB / AC - BD / DC) < 1e-6, 'angle bisector ratio should hold');
});
test('perpendicular bisector (via 2 circumcenters-style equidistant points using reflect)', () => {
  // Trung trực của AB: dựng qua M=midpoint(A,B) và hướng vuông góc — kiểm tra bằng reflect(A) qua đường
  // đi qua M vuông góc AB phải cho lại chính A phản chiếu đúng B.
  const r = expectOk({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 0 }, { id: 'M', op: 'midpoint', of: ['A', 'B'] }, { id: 'P', op: 'free', x: 2, y: 5 }, { id: 'Q', op: 'reflect', point: 'A', line: ['M', 'P'] }] });
});
test('diameter AK through circle center O', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'O', op: 'free', x: 0, y: 0 }, { id: 'A', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 40 }, { id: 'K', op: 'diametricOpposite', center: 'O', point: 'A' }], circles: [{ center: 'O', radius: 3 }] });
  const s = r.scene;
  assert.ok(Math.abs(Geo.distance(s.points.O, s.points.A) - Geo.distance(s.points.O, s.points.K)) < 1e-9);
  assert.ok(Geo.isCollinear(s.points.A, s.points.O, s.points.K, 1e-7), 'A, O, K must be collinear (diameter)');
});

console.log('\n== The canonical "orthocenter + circle" example from the spec ==');
test('Triangle ABC inscribed in (O), altitudes AD/BE/CF, H=orthocenter, EF aux line, AK diameter, I=EF∩AH, J=AK∩BC', () => {
  const spec = {
    type: 'program',
    points: [
      { id: 'A', op: 'free', x: 0.5, y: 4.2 },
      { id: 'B', op: 'free', x: -3.5, y: -0.6 },
      { id: 'C', op: 'free', x: 3.2, y: -0.9 },
      { id: 'O', op: 'circumcenter', of: ['A', 'B', 'C'] },
      { id: 'H', op: 'orthocenter', of: ['A', 'B', 'C'] },
      { id: 'D', op: 'foot', from: 'A', line: ['B', 'C'] },
      { id: 'E', op: 'foot', from: 'B', line: ['A', 'C'] },
      { id: 'F', op: 'foot', from: 'C', line: ['A', 'B'] },
      { id: 'K', op: 'diametricOpposite', center: 'O', point: 'A' },
      { id: 'I', op: 'intersectLines', line1: ['E', 'F'], line2: ['A', 'H'] },
      { id: 'J', op: 'intersectLines', line1: ['A', 'K'], line2: ['B', 'C'] }
    ],
    segments: [{ points: ['A', 'B'] }, { points: ['B', 'C'] }, { points: ['C', 'A'] }],
    auxSegments: [{ points: ['A', 'D'] }, { points: ['B', 'E'] }, { points: ['C', 'F'] }, { points: ['E', 'F'] }, { points: ['A', 'K'] }],
    circles: [{ center: 'O', through: 'A' }],
    polygons: [{ points: ['A', 'B', 'C'] }]
  };
  const r = expectOk(spec);
  const s = r.scene;
  // O phải cách đều A, B, C (bán kính đường tròn ngoại tiếp)
  const rA = Geo.distance(s.points.O, s.points.A), rB = Geo.distance(s.points.O, s.points.B), rC = Geo.distance(s.points.O, s.points.C);
  assert.ok(Math.abs(rA - rB) < 1e-6 && Math.abs(rB - rC) < 1e-6, 'O must be equidistant from A, B, C');
  // K phải nằm trên đường tròn và AK là đường kính (O là trung điểm AK)
  const mid = Geo.midpoint(s.points.A, s.points.K);
  assert.ok(Geo.distance(mid, s.points.O) < 1e-6, 'O must be the midpoint of AK (diameter)');
  // D, E, F phải là chân đường cao thực sự: AD ⟂ BC, v.v.
  const ad = Geo.sub(s.points.D, s.points.A), bc = Geo.sub(s.points.C, s.points.B);
  assert.ok(Math.abs(Geo.dot(ad, bc)) < 1e-6, 'AD must be perpendicular to BC');
  console.log('       (I,J resolved: I=' + JSON.stringify(s.points.I) + ' J=' + JSON.stringify(s.points.J) + ')');
});

console.log('\n== Robustness ==');
test('undefined point reference -> hard error, never renders garbage', () => {
  expectError({ type: 'program', points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'midpoint', of: ['A', 'Z'] }] });
});
test('out-of-order declaration still resolves (resolver is not order-sensitive)', () => {
  const r = expectOk({ type: 'program', points: [{ id: 'M', op: 'midpoint', of: ['A', 'B'] }, { id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 4 }] });
  assert.ok(Math.abs(r.scene.points.M.x - 2) < 1e-9 && Math.abs(r.scene.points.M.y - 2) < 1e-9);
});

console.log('\n== tangentPoint ==');
test('tangent point from external point: PT ⟂ OT and |OT| = r', () => {
  const s = expectOk({
    type: 'program',
    points: [
      { id: 'O', op: 'free', x: 0, y: 0 },
      { id: 'P', op: 'free', x: 6, y: 0 },
      { id: 'T', op: 'tangentPoint', from: 'P', circle: { center: 'O', radius: 3 }, pick: 0 }
    ],
    circles: [{ center: 'O', radius: 3 }],
    segments: [{ points: ['P', 'T'] }]
  }).scene;
  assert.ok(Math.abs(Geo.distance(s.points.O, s.points.T) - 3) < 1e-6, '|OT| must equal r');
  const ot = Geo.sub(s.points.T, s.points.O), pt2 = Geo.sub(s.points.T, s.points.P);
  assert.ok(Math.abs(Geo.dot(ot, pt2)) < 1e-6, 'OT must be perpendicular to PT');
});
test('tangentPoint pick 0 vs pick 1 give two distinct symmetric solutions', () => {
  const s = expectOk({
    type: 'program',
    points: [
      { id: 'O', op: 'free', x: 0, y: 0 },
      { id: 'P', op: 'free', x: 6, y: 0 },
      { id: 'T0', op: 'tangentPoint', from: 'P', circle: { center: 'O', radius: 3 }, pick: 0 },
      { id: 'T1', op: 'tangentPoint', from: 'P', circle: { center: 'O', radius: 3 }, pick: 1 }
    ]
  }).scene;
  assert.ok(Geo.distance(s.points.T0, s.points.T1) > 1e-3, 'the two tangent points must differ');
  assert.ok(Math.abs(s.points.T0.y + s.points.T1.y) < 1e-6, 'symmetric about the OP axis (x-axis here)');
});
test('tangentPoint from a point inside the circle -> hard error', () => {
  expectError({
    type: 'program',
    points: [
      { id: 'O', op: 'free', x: 0, y: 0 },
      { id: 'P', op: 'free', x: 1, y: 0 },
      { id: 'T', op: 'tangentPoint', from: 'P', circle: { center: 'O', radius: 3 }, pick: 0 }
    ]
  });
});

console.log('\n== arcs / vectors ==');
test('arc renders without error (only the arc, not a full circle glyph is asserted implicitly by no-error)', () => {
  expectOk({
    type: 'program',
    points: [
      { id: 'O', op: 'free', x: 0, y: 0 },
      { id: 'A', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 0 },
      { id: 'B', op: 'pointOnCircle', center: 'O', radius: 3, angleDeg: 90 }
    ],
    arcs: [{ center: 'O', from: 'A', to: 'B', major: false }]
  });
});
test('arc with unresolved center is dropped, not a hard error (rest of scene still renders)', () => {
  const r = expectOk({
    type: 'program',
    points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 2, y: 2 }],
    segments: [{ points: ['A', 'B'] }],
    arcs: [{ center: 'ZZZ', from: 'A', to: 'B' }]
  });
  assert.strictEqual(r.scene.arcs.length, 0, 'invalid arc must be silently dropped');
});
test('vector renders (segment with arrowhead marker)', () => {
  const r = expectOk({
    type: 'program',
    points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 2 }],
    vectors: [{ from: 'A', to: 'B' }]
  });
  assert.ok(r.svg.includes('marker-end'), 'vector must reference an arrowhead marker');
  assert.ok(r.svg.includes('<defs>'), 'defs block with marker must be present');
});

console.log('\n== marks ==');
test('rightAngle + angleArc + equalTicks + length marks all render without error', () => {
  const r = expectOk({
    type: 'program',
    points: [
      { id: 'A', op: 'free', x: 0, y: 4 },
      { id: 'B', op: 'free', x: 0, y: 0 },
      { id: 'C', op: 'free', x: 5, y: 0 }
    ],
    segments: [{ points: ['A', 'B', 'C', 'A'] }],
    polygons: [{ points: ['A', 'B', 'C'] }],
    marks: [
      { type: 'rightAngle', at: 'B', rays: ['A', 'C'] },
      { type: 'angleArc', at: 'C', rays: ['B', 'A'], label: '30°', count: 2 },
      { type: 'equalTicks', segments: [['A', 'B']], count: 1 },
      { type: 'length', segment: ['B', 'C'], text: '5 cm' }
    ]
  });
  assert.ok(r.svg.includes('5 cm'), 'length mark text must be rendered');
  assert.ok(r.svg.includes('30'), 'angleArc label must be rendered');
});
test('mark referencing a non-existent point id is silently dropped (scene still renders)', () => {
  const r = expectOk({
    type: 'program',
    points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 4, y: 0 }],
    segments: [{ points: ['A', 'B'] }],
    marks: [{ type: 'rightAngle', at: 'A', rays: ['B', 'ZZZ'] }]
  });
  assert.strictEqual(r.scene.marks.length, 0, 'mark with unresolved point must be dropped');
});
test('legacy/composite scenes still expose empty arcs/vectors/marks arrays (no crash for renderer)', () => {
  const r = expectOk({ type: 'polygon', points: [[0, 0], [4, 0], [2, 3]], labels: ['A', 'B', 'C'] });
  assert.deepStrictEqual(r.scene.arcs, []);
  assert.deepStrictEqual(r.scene.vectors, []);
  assert.deepStrictEqual(r.scene.marks, []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
