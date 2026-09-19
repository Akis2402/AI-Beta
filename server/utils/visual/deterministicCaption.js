'use strict';

// ============================================================================================
// PHẦN AE + DZ + EB — CHÚ THÍCH CHO ẢNH: KHÔNG TỐN MỘT LỆNH GỌI MODEL
// ============================================================================================
// Đường "chỉ lấy hình" trước đây gọi model một lượt CHỈ để sinh 2–3 câu giới thiệu đi kèm bức ảnh.
// Đó là lệnh gọi thứ hai cho một request mà baseline là một, và nội dung nó sinh ra gần như luôn là
// mô tả lại chính chủ đề người dùng vừa gõ. Việc đó code làm được.
//
// Mặc định: chú thích DETERMINISTIC (0 token). Chỉ khi bật cờ IMAGE_CAPTION_MODEL=1 mới dùng model —
// dành cho trường hợp thực sự cần văn bản giàu thông tin đi kèm, và khi đó nó là lựa chọn CÓ Ý THỨC
// chứ không phải hành vi mặc định không ai để ý.

/** Tên môn hiển thị — không gọi model chỉ để biết "biology" nói bằng tiếng Việt là gì. */
const SUBJECT_LABEL_VI = {
  biology: 'sinh học', physics: 'vật lí', chemistry: 'hoá học', math: 'toán học',
  geography: 'địa lí', history: 'lịch sử', literature: 'ngữ văn', english: 'tiếng Anh',
  informatics: 'tin học', technology: 'công nghệ', civics: 'giáo dục công dân'
};

/**
 * buildDeterministicCaption() — thuần hàm, 0 token, 0 mạng.
 * @returns {{text:string, provider:{label:string}, deterministic:boolean}}
 */
function buildDeterministicCaption({ topic, language, subjectId } = {}) {
  const t = String(topic || '').trim();
  const isEnglish = /english/i.test(String(language || ''));
  if (!t) {
    return {
      text: isEnglish ? 'Here is the generated illustration.' : 'Dưới đây là hình minh hoạ được tạo.',
      provider: { label: 'deterministic' },
      deterministic: true
    };
  }
  const subject = SUBJECT_LABEL_VI[subjectId] || '';
  if (isEnglish) {
    return {
      text: `Illustration of ${t}. Zoom in to read the labels; use "Regenerate" if you want a different composition.`,
      provider: { label: 'deterministic' },
      deterministic: true
    };
  }
  return {
    text: `Hình minh hoạ: ${t}${subject ? ` (${subject})` : ''}. Phóng to để xem rõ các nhãn; bấm "Thử tạo lại" nếu muốn một bố cục khác.`,
    provider: { label: 'deterministic' },
    deterministic: true
  };
}

/** Chú thích bằng model CHỈ được bật tường minh qua env — không phải mặc định. */
function captionModelEnabled() {
  return String(process.env.IMAGE_CAPTION_MODEL || '') === '1';
}

module.exports = { buildDeterministicCaption, captionModelEnabled, SUBJECT_LABEL_VI };
