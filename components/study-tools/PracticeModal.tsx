'use client';

import React, { useState } from 'react';

interface PracticeModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTopic: string;
  onGenerate: (topic: string, difficulty: string, count: number) => void;
}

export default function PracticeModal({
  isOpen,
  onClose,
  initialTopic,
  onGenerate
}: PracticeModalProps) {
  const [topic, setTopic] = useState(initialTopic);
  const [difficulty, setDifficulty] = useState('same');
  const [count, setCount] = useState(3);

  if (!isOpen) return null;

  return (
    <div
      id="practiceOverlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div id="practiceModal">
        <div className="set-head">
          <h2>
            <span className="modal-ic">🎯</span>
            <span>Luyện tập bài tương tự</span>
          </h2>
          <button className="set-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="set-subtitle">
          Tạo các bài toán tương tự để rèn luyện phản xạ và củng cố phương pháp giải
        </p>

        <div className="set-section">
          <label>Chủ đề hoặc bài toán gốc</label>
          <textarea
            rows={3}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Nội dung bài gốc..."
          />
        </div>

        <div className="set-section">
          <label>Độ khó</label>
          <div className="chipset">
            <button
              className={`chip ${difficulty === 'easier' ? 'active' : ''}`}
              onClick={() => setDifficulty('easier')}
            >
              Dễ hơn (Củng cố)
            </button>
            <button
              className={`chip ${difficulty === 'same' ? 'active' : ''}`}
              onClick={() => setDifficulty('same')}
            >
              Tương đương
            </button>
            <button
              className={`chip ${difficulty === 'harder' ? 'active' : ''}`}
              onClick={() => setDifficulty('harder')}
            >
              Nâng cao (Thử thách)
            </button>
          </div>
        </div>

        <div className="set-section">
          <label>Số lượng câu hỏi</label>
          <div className="chipset">
            {[1, 3, 5].map((c) => (
              <button
                key={c}
                className={`chip ${count === c ? 'active' : ''}`}
                onClick={() => setCount(c)}
              >
                {c} câu
              </button>
            ))}
          </div>
        </div>

        <div className="note-modal-actions">
          <button
            id="practiceStartBtn"
            onClick={() => {
              onGenerate(topic, difficulty, count);
              onClose();
            }}
          >
            Tạo bài luyện tập
          </button>
        </div>
      </div>
    </div>
  );
}
