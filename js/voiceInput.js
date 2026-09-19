'use strict';

/* =====================================================================================
   voiceInput.js — PHẦN D/F: nhập câu hỏi bằng GIỌNG NÓI.

   NGUYÊN TẮC KIẾN TRÚC (PHẦN 16/20):
     - Speech-to-text chạy HOÀN TOÀN TRONG TRÌNH DUYỆT bằng Web Speech API. KHÔNG gửi audio lên
       server, KHÔNG tạo request AI thứ hai, KHÔNG phát sinh token. Hệ quả: latency thấp hơn, giọng
       nói của người học không bao giờ rời khỏi máy họ.
     - Module này CHỈ sinh ra text. Nó không biết gì về /api/chat. Luồng đầy đủ là:
           click mic -> xin quyền -> nhận dạng -> transcript -> #qInput -> người dùng bấm "Giải bài"
       Bước cuối do app.js/sendMessage() lo, KHÔNG tự động gửi (PHẦN 15/25).
     - Mọi lỗi đều được bắt tại đây và báo ra qua callback onError. KHÔNG BAO GIỜ để thoát ra ngoài
       thành Unhandled Promise Rejection (PHẦN 23).

   API công khai (window.voiceInput):
       isSupported()  -> boolean
       start(opts)    -> bắt đầu nghe
       stop()         -> dừng "lịch sự", vẫn nhận kết quả cuối cùng đang chờ
       abort()        -> hủy ngay, BỎ kết quả
       getState()     -> 'idle'|'recording'|'processing'|'error'|'unsupported'
       subscribe(fn)  -> theo dõi đổi trạng thái, trả về hàm hủy đăng ký
   ===================================================================================== */

