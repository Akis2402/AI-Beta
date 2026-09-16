'use strict';

/* =====================================================================================
   scene3d.js — PHẦN J..S (nâng cấp 3D engine)
   ---------------------------------------------------------------------------------------
   Bổ sung SONG SONG với solid3d.js hiện có (KHÔNG xoá/thay solid3d.js — các khối
   ```solid3d``` cũ tiếp tục hoạt động y nguyên, tránh phá vỡ hành vi đang chạy tốt).

   Khối mới:
     ```scene3d {...}```   -> renderScene3D(container, sceneSpec)   (PHẦN K)
     ```scenepatch {...}``` -> áp patch lên scene đang có, KHÔNG cần gửi lại full scene (PHẦN L)

   Nguyên tắc PHẦN J/M: AI chỉ phát sinh JSON mô tả (spec ngắn) — renderer tự dựng hình học
   bằng THREE.*Geometry (procedural), KHÔNG bao giờ nhận vertex-list lớn hay code Three.js
   từ AI.

   Hỗ trợ object types (PHẦN J/N):
     cube/box, sphere, cylinder, cone, pyramid, prism  (tái dùng buildPrimitiveGeometryAndVertices
       từ solid3d.js nếu có sẵn — tránh trùng lặp code dựng khối)
     pt   (point)      {"t":"pt","p":[x,y,z],"l":"A"}
     line/seg          {"t":"line"|"seg","p":[[x,y,z],[x,y,z]],"l":"AB"}
     vec  (vector)     {"t":"vec","o":[x,y,z],"d":[dx,dy,dz],"l":"AB"}
     plane             {"t":"plane","eq":[a,b,c,d],"r":[-3,3]}   // ax+by+cz=d
     surf (z=f(x,y))   {"t":"surf","eq":"x*x+y*y","r":[-3,3],"n":32}  (PHẦN N)
     axes / grid / Oxyz-> {"t":"axes"} {"t":"grid"} luôn bật mặc định trừ khi tắt rõ ràng.

   Quality tiers (PHẦN O): High / Medium / Low — tự chọn theo thiết bị (mobile => giảm), có
   thể ép bằng window.SCENE3D_FORCE_QUALITY = 'low'|'medium'|'high'.

   WebGL fallback (PHẦN O): nếu WebGL không khả dụng, hiển thị mô tả 2D/text — KHÔNG bao giờ
   làm hỏng luồng trả lời AI (renderer lỗi không chặn phần còn lại của response).

   0 AI request cho tương tác (PHẦN P): orbit/zoom/pan/select/hover/label/reset/fit/fullscreen/
   axes/grid toggle đều xử lý thuần client, không gọi API.
   ===================================================================================== */

const SCENE3D_ACTIVE = [];
const SCENE3D_MAX_ACTIVE = 6;

// Các loại KHỐI RẮN mà scene3d nhúng lại từ solid3d.js (PHẦN J/M). Khai tường minh để:
//   (1) type sai chính tả không âm thầm cho ra nhóm rỗng ("hình biến mất" không rõ lý do);
//   (2) khớp đúng danh sách đã dạy AI trong promptBuilder.js và danh sách validator server kiểm.
const SCENE3D_SOLID_TYPES = new Set(['cube', 'box', 'sphere', 'cylinder', 'cone', 'pyramid', 'prism']);
// Các loại đối tượng hình học Oxyz do CHÍNH scene3d.js dựng (điểm/đường/vector/mặt phẳng/mặt cong).
const SCENE3D_GEOM_TYPES = new Set(['pt', 'line', 'seg', 'vec', 'plane', 'surf', 'axes', 'grid']);

function scene3dDetectQuality() {
  if (window.SCENE3D_FORCE_QUALITY) return window.SCENE3D_FORCE_QUALITY;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  const lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const smallScreen = Math.min(window.innerWidth || 1024, window.innerHeight || 768) < 480;
  if (isMobile && (lowMem || smallScreen)) return 'low';
  if (isMobile) return 'medium';
  return 'high';
}

const SCENE3D_QUALITY_PRESETS = {
  high: { pixelRatioCap: 2, antialias: true, shadows: true, surfaceN: 48 },
  medium: { pixelRatioCap: 1.5, antialias: true, shadows: false, surfaceN: 28 },
  low: { pixelRatioCap: 1, antialias: false, shadows: false, surfaceN: 14 }
};

