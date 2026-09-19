'use client';

import React, { useState, useEffect } from 'react';

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  question: string;
  initialNote?: string;
  onSave: (noteText: string) => void;
  onDelete?: () => void;
}

export default function NoteModal({
  isOpen,
  onClose,
  question,
  initialNote = '',
  onSave,
  onDelete
}: NoteModalProps) {
  const [noteText, setNoteText] = useState(initialNote);

  useEffect(() => {
    setNoteText(initialNote);
  }, [initialNote, isOpen]);

  if (!isOpen) return null;

  return (
    <div
      id="noteOverlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div id="noteModal">
        <div className="set-head">
          <h2>
            <span className="modal-ic">📝</span>
            <span>Ghi chú cá nhân</span>
          </h2>
          <button className="set-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="set-subtitle">Viết lại theo cách bạn hiểu để nhớ lâu hơn</p>

        <div className="note-q-box" id="noteQuestionView">
          <strong>Câu hỏi:</strong> {question}
        </div>

        <textarea
          id="noteInput"
          rows={4}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Ghi chú: bài này dùng công thức nào? Lưu ý bẫy ở đâu?..."
        />

        <div className="note-modal-actions">
          {onDelete && (
            <button
              id="noteDeleteBtn"
              className="danger-btn"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Xóa
            </button>
          )}
          <button
            id="noteSaveBtn"
            onClick={() => {
              if (noteText.trim()) {
                onSave(noteText.trim());
                onClose();
              }
            }}
          >
            Lưu ghi chú
          </button>
        </div>
      </div>
    </div>
  );
}
