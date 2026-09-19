import React from 'react';
import AppShell from '@/components/app-shell/AppShell';

export default function HomePage() {
  return (
    <>
      {/* Semantic Server-Rendered Content for Crawlers & Assistive Tech */}
      <header className="sr-only">
        <h1>Trợ Giải — Không Gian AI Học Tập &amp; Giải Bài Thông Minh</h1>
        <p>
          Trợ Giải là trợ lý học tập toàn diện được thiết kế chuyên biệt cho học sinh từ Tiểu học,
          THCS, THPT đến Đại học tại Việt Nam. Nền tảng hỗ trợ phân tích đề bài, hướng dẫn giải từng bước
          chi tiết, đối chiếu đa hướng và tự kiểm tra bài làm cho tất cả các môn: Toán học, Vật lý,
          Hóa học, Sinh học, Ngữ văn, Tiếng Anh, Lịch sử, Địa lý và Tin học.
        </p>
        <section>
          <h2>Tính năng học tập nổi bật</h2>
          <ul>
            <li>
              <strong>Học theo tài liệu cá nhân:</strong> Tải lên giáo trình, sách bài tập (PDF, DOCX, TXT)
              hoặc dán liên kết tài liệu để AI trích dẫn căn cứ chính xác kèm số trang.
            </li>
            <li>
              <strong>Minh họa trực quan 2D &amp; 3D:</strong> Tự động vẽ hình học không gian, đồ thị hàm số
              và sơ đồ hóa học phục vụ trực quan hóa bài toán.
            </li>
            <li>
              <strong>Flashcard &amp; Ghi nhớ:</strong> Tự động tạo bộ thẻ ghi nhớ câu hỏi - đáp án từ lời giải
              để ôn tập chủ động ngắt quãng.
            </li>
            <li>
              <strong>Tra cứu công thức chuẩn:</strong> Thư viện công thức Toán, Lý, Hóa tích hợp theo từng khối lớp.
            </li>
            <li>
              <strong>Nhập liệu đa phương thức:</strong> Dán ảnh chụp đề bài, nhập văn bản hoặc sử dụng giọng nói.
            </li>
          </ul>
        </section>
      </header>

      {/* Main Interactive AI App Shell */}
      <AppShell />
    </>
  );
}
