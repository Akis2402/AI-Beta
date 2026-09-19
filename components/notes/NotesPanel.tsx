'use client';

import React from 'react';

interface NoteItem {
  id: string;
  messageId?: string;
  question: string;
  note: string;
  createdAt: string;
}

interface NotesPanelProps {
  notes: NoteItem[];
  onOpenNote: (note: NoteItem) => void;
}

export default function NotesPanel({ notes, onOpenNote }: NotesPanelProps) {
  return (
    <div>
      <div className="panel-head">
        <h2>Ghi chú đã lưu</h2>
      </div>

      {notes.length === 0 ? (
        <div id="notesEmpty" className="panel-empty">
          Chưa có ghi chú nào. Sau khi AI trả lời, bấm nút{' '}
          <strong>📝 Lưu ghi chú</strong> dưới câu trả lời, viết lại những gì bạn hiểu rồi lưu — ghi chú sẽ xuất hiện ở đây, bấm vào để xem lại đúng câu trả lời đó.
        </div>
      ) : (
        <ul id="notesList" className="side-list">
          {notes.map((n) => (
            <li
              key={n.id}
              className="side-item"
              onClick={() => onOpenNote(n)}
            >
              <div className="side-item-content">
                <span className="side-item-title">{n.note}</span>
                <span className="side-item-meta">Câu hỏi: {n.question}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
