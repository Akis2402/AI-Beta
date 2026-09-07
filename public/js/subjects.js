'use strict';

// Mục 14 — danh sách môn học phía client, PHẢI khớp id với server/utils/subjects.js (server là
// nguồn sự thật cho prompt strategy; ở đây chỉ cần id/name/icon/color để vẽ Subject Selector +
// badge nhận diện — xem 14.3/14.4/14.11). Thêm môn mới: thêm 1 object vào đây VÀ vào SUBJECTS ở
// server/utils/subjects.js (giữ đúng id).
window.SUBJECTS = [
  { id: 'auto', name: 'Tự động nhận diện', icon: '✨' },
  { id: 'math', name: 'Toán học', icon: '📐' },
  { id: 'physics', name: 'Vật lý', icon: '⚛️' },
  { id: 'chemistry', name: 'Hóa học', icon: '🧪' },
  { id: 'biology', name: 'Sinh học', icon: '🧬' },
  { id: 'literature', name: 'Ngữ văn', icon: '📖' },
  { id: 'english', name: 'Tiếng Anh', icon: '🇬🇧' },
  { id: 'history', name: 'Lịch sử', icon: '🏛️' },
  { id: 'geography', name: 'Địa lý', icon: '🌍' },
  { id: 'computer-science', name: 'Tin học', icon: '💻' },
  { id: 'natural-science', name: 'Khoa học tự nhiên', icon: '🔬' },
  { id: 'economics-civics', name: 'Kinh tế / Công dân', icon: '⚖️' },
  { id: 'general', name: 'Môn học khác', icon: '📚' }
];

window.SUBJECT_MAP = window.SUBJECTS.reduce((m, s) => { m[s.id] = s; return m; }, {});

function getSubjectInfo(id) {
  return window.SUBJECT_MAP[id] || window.SUBJECT_MAP.general;
}
window.getSubjectInfo = getSubjectInfo;