(function () {
  var STATES = {
    IDLE: 'idle',
    RECORDING: 'recording',
    PROCESSING: 'processing',
    ERROR: 'error',
    UNSUPPORTED: 'unsupported'
  };

  // Trình duyệt không trả event `end` trong một số trường hợp (tab bị ẩn, thiết bị thu âm bị rút,
  // engine nhận dạng treo). Không có timeout an toàn thì microphone sẽ chạy mãi (PHẦN 18).
  var SAFETY_TIMEOUT_MS = 60000;
  // Im lặng kéo dài -> tự dừng để không giữ mic vô ích.
  var SILENCE_TIMEOUT_MS = 8000;

  function getRecognitionCtor() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  /**
   * Quy ngôn ngữ TRẢ LỜI của ứng dụng (settings.lang) về mã BCP-47 cho engine nhận dạng.
   * PHẦN 17: tiếng Việt là ưu tiên số 1. 'tự động' -> bám theo ngôn ngữ GIAO DIỆN (languageStore),
   * vì đó là tín hiệu tốt nhất về ngôn ngữ người dùng đang thực sự nói.
   * @param {string} [answerLang] giá trị state.settings.lang
   * @returns {string} vd 'vi-VN'
   */
  function resolveRecognitionLang(answerLang) {
    var raw = String(answerLang == null ? '' : answerLang).toLowerCase();
    if (raw.indexOf('việt') >= 0 || raw.indexOf('viet') >= 0 || raw === 'vi') return 'vi-VN';
    if (raw.indexOf('english') >= 0 || raw === 'en') return 'en-US';
    // 'tự động theo câu hỏi' hoặc giá trị lạ -> theo ngôn ngữ giao diện.
    var ui = 'vi';
    try {
      if (window.languageStore && typeof window.languageStore.getUILanguage === 'function') {
        ui = window.languageStore.getUILanguage() || 'vi';
      }
    } catch (e) { ui = 'vi'; }
    return ui === 'en' ? 'en-US' : 'vi-VN';
  }

  var state = getRecognitionCtor() ? STATES.IDLE : STATES.UNSUPPORTED;
  var recognition = null;
  var subscribers = [];
  var safetyTimer = null;
  var silenceTimer = null;
  var activeHandlers = {};
  var lastErrorCode = null;
  var finalTranscript = '';

  function setState(next) {
    if (state === next) return;
    state = next;
    subscribers.slice().forEach(function (fn) {
      try { fn(state, lastErrorCode); } catch (e) { /* subscriber lỗi không được làm hỏng mic */ }
    });
  }

  function clearTimers() {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  function armSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(function () {
      // Im lặng quá lâu: dừng LỊCH SỰ (stop) để kết quả đang chờ vẫn được trả về.
      try { if (recognition) recognition.stop(); } catch (e) { /* đã dừng */ }
    }, SILENCE_TIMEOUT_MS);
  }

  function teardown() {
    clearTimers();
    if (recognition) {
      // Gỡ handler TRƯỚC khi bỏ tham chiếu — nếu engine bắn thêm event muộn, nó không còn chạm được
      // vào phiên đã kết thúc (nguồn gốc kinh điển của "transcript của lần trước nhảy vào lần sau").
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      recognition.onspeechend = null;
      recognition = null;
    }
    activeHandlers = {};
    finalTranscript = '';
  }

  function isSupported() {
    return !!getRecognitionCtor();
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subscribers.push(fn);
    return function () {
      var i = subscribers.indexOf(fn);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  /**
   * @param {{lang?:string, interim?:boolean, onResult?:Function, onPartial?:Function,
   *   onError?:Function, onEnd?:Function}} [opts]
   *   onResult(finalText) — CHỈ được gọi khi có text thật; app.js đưa text này vào #qInput.
   *   onError(code) — code chuẩn của Web Speech ('not-allowed','no-speech','audio-capture',
   *     'network','aborted'...) hoặc 'unsupported'/'start-failed' do module tự sinh.
   * @returns {boolean} false nếu không khởi động được (đã báo qua onError).
   */
  function start(opts) {
    opts = opts || {};
    var Ctor = getRecognitionCtor();
    if (!Ctor) {
      lastErrorCode = 'unsupported';
      setState(STATES.UNSUPPORTED);
      if (opts.onError) { try { opts.onError('unsupported'); } catch (e) { /* noop */ } }
      return false;
    }
    // Bấm mic khi đang ghi âm = dừng (toggle). Quyết định đó nằm ở app.js, nhưng chặn ở đây để
    // không bao giờ có 2 phiên nhận dạng chồng nhau.
    if (state === STATES.RECORDING || state === STATES.PROCESSING) return false;

    lastErrorCode = null;
    finalTranscript = '';
    activeHandlers = opts;

    try {
      recognition = new Ctor();
    } catch (e) {
      lastErrorCode = 'start-failed';
      setState(STATES.ERROR);
      if (opts.onError) { try { opts.onError('start-failed'); } catch (e2) { /* noop */ } }
      return false;
    }

    recognition.lang = opts.lang || resolveRecognitionLang();
    recognition.continuous = false;      // 1 lượt nói = 1 transcript; người dùng bấm lại nếu muốn nói tiếp
    recognition.interimResults = opts.interim !== false;
    recognition.maxAlternatives = 1;

    recognition.onstart = function () {
      setState(STATES.RECORDING);
      armSilenceTimer();
    };

    recognition.onresult = function (event) {
      armSilenceTimer();
      var interim = '';
      try {
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var res = event.results[i];
          if (!res || !res[0]) continue;
          if (res.isFinal) finalTranscript += res[0].transcript;
          else interim += res[0].transcript;
        }
      } catch (e) { /* shape event lạ -> bỏ qua, không làm hỏng phiên */ }
      if (interim && activeHandlers.onPartial) {
        try { activeHandlers.onPartial(interim); } catch (e) { /* noop */ }
      }
    };

    recognition.onspeechend = function () {
      setState(STATES.PROCESSING);
      try { if (recognition) recognition.stop(); } catch (e) { /* đã dừng */ }
    };

    recognition.onerror = function (event) {
      var code = (event && event.error) || 'unknown';
      lastErrorCode = code;
      var handlers = activeHandlers;
      clearTimers();
      // 'aborted' là do CHÍNH người dùng hủy — không phải lỗi, không hiện thông báo đỏ.
      setState(code === 'aborted' ? STATES.IDLE : STATES.ERROR);
      if (code !== 'aborted' && handlers.onError) {
        try { handlers.onError(code); } catch (e) { /* noop */ }
      }
    };

    recognition.onend = function () {
      var handlers = activeHandlers;
      var text = String(finalTranscript || '').trim();
      clearTimers();
      teardown();
      if (text && handlers.onResult) {
        try { handlers.onResult(text); } catch (e) { /* noop */ }
      }
      if (handlers.onEnd) { try { handlers.onEnd(text); } catch (e) { /* noop */ } }
      // Không ghi đè trạng thái ERROR đã được onerror đặt (onend luôn bắn sau onerror).
      if (state !== STATES.ERROR) setState(STATES.IDLE);
    };

    try {
      // start() có thể throw đồng bộ (InvalidStateError khi engine chưa nhả phiên trước), và cũng
      // có thể từ chối quyền BẤT ĐỒNG BỘ qua onerror('not-allowed') — cả hai đường đều được bắt.
      recognition.start();
    } catch (e) {
      lastErrorCode = 'start-failed';
      teardown();
      setState(STATES.ERROR);
      if (opts.onError) { try { opts.onError('start-failed'); } catch (e2) { /* noop */ } }
      return false;
    }

    safetyTimer = setTimeout(function () {
      // Engine không trả event end -> tự hủy. KHÔNG BAO GIỜ để microphone chạy mãi (PHẦN 18).
      try { if (recognition) recognition.abort(); } catch (e) { /* noop */ }
      clearTimers();
      teardown();
      setState(STATES.IDLE);
    }, SAFETY_TIMEOUT_MS);

    // Một số engine không bắn onstart ngay; đặt trạng thái lạc quan để UI phản hồi tức thì.
    setState(STATES.RECORDING);
    return true;
  }

  /** Dừng lịch sự: kết quả cuối cùng đang chờ VẪN được trả về qua onResult. */
  function stop() {
    if (!recognition) return;
    setState(STATES.PROCESSING);
    try { recognition.stop(); } catch (e) { /* đã dừng */ }
  }

  /** Hủy ngay và BỎ kết quả — dùng cho Esc / rời trang. */
  function abort() {
    if (!recognition) { setState(state === STATES.UNSUPPORTED ? STATES.UNSUPPORTED : STATES.IDLE); return; }
    finalTranscript = '';
    try { recognition.abort(); } catch (e) { /* noop */ }
    clearTimers();
    teardown();
    setState(STATES.IDLE);
  }

  /** Xóa trạng thái ERROR để nút mic quay về idle sau khi người dùng đã đọc thông báo. */
  function resetError() {
    if (state === STATES.ERROR) { lastErrorCode = null; setState(STATES.IDLE); }
  }

  function getLastError() { return lastErrorCode; }

  window.voiceInput = {
    STATES: STATES,
    isSupported: isSupported,
    start: start,
    stop: stop,
    abort: abort,
    getState: getState,
    getLastError: getLastError,
    resetError: resetError,
    subscribe: subscribe,
    resolveRecognitionLang: resolveRecognitionLang
  };

  // Rời trang / tab bị ẩn lâu: không giữ microphone.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', function () { try { abort(); } catch (e) { /* noop */ } });
  }
})();
