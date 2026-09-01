'use strict';

/* =====================================================================
   Vẽ hình học không gian 3D (dùng three.js r128) cho các khối JSON
   ```solid3d {...}``` mà AI chèn vào lời giải. Xoay được bằng chuột/chạm,
   tự xoay nhẹ khi không tương tác để "sống động" hơn — không phụ thuộc
   OrbitControls (không có sẵn ở three.js r128) để tránh lỗi CDN/version.
   ===================================================================== */

const ACTIVE_3D = []; // theo dõi renderer đang chạy để tránh rò rỉ context WebGL khi có quá nhiều khối vẽ trong 1 phiên
const MAX_ACTIVE_3D = 6;

function disposeSolid3D(entry) {
  try {
    cancelAnimationFrame(entry.raf);
    entry.renderer.dispose();
    entry.renderer.forceContextLoss && entry.renderer.forceContextLoss();
  } catch (e) { /* ignore */ }
}

function buildGeometryAndVertices(spec) {
  const THREE_ = window.THREE;
  const type = spec.type;
  let geometry = null;
  let vertices = []; // các điểm [x,y,z] để đặt nhãn (đỉnh của khối)

  function num(v, def) { const n = Number(v); return isFinite(n) && n > 0 ? n : def; }

  if (type === 'cuboid' || type === 'cube') {
    const a = num(spec.a, 4);
    const b = type === 'cube' ? a : num(spec.b, 3);
    const c = type === 'cube' ? a : num(spec.c, 2.5);
    geometry = new THREE_.BoxGeometry(a, c, b);
    vertices = [
      [-a / 2, -c / 2, -b / 2], [a / 2, -c / 2, -b / 2], [a / 2, -c / 2, b / 2], [-a / 2, -c / 2, b / 2],
      [-a / 2, c / 2, -b / 2], [a / 2, c / 2, -b / 2], [a / 2, c / 2, b / 2], [-a / 2, c / 2, b / 2]
    ];
  } else if (type === 'pyramid') {
    const base = spec.base || 'square';
    const height = num(spec.height, 5);
    let sides = 4;
    let radius;
    if (base === 'triangle') { sides = 3; radius = num(spec.baseSize, 4) / Math.sqrt(3); }
    else if (base === 'rectangle' && spec.baseSize && typeof spec.baseSize === 'object') {
      const a = num(spec.baseSize.a, 4), b = num(spec.baseSize.b, 3);
      radius = Math.sqrt(a * a + b * b) / 2;
    } else { sides = 4; radius = num(spec.baseSize, 4) * Math.SQRT2 / 2; }
    geometry = new THREE_.ConeGeometry(radius, height, sides);
    geometry.rotateY(Math.PI / sides + Math.PI / 4);
    const apex = [0, height / 2, 0];
    vertices = [apex];
    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2 + Math.PI / sides + Math.PI / 4;
      vertices.push([radius * Math.cos(ang), -height / 2, radius * Math.sin(ang)]);
    }
  } else if (type === 'prism') {
    const base = spec.base || 'triangle';
    const height = num(spec.height, 5);
    const sidesMap = { triangle: 3, square: 4, rectangle: 4, hexagon: 6 };
    const sides = sidesMap[base] || 3;
    const radius = num(spec.baseSize, 4) / (base === 'triangle' ? Math.sqrt(3) : (base === 'hexagon' ? 1 : Math.SQRT2 / 2));
    geometry = new THREE_.CylinderGeometry(radius, radius, height, sides);
    vertices = [];
    for (const y of [-height / 2, height / 2]) {
      for (let i = 0; i < sides; i++) {
        const ang = (i / sides) * Math.PI * 2 + Math.PI / sides;
        vertices.push([radius * Math.cos(ang), y, radius * Math.sin(ang)]);
      }
    }
  } else if (type === 'cone') {
    const radius = num(spec.radius, 3), height = num(spec.height, 5);
    geometry = new THREE_.ConeGeometry(radius, height, 32);
    vertices = [[0, height / 2, 0], [radius, -height / 2, 0]];
  } else if (type === 'cylinder') {
    const radius = num(spec.radius, 3), height = num(spec.height, 5);
    geometry = new THREE_.CylinderGeometry(radius, radius, height, 32);
    vertices = [[radius, -height / 2, 0], [radius, height / 2, 0]];
  } else if (type === 'sphere') {
    const radius = num(spec.radius, 3);
    geometry = new THREE_.SphereGeometry(radius, 28, 20);
    vertices = [[0, radius, 0], [0, -radius, 0]];
  }

  return { geometry, vertices };
}

function makeLabelSprite(text) {
  const THREE_ = window.THREE;
  const canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.font = '700 54px Sora, Inter, sans-serif';
  ctx.fillStyle = '#e7ecf7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.85)';
  ctx.shadowBlur = 8;
  ctx.fillText(String(text), 48, 50);
  const tex = new THREE_.CanvasTexture(canvas);
  const mat = new THREE_.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE_.Sprite(mat);
  sprite.scale.set(0.7, 0.7, 0.7);
  return sprite;
}