function scene3dWebGLAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (e) { return false; }
}

function scene3dRenderFallback(container, sceneSpec) {
  const objs = (sceneSpec && sceneSpec.objs) || [];
  const lines = objs.map((o) => {
    const t = window.t ? window.t('scene3d.obj.' + o.t, { defaultValue: o.t }) : o.t;
    const label = o.l ? ` "${o.l}"` : '';
    return `• ${t}${label}`;
  });
  const title = window.t ? window.t('scene3d.fallbackTitle') : 'Mô tả hình học (không hỗ trợ WebGL trên thiết bị này)';
  container.innerHTML = `<div class="scene3d-fallback"><p style="font-weight:600;margin:0 0 6px;">${title}</p><ul style="margin:0;padding-left:18px;font-size:13px;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
}

function scene3dNum(v, def) { const n = Number(v); return isFinite(n) ? n : def; }

function scene3dLabelSprite(text) {
  const THREE_ = window.THREE;
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 34px Arial';
  ctx.fillStyle = '#1c2333';
  ctx.textAlign = 'center';
  ctx.fillText(text, 80, 42);
  const tex = new THREE_.CanvasTexture(canvas);
  const mat = new THREE_.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE_.Sprite(mat);
  sprite.scale.set(1.4, 0.56, 1);
  return sprite;
}

// Chuyển hệ toạ độ toán học [x,y,z] (z lên) -> hệ three.js (y lên) — nhất quán với solid3d.js
function scene3dToThree(p) { return [p[0], p[2], p[1]]; }

function scene3dBuildAxes(group, THREE_, range) {
  const r = range || 5;
  const mkLine = (from, to, color) => {
    const geo = new THREE_.BufferGeometry().setFromPoints([
      new THREE_.Vector3(...scene3dToThree(from)), new THREE_.Vector3(...scene3dToThree(to))
    ]);
    const mat = new THREE_.LineBasicMaterial({ color });
    return new THREE_.Line(geo, mat);
  };
  group.add(mkLine([-r, 0, 0], [r, 0, 0], 0xd23f3f)); // Ox
  group.add(mkLine([0, -r, 0], [0, r, 0], 0x2e9e4c)); // Oy
  group.add(mkLine([0, 0, -r], [0, 0, r], 0x3b6fd6)); // Oz
  const labels = [['x', [r + 0.4, 0, 0]], ['y', [0, r + 0.4, 0]], ['z', [0, 0, r + 0.4]]];
  labels.forEach(([txt, pos]) => {
    const s = scene3dLabelSprite(txt);
    s.position.set(...scene3dToThree(pos));
    s.scale.set(0.5, 0.5, 1);
    group.add(s);
  });
}

function scene3dBuildGrid(group, THREE_, size) {
  const g = new THREE_.GridHelper(size || 10, (size || 10), 0xcccccc, 0xe6e6e6);
  group.add(g);
}

function scene3dBuildVector(group, THREE_, o, d, color, label) {
  const origin = new THREE_.Vector3(...scene3dToThree(o));
  const dirRaw = new THREE_.Vector3(d[0], d[2], d[1]);
  const len = dirRaw.length() || 0.0001;
  const dir = dirRaw.clone().normalize();
  const arrow = new THREE_.ArrowHelper(dir, origin, len, color, Math.min(0.3, len * 0.2), Math.min(0.18, len * 0.15));
  group.add(arrow);
  if (label) {
    const s = scene3dLabelSprite(label);
    const tip = origin.clone().add(dirRaw);
    s.position.copy(tip).add(new THREE_.Vector3(0.15, 0.15, 0));
    group.add(s);
  }
}

function scene3dSampleSurface(THREE_, eqStr, rangeArr, n) {
  // eslint-disable-next-line no-new-func
  let fn;
  try {
    // Chỉ cho phép biểu thức toán học đơn giản qua Math.* — không eval tuỳ ý mã người dùng gửi lên
    // vì spec 'eq' luôn do backend/AI sinh (không phải input thô người dùng), nhưng vẫn giới hạn
    // whitelist ký tự để phòng thủ theo chiều sâu.
    if (!/^[\d\s.+\-*/^()xy,a-zA-Z]*$/.test(eqStr)) throw new Error('unsafe expr');
    const safe = eqStr.replace(/\^/g, '**');
    // eslint-disable-next-line no-new-func
    fn = new Function('x', 'y', 'Math', `with(Math){ return (${safe}); }`);
  } catch (e) {
    return null;
  }
  const [lo, hi] = Array.isArray(rangeArr) && rangeArr.length === 2 ? rangeArr : [-3, 3];
  const steps = Math.max(6, Math.min(64, n || 24));
  const geo = new THREE_.BufferGeometry();
  const positions = [];
  const indices = [];
  const step = (hi - lo) / steps;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = lo + i * step;
      const y = lo + j * step;
      let z;
      try { z = fn(x, y, Math); } catch (e) { z = 0; }
      if (!isFinite(z)) z = 0;
      // toạ độ three: (x, z_math, y)
      positions.push(x, z, y);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const a = i * (steps + 1) + j;
      const b = a + 1;
      const c = a + (steps + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE_.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function scene3dBuildObject(THREE_, spec, quality) {
  const t = spec.t;
  const group = new THREE_.Group();
  const color = spec.c ? Number(spec.c) : 0x3b6fd6;

  if (t === 'pt') {
    const geo = new THREE_.SphereGeometry(0.08, 12, 12);
    const mat = new THREE_.MeshStandardMaterial({ color: 0xe0533d });
    const m = new THREE_.Mesh(geo, mat);
    m.position.set(...scene3dToThree(spec.p || [0, 0, 0]));
    group.add(m);
    if (spec.l) {
      const s = scene3dLabelSprite(spec.l);
      s.position.set(...scene3dToThree(spec.p || [0, 0, 0])).add ? null : null;
      s.position.set(m.position.x + 0.18, m.position.y + 0.18, m.position.z);
      group.add(s);
    }
    return group;
  }
  if (t === 'line' || t === 'seg') {
    const pts = (spec.p || []).map((p) => new THREE_.Vector3(...scene3dToThree(p)));
    const geo = new THREE_.BufferGeometry().setFromPoints(pts);
    const mat = new THREE_.LineBasicMaterial({ color });
    group.add(new THREE_.Line(geo, mat));
    if (spec.l && pts.length) {
      const mid = pts[0].clone().add(pts[pts.length - 1]).multiplyScalar(0.5);
      const s = scene3dLabelSprite(spec.l);
      s.position.copy(mid).add(new THREE_.Vector3(0, 0.2, 0));
      group.add(s);
    }
    return group;
  }
  if (t === 'vec') {
    scene3dBuildVector(group, THREE_, spec.o || [0, 0, 0], spec.d || [1, 0, 0], color, spec.l);
    return group;
  }
  if (t === 'plane') {
    const [a, b, c, d] = spec.eq || [0, 0, 1, 0];
    const size = (spec.r && (spec.r[1] - spec.r[0])) || 6;
    const geo = new THREE_.PlaneGeometry(size, size, 1, 1);
    const mat = new THREE_.MeshStandardMaterial({ color: 0x8fb8ff, opacity: 0.45, transparent: true, side: THREE_.DoubleSide });
    const mesh = new THREE_.Mesh(geo, mat);
    // Định hướng plane theo pháp tuyến (a,b,c); mặc định z = (d - a x - b y)/c nếu c != 0
    const normalMath = new THREE_.Vector3(a, b, c).normalize();
    const normalThree = new THREE_.Vector3(normalMath.x, normalMath.z, normalMath.y);
    mesh.lookAt(normalThree);
    if (Math.abs(c) > 1e-6) mesh.position.set(0, d / c, 0);
    group.add(mesh);
    return group;
  }
  if (t === 'surf') {
    const geo = scene3dSampleSurface(THREE_, spec.eq || 'x*x+y*y', spec.r, Math.min(spec.n || quality.surfaceN, quality.surfaceN));
    if (geo) {
      const mat = new THREE_.MeshStandardMaterial({ color: 0x5aa9e6, side: THREE_.DoubleSide, flatShading: false, metalness: 0.1, roughness: 0.7 });
      group.add(new THREE_.Mesh(geo, mat));
    }
    return group;
  }
  if (t === 'axes') { scene3dBuildAxes(group, THREE_, spec.r || 5); return group; }
  if (t === 'grid') { scene3dBuildGrid(group, THREE_, spec.size || 10); return group; }

  // Khối rắn (cube/box/sphere/cylinder/cone/pyramid/prism): tái dùng solid3d.js nếu có, tránh
  // trùng lặp logic dựng geometry (PHẦN M — procedural, không vertex-list lớn). Danh sách được khai
  // TƯỜNG MINH (không "cứ thử fallback cho mọi t lạ") để type sai chính tả từ AI không âm thầm tạo
  // ra nhóm rỗng trông như "hình biến mất" — nhánh cuối hàm sẽ cảnh báo rõ trong console.
  if (SCENE3D_SOLID_TYPES.has(t) && window.buildPrimitiveGeometryAndVertices) {
    const mapped = { ...spec, type: t === 'cube' || t === 'box' ? 'box' : t };
    const built = window.buildPrimitiveGeometryAndVertices(mapped);
    if (built && built.geometry) {
      const mat = new THREE_.MeshStandardMaterial({ color, transparent: true, opacity: 0.85 });
      const mesh = new THREE_.Mesh(built.geometry, mat);
      const wire = new THREE_.LineSegments(new THREE_.EdgesGeometry(built.geometry), new THREE_.LineBasicMaterial({ color: 0x1c2333 }));
      mesh.add(wire);
      if (Array.isArray(spec.p)) mesh.position.set(...scene3dToThree(spec.p));
      group.add(mesh);
      if (spec.l) {
        const s = scene3dLabelSprite(spec.l);
        s.position.copy(mesh.position).add(new THREE_.Vector3(0, 0.6, 0));
        group.add(s);
      }
      return group;
    }
  }
  // Type không thuộc danh sách nào ở trên (AI viết sai chính tả / schema tương lai chưa hỗ trợ):
  // KHÔNG throw (một object lạ không được phép làm chết cả scene và phần còn lại của câu trả lời),
  // nhưng phải log rõ để chẩn đoán được thay vì "hình biến mất" im lặng.
  if (!SCENE3D_GEOM_TYPES.has(t)) console.warn('[scene3d] bỏ qua object có type không hỗ trợ:', t);
  return group;
}
function scene3dDispose(entry) {
  try {
    cancelAnimationFrame(entry.raf);
    entry.renderer.dispose();
    entry.renderer.forceContextLoss && entry.renderer.forceContextLoss();
    window.removeEventListener('keydown', entry.onKeydown);
  } catch (e) { /* ignore */ }
}

/**
 * Render một scene3d spec compact vào container. PHẦN P: orbit/zoom/pan/select/hover/label/
 * reset/fit/fullscreen/axes/grid toggle — tất cả xử lý client, 0 AI request.
 */
function renderScene3D(container, sceneSpec) {
  if (!container) return null;
  if (!scene3dWebGLAvailable() || !window.THREE) {
    scene3dRenderFallback(container, sceneSpec);
    return null;
  }
  try {
    const THREE_ = window.THREE;
    const quality = SCENE3D_QUALITY_PRESETS[scene3dDetectQuality()] || SCENE3D_QUALITY_PRESETS.medium;

    while (SCENE3D_ACTIVE.length >= SCENE3D_MAX_ACTIVE) scene3dDispose(SCENE3D_ACTIVE.shift());

    container.innerHTML = '';
    container.classList.add('scene3d-wrap');
    const toolbar = document.createElement('div');
    toolbar.className = 'scene3d-toolbar';
    const mkBtn = (key, label, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'scene3d-btn'; b.dataset.act = key;
      b.textContent = label; b.title = title || label;
      toolbar.appendChild(b);
      return b;
    };
    const btnReset = mkBtn('reset', '⟲', window.t ? window.t('scene3d.reset') : 'Đặt lại góc nhìn');
    const btnFit = mkBtn('fit', '⤢', window.t ? window.t('scene3d.fit') : 'Vừa khung hình');
    const btnAxes = mkBtn('axes', 'XYZ', window.t ? window.t('scene3d.toggleAxes') : 'Bật/tắt trục toạ độ');
    const btnGrid = mkBtn('grid', '#', window.t ? window.t('scene3d.toggleGrid') : 'Bật/tắt lưới');
    const btnFull = mkBtn('full', '⛶', window.t ? window.t('scene3d.fullscreen') : 'Toàn màn hình');
    container.appendChild(toolbar);

    const canvasHost = document.createElement('div');
    canvasHost.className = 'scene3d-canvas-host';
    container.appendChild(canvasHost);

    const width = canvasHost.clientWidth || 320;
    const height = Math.max(240, Math.min(420, width * 0.72));

    const scene = new THREE_.Scene();
    const camera = new THREE_.PerspectiveCamera(45, width / height, 0.1, 500);
    const camPos = (sceneSpec && sceneSpec.cam) || [6, 5, 7];
    camera.position.set(...scene3dToThree(camPos));
    camera.lookAt(0, 0, 0);

    const renderer = new THREE_.WebGLRenderer({ antialias: quality.antialias, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    renderer.setSize(width, height);
    canvasHost.appendChild(renderer.domElement);

    scene.add(new THREE_.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE_.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(5, 8, 5);
    scene.add(dirLight);

    const objectsGroup = new THREE_.Group();
    scene.add(objectsGroup);
    let axesObj = null, gridObj = null;
    const state = { objs: {}, idCounter: 0 };

    function addObj(spec, id) {
      const g = scene3dBuildObject(THREE_, spec, quality);
      g.userData.__spec = spec;
      objectsGroup.add(g);
      const key = id || ('obj' + (state.idCounter++));
      state.objs[key] = g;
      if (spec.t === 'axes') axesObj = g;
      if (spec.t === 'grid') gridObj = g;
      return key;
    }

    const objs = (sceneSpec && sceneSpec.objs) || [];
    let hasAxes = false, hasGrid = false;
    objs.forEach((o, i) => {
      if (o.t === 'axes') hasAxes = true;
      if (o.t === 'grid') hasGrid = true;
      addObj(o, 'obj' + i);
    });
    if (!hasGrid) addObj({ t: 'grid', size: 10 }, '__autogrid');
    if (!hasAxes) addObj({ t: 'axes', r: 5 }, '__autoaxes');

    // ---- Tương tác: orbit (kéo chuột/chạm để xoay), zoom (wheel/pinch), pan (chuột phải/2 ngón)
    let dragging = false, panning = false, lastX = 0, lastY = 0;
    let rotX = 0.5, rotY = 0.7, dist = new THREE_.Vector3(...scene3dToThree(camPos)).length();
    let target = new THREE_.Vector3(0, 0, 0);
    function updateCamera() {
      const x = target.x + dist * Math.sin(rotY) * Math.cos(rotX);
      const y = target.y + dist * Math.sin(rotX);
      const z = target.z + dist * Math.cos(rotY) * Math.cos(rotX);
      camera.position.set(x, y, z);
      camera.lookAt(target);
    }
    updateCamera();

    function onDown(x, y, isPan) { dragging = !isPan; panning = !!isPan; lastX = x; lastY = y; autoRotate = false; }
    function onMove(x, y) {
      if (!dragging && !panning) return;
      const dx = x - lastX, dy = y - lastY; lastX = x; lastY = y;
      if (dragging) {
        rotY -= dx * 0.008;
        rotX = Math.max(-1.4, Math.min(1.4, rotX + dy * 0.008));
        updateCamera();
      } else if (panning) {
        const panSpeed = dist * 0.0015;
        const right = new THREE_.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE_.Vector3().setFromMatrixColumn(camera.matrix, 1);
        target.addScaledVector(right, -dx * panSpeed).addScaledVector(up, dy * panSpeed);
        updateCamera();
      }
    }
    function onUp() { dragging = false; panning = false; }
    function onWheel(e) { e.preventDefault(); dist = Math.max(1.5, Math.min(60, dist * (1 + e.deltaY * 0.001))); updateCamera(); }

    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY, e.button === 2));
    window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', onWheel, { passive: false });
    let touchMode = null;
    let lastPinchDist = 0;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) { touchMode = 'rotate'; onDown(e.touches[0].clientX, e.touches[0].clientY, false); }
      else if (e.touches.length === 2) {
        touchMode = 'pinch';
        const [a, b] = e.touches;
        lastPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (touchMode === 'rotate' && e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
      else if (touchMode === 'pinch' && e.touches.length === 2) {
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (lastPinchDist) dist = Math.max(1.5, Math.min(60, dist * (lastPinchDist / d)));
        lastPinchDist = d;
        updateCamera();
      }
    }, { passive: true });
    el.addEventListener('touchend', () => { touchMode = null; onUp(); });

    // ---- Select/hover (PHẦN P) — raycast, không gọi AI
    const raycaster = new THREE_.Raycaster();
    const mouseNdc = new THREE_.Vector2();
    let hovered = null;
    function pickAt(clientX, clientY) {
      const rect = el.getBoundingClientRect();
      mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouseNdc, camera);
      const intersects = raycaster.intersectObjects(objectsGroup.children, true);
      return intersects[0] || null;
    }
    el.addEventListener('mousemove', (e) => {
      const hit = pickAt(e.clientX, e.clientY);
      el.style.cursor = hit ? 'pointer' : (dragging ? 'grabbing' : 'grab');
      if (hovered && hovered.material && hovered.material.emissive) hovered.material.emissive.setHex(0x000000);
      if (hit && hit.object.material && hit.object.material.emissive) {
        hit.object.material.emissive.setHex(0x333333);
        hovered = hit.object;
      } else hovered = null;
    });

    // ---- Toolbar actions
    let autoRotate = true;
    btnReset.onclick = () => { rotX = 0.5; rotY = 0.7; dist = new THREE_.Vector3(...scene3dToThree(camPos)).length(); target.set(0, 0, 0); updateCamera(); };
    btnFit.onclick = () => {
      const box = new THREE_.Box3().setFromObject(objectsGroup);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE_.Vector3()).length();
        dist = Math.max(2, size * 1.3);
        box.getCenter(target);
        updateCamera();
      }
    };
    btnAxes.onclick = () => { if (axesObj) axesObj.visible = !axesObj.visible; };
    btnGrid.onclick = () => { if (gridObj) gridObj.visible = !gridObj.visible; };
    btnFull.onclick = () => {
      if (!document.fullscreenElement) container.requestFullscreen ? container.requestFullscreen() : null;
      else document.exitFullscreen && document.exitFullscreen();
    };

    let raf;
    let idleTimer = setTimeout(() => { /* giữ autoRotate ban đầu */ }, 0);
    function animate() {
      if (autoRotate && !dragging && !panning) { rotY += 0.0025; updateCamera(); }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    }
    animate();

    const entry = { renderer, raf: 0 };
    Object.defineProperty(entry, 'raf', { get() { return raf; } });
    SCENE3D_ACTIVE.push(entry);

    // API công khai cho patch (PHẦN L)
    const api = {
      state,
      addObj,
      removeObj(id) { const g = state.objs[id]; if (g) { objectsGroup.remove(g); delete state.objs[id]; } },
      applyPatch(patch) {
        (patch.op || []).forEach((entryOp) => {
          const [op, a, b] = entryOp;
          if (op === 'add') api.addObj(b || a, typeof a === 'string' && b ? a : undefined);
          else if (op === 'del') api.removeObj(a);
          else if (op === 'update') { api.removeObj(a); api.addObj(b, a); }
        });
      }
    };
    container.__scene3dApi = api;
    return api;
  } catch (e) {
    console.error('[scene3d] render lỗi, fallback:', e);
    try { scene3dRenderFallback(container, sceneSpec); } catch (e2) { /* ignore */ }
    return null;
  }
}

/** PHẦN L: áp dụng patch lên container đã render trước đó (không cần gửi lại full scene). */
function applyScenePatchToContainer(container, patch) {
  if (container && container.__scene3dApi) {
    container.__scene3dApi.applyPatch(patch);
    return true;
  }
  return false;
}

window.renderScene3D = renderScene3D;
window.applyScenePatchToContainer = applyScenePatchToContainer;
window.scene3dDetectQuality = scene3dDetectQuality;
