'use strict';
/* =====================================================================================
   akisPoses.js — DỮ LIỆU tư thế của Akis (không chứa logic chuyển động).
   Mỗi pose mô tả "đang làm gì" bằng: biểu cảm (eyes/mouth), đạo cụ hiện ra (props), phần thân bị dời/ẩn (parts),
   và tên vòng lặp chuyển động (loop) được cài trong akisMotion.js.
   Thêm tính năng mới = thêm 1 mục ở đây (+ 1 loop nếu cần), không đụng engine.
   eyes : open | both | happy | closed | hidden        mouth: smile | open | o | flat | sad | grin
   parts: { <id>: { x, y, rotation, scale, scaleX, scaleY, opacity } }  (id = data-k trong akisRig)
   ===================================================================================== */
(function (root) {
  var HIDE_SIDE = { 'note-paper': { opacity: 0, scale: .6 }, bulb: { opacity: 0, scale: .6 } };
  var POSES = {
    /* ---- trạng thái chung (giữ tên cũ để landing/companion/auth không phải đổi API) ---- */
    idle:        { eyes: 'open',   mouth: 'smile', props: [], loop: 'idle' },
    wave:        { eyes: 'happy',  mouth: 'grin',  props: [], loop: 'wave' },
    look:        { eyes: 'open',   mouth: 'smile', props: [], loop: 'idle' },
    peek:        { eyes: 'both',   mouth: 'o',     props: [], parts: { book: { y: 62 }, face: { y: -4 } }, loop: 'peek' },
    'type-email':{ eyes: 'open',   mouth: 'smile', props: ['prop-mail'], hide: ['note-paper'], loop: 'nod' },
    'hide-eyes': { eyes: 'closed', mouth: 'flat',  props: [], parts: { book: { y: -88, scale: 1.04 } }, loop: 'hide' },
    working:     { eyes: 'both',   mouth: 'flat',  props: ['prop-dots', 'prop-question'], loop: 'think' },
    success:     { eyes: 'happy',  mouth: 'grin',  props: ['prop-check', 'prop-hearts'], loop: 'joy' },
    error:       { eyes: 'both',   mouth: 'sad',   props: ['prop-exclaim', 'sweat'], loop: 'shake' },
    sleepy:      { eyes: 'closed', mouth: 'flat',  props: ['prop-zzz'], loop: 'sleep' },
    'point-left':{ eyes: 'open',   mouth: 'smile', props: [], parts: { 'mascot-root': { rotation: -5, x: -12 } }, look: [-1, -0.1], loop: 'point' },
    'point-right':{ eyes: 'open',  mouth: 'smile', props: [], parts: { 'mascot-root': { rotation: 5, x: 12 } },  look: [1, -0.1],  loop: 'point' },
    'hold-card': { eyes: 'open',   mouth: 'smile', props: [], parts: { 'note-paper': { scale: 1.3, x: 34, y: -22 } }, loop: 'idle' },
    'spin-3d':   { eyes: 'both',   mouth: 'o',     props: ['prop-cube'], hide: ['note-paper'], loop: 'spin' },
    celebrate:   { eyes: 'happy',  mouth: 'grin',  props: ['prop-confetti'], loop: 'cheer' },

    /* ---- theo TỪNG TÍNH NĂNG: tạo hình riêng cho thấy tính năng đó đang làm gì ---- */
    hint:      { eyes: 'both', mouth: 'flat',  props: ['glasses', 'prop-question'], loop: 'read',  label: 'Hướng giải: đeo kính đọc sách, tìm gợi ý' },
    solution:  { eyes: 'open', mouth: 'smile', props: ['prop-pencil', 'solution-scribbles'], loop: 'write', label: 'Lời giải chi tiết: cầm bút viết từng bước' },
    sources:   { eyes: 'both', mouth: 'o',     props: ['prop-magnifier', 'prop-cite'], parts: { 'note-paper': { scale: 1.3, x: 30, y: -14 } }, loop: 'scan', label: 'Tài liệu: soi từng dòng, trích nguồn [1]' },
    visual:    { eyes: 'both', mouth: 'o',     props: ['prop-graph', 'prop-cube'], hide: ['note-paper', 'bulb'], loop: 'plot', label: 'Hình minh họa: vẽ đồ thị, xoay khối 3D' },
    flashcard: { eyes: 'open', mouth: 'smile', props: ['prop-flashcard'], hide: ['bulb'], loop: 'flip', label: 'Ôn tập: lật flashcard' },
    formula:   { eyes: 'both', mouth: 'o',     props: ['prop-formula'], hide: ['note-paper', 'bulb'], loop: 'glyphs', label: 'Công thức: tra nhanh theo môn' },
    notes:     { eyes: 'open', mouth: 'smile', props: ['prop-note', 'prop-pencil'], hide: ['note-paper'], loop: 'sticky', label: 'Ghi chú: dán lại điều cần nhớ' },
    history:   { eyes: 'both', mouth: 'smile', props: ['prop-clock'], hide: ['bulb'], loop: 'rewind', label: 'Lịch sử học: quay lại bài đã hỏi' },
    voice:     { eyes: 'happy', mouth: 'open', props: ['prop-mic'], hide: ['note-paper'], loop: 'talk', label: 'Giọng nói: nói thay vì gõ' },
    trust:     { eyes: 'happy', mouth: 'smile', props: ['prop-shield', 'prop-lock', 'prop-meter'], hide: ['bulb', 'note-paper'], loop: 'guard', label: 'Minh bạch: hạn mức rõ, đăng nhập an toàn' },
    tools:     { eyes: 'both', mouth: 'smile', props: [], loop: 'idle', cycle: ['formula', 'notes', 'history', 'voice'], label: 'Công cụ: luân phiên các công cụ' }
  };
  root.AKIS_POSES = POSES;
  root.AKIS_HIDE_SIDE = HIDE_SIDE;
  if (typeof module !== 'undefined' && module.exports) module.exports = POSES;
})(typeof window !== 'undefined' ? window : globalThis);