function drawSolid3D(container, spec) {
  if (!container || !window.THREE) return;
  const THREE_ = window.THREE;

  const { geometry, vertices } = buildGeometryAndVertices(spec || {});
  if (!geometry) {
    container.innerHTML = '<p style="color:#c0392b;font-size:12px;">⚠️ Không nhận dạng được loại khối hình học không gian.</p>';
    return;
  }

  // Giới hạn số canvas 3D đang hoạt động cùng lúc để tránh hết WebGL context
  while (ACTIVE_3D.length >= MAX_ACTIVE_3D) disposeSolid3D(ACTIVE_3D.shift());

  const isMobile = window.innerWidth < 620;
  const W = Math.min(container.clientWidth || 480, 480);
  const H = isMobile ? 230 : 300;

  const scene = new THREE_.Scene();
  const camera = new THREE_.PerspectiveCamera(42, W / H, 0.1, 100);
  const renderer = new THREE_.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.margin = '0 auto';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.cursor = 'grab';
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const dark = document.getElementById('main').getAttribute('data-theme') === 'dark';
  const primaryColor = 0x2955ff;

  scene.add(new THREE_.AmbientLight(0xffffff, dark ? 0.65 : 0.8));
  const dir = new THREE_.DirectionalLight(0xffffff, 0.65);
  dir.position.set(4, 6, 5);
  scene.add(dir);

  const mesh = new THREE_.Mesh(geometry, new THREE_.MeshStandardMaterial({
    color: primaryColor, transparent: true, opacity: 0.32, roughness: 0.55, metalness: 0.05, side: THREE_.DoubleSide
  }));
  scene.add(mesh);

  const edges = new THREE_.EdgesGeometry(geometry, 20);
  const line = new THREE_.LineSegments(edges, new THREE_.LineBasicMaterial({ color: dark ? 0x8fb4ff : 0x1c3fd4, linewidth: 1.5 }));
  scene.add(line);

  const labelGroup = new THREE_.Group();
  const labels = spec.labels;
  if (Array.isArray(labels) && labels.length) {
    vertices.forEach((v, i) => {
      if (!labels[i]) return;
      const sprite = makeLabelSprite(labels[i]);
      const len = Math.hypot(v[0], v[1], v[2]) || 1;
      sprite.position.set(v[0] * 1.14, v[1] * 1.14 + (v[1] >= 0 ? 0.25 : -0.25), v[2] * 1.14);
      labelGroup.add(sprite);
    });
  }
  scene.add(labelGroup);

  // Kích thước khối để đặt camera vừa khung hình
  geometry.computeBoundingSphere();
  const radius = (geometry.boundingSphere && geometry.boundingSphere.radius) || 4;
  let dist = radius * 2.6 + 1.5;

  let theta = Math.PI / 4.2; // góc phương vị
  let phi = Math.PI / 2.7;   // góc nâng
  function updateCamera() {
    camera.position.set(
      dist * Math.sin(phi) * Math.sin(theta),
      dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, 0, 0);
  }
  updateCamera();

  // ---- Xoay bằng chuột / chạm ----
  let dragging = false, lastX = 0, lastY = 0, autoRotate = true, idleTimer = null;
  const el = renderer.domElement;
  function pointerDown(x, y) { dragging = true; lastX = x; lastY = y; autoRotate = false; el.style.cursor = 'grabbing'; clearTimeout(idleTimer); }
  function pointerMove(x, y) {
    if (!dragging) return;
    theta -= (x - lastX) * 0.008;
    phi = Math.max(0.25, Math.min(Math.PI - 0.25, phi - (y - lastY) * 0.008));
    lastX = x; lastY = y;
    updateCamera();
  }
  function pointerUp() {
    dragging = false; el.style.cursor = 'grab';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { autoRotate = true; }, 2200);
  }
  el.addEventListener('mousedown', (e) => pointerDown(e.clientX, e.clientY));
  window.addEventListener('mousemove', (e) => pointerMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', pointerUp);
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; pointerDown(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.touches[0]; pointerMove(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchend', pointerUp);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.max(radius * 1.4, Math.min(radius * 6, dist + e.deltaY * 0.01 * radius * 0.15));
    updateCamera();
  }, { passive: false });

  const entry = { renderer, raf: null };
  function animate() {
    entry.raf = requestAnimationFrame(animate);
    if (autoRotate) { theta += 0.0035; updateCamera(); }
    renderer.render(scene, camera);
  }
  animate();
  ACTIVE_3D.push(entry);

  // Ngưng render khi phần tử bị xoá khỏi DOM (tránh vòng lặp chạy vô ích/leak)
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      disposeSolid3D(entry);
      const idx = ACTIVE_3D.indexOf(entry);
      if (idx >= 0) ACTIVE_3D.splice(idx, 1);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const hint = document.createElement('div');
  hint.className = 'draw-legend';
  hint.textContent = '🖱️ Kéo để xoay · cuộn để phóng to/thu nhỏ mô hình 3D';
  container.appendChild(hint);
}

window.drawSolid3D = drawSolid3D;
