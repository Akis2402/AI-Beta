/** Danh mục tư thế Akis dùng cho UI React. Khớp với public/js/mascot/akisPoses.js (nguồn dữ liệu chuyển động). */
export type AkisPose =
  | 'idle' | 'wave' | 'look' | 'peek' | 'type-email' | 'hide-eyes' | 'working' | 'success' | 'error' | 'sleepy'
  | 'point-left' | 'point-right' | 'hold-card' | 'spin-3d' | 'celebrate'
  | 'hint' | 'solution' | 'sources' | 'visual' | 'flashcard' | 'formula' | 'notes' | 'history' | 'voice' | 'trust' | 'tools';

export interface PoseInfo { id: AkisPose; title: string; desc: string }

/** Mỗi tính năng của Trợ Giải có một tạo hình riêng cho thấy nó "đang làm gì". */
export const FEATURE_POSES: PoseInfo[] = [
  { id: 'hint', title: 'Hướng giải', desc: 'Đeo kính, đọc sách, tìm gợi ý trước khi đưa lời giải' },
  { id: 'solution', title: 'Lời giải chi tiết', desc: 'Cầm bút viết từng bước' },
  { id: 'sources', title: 'Tài liệu', desc: 'Soi từng dòng bằng kính lúp, trích nguồn [1]' },
  { id: 'visual', title: 'Hình minh họa', desc: 'Vẽ đồ thị, xoay khối 3D' },
  { id: 'flashcard', title: 'Ôn tập', desc: 'Lật flashcard hỏi – đáp' },
  { id: 'formula', title: 'Công thức', desc: 'Ký hiệu toán lơ lửng, tra nhanh theo môn' },
  { id: 'notes', title: 'Ghi chú', desc: 'Dán giấy nhớ, ghi lại điều cần nhớ' },
  { id: 'history', title: 'Lịch sử học', desc: 'Kim đồng hồ quay ngược về bài đã hỏi' },
  { id: 'voice', title: 'Giọng nói', desc: 'Cầm mic, mở miệng nói thay vì gõ' },
  { id: 'trust', title: 'Minh bạch', desc: 'Khiên + khoá + thanh hạn mức' },
  { id: 'tools', title: 'Công cụ', desc: 'Luân phiên công thức · ghi chú · lịch sử · giọng nói' }
];

export const STATE_POSES: PoseInfo[] = [
  { id: 'idle', title: 'Nghỉ', desc: 'Chớp mắt, trôi nhẹ' },
  { id: 'wave', title: 'Chào', desc: 'Vẫy vòng xoáy chào bạn' },
  { id: 'working', title: 'Đang xử lý', desc: 'Chấm nhảy, vòng xoáy quay' },
  { id: 'success', title: 'Thành công', desc: 'Dấu ✓, tim bay lên' },
  { id: 'error', title: 'Có lỗi', desc: 'Lắc đầu, toát mồ hôi, dấu !' },
  { id: 'sleepy', title: 'Buồn ngủ', desc: 'Nhắm mắt, zzz' },
  { id: 'celebrate', title: 'Ăn mừng', desc: 'Confetti, nhảy cẫng' },
  { id: 'peek', title: 'Ló mặt', desc: 'Hạ sách xuống nhìn trộm' },
  { id: 'hide-eyes', title: 'Che mắt', desc: 'Nâng sách che mắt (nhập mật khẩu)' },
  { id: 'type-email', title: 'Nhập email', desc: 'Cầm thư, gật đầu' },
  { id: 'spin-3d', title: 'Xoay 3D', desc: 'Lật người quanh trục dọc' }
];
