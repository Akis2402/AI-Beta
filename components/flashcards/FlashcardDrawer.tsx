'use client';

import React, { useState } from 'react';

export interface Flashcard {
  q: string;
  a: string;
}

interface FlashcardDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  topic: string;
  cards: Flashcard[];
}

export default function FlashcardDrawer({
  isOpen,
  onClose,
  topic,
  cards
}: FlashcardDrawerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  if (!isOpen) return null;

  const currentCard = cards[currentIndex] || {
    q: 'Chưa có thẻ nào trong bộ ôn tập này.',
    a: 'Hãy bấm "Flashcard" dưới lời giải của AI hoặc tạo từ thanh trên cùng.'
  };

  const handleNext = () => {
    setFlipped(false);
    setCurrentIndex((prev) => (prev + 1) % Math.max(cards.length, 1));
  };

  const handlePrev = () => {
    setFlipped(false);
    setCurrentIndex((prev) => (prev - 1 + cards.length) % Math.max(cards.length, 1));
  };

  return (
    <div id="flashcardDrawer" className="side-drawer visible">
      <div className="drawer-head">
        <h2>
          <span>🗂️ Flashcard ôn tập</span>
        </h2>
        <button className="drawer-close" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>

      <div className="drawer-sub">Chủ đề: {topic || 'Kiến thức cốt lõi'}</div>

      <div className="flashcard-container">
        <div
          className={`flashcard ${flipped ? 'flipped' : ''}`}
          onClick={() => setFlipped(!flipped)}
        >
          <div className="card-face card-front">
            <div className="card-badge">❓ Câu hỏi / Khái niệm</div>
            <div className="card-text">{currentCard.q}</div>
            <div className="card-hint">Chạm để lật đáp án</div>
          </div>
          <div className="card-face card-back">
            <div className="card-badge">💡 Đáp án / Công thức</div>
            <div className="card-text">{currentCard.a}</div>
            <div className="card-hint">Chạm để lật lại</div>
          </div>
        </div>

        {cards.length > 0 && (
          <div className="flashcard-controls">
            <button className="btn-secondary" onClick={handlePrev}>
              ← Trước
            </button>
            <span className="flashcard-counter">
              {currentIndex + 1} / {cards.length}
            </span>
            <button className="btn-secondary" onClick={handleNext}>
              Tiếp →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
