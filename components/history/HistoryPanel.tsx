'use client';

import React, { useState } from 'react';

interface HistoryItem {
  id: string;
  title: string;
  subject?: string;
  createdAt: string;
  messageCount: number;
}

interface HistoryPanelProps {
  history: HistoryItem[];
  onSelect: (item: HistoryItem) => void;
  onDelete: (id: string) => void;
}

export default function HistoryPanel({ history, onSelect, onDelete }: HistoryPanelProps) {
  const [filter, setFilter] = useState('all');

  const filtered = history.filter((h) => {
    if (filter === 'all') return true;
    return h.subject === filter;
  });

  return (
    <div>
      <div className="panel-head">
        <h2>Lịch sử học</h2>
      </div>

      <select
        id="historySubjectFilter"
        className="hist-subject-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      >
        <option value="all">Tất cả môn học</option>
        <option value="math">Toán học</option>
        <option value="physics">Vật lý</option>
        <option value="chemistry">Hóa học</option>
        <option value="biology">Sinh học</option>
        <option value="literature">Ngữ văn</option>
        <option value="english">Tiếng Anh</option>
      </select>

      {filtered.length === 0 ? (
        <div id="historyEmpty" className="panel-empty">
          Chưa có cuộc trò chuyện nào được lưu. Mọi buổi học của bạn sẽ tự động xuất hiện ở đây.
        </div>
      ) : (
        <ul id="historyList" className="side-list">
          {filtered.map((item) => (
            <li
              key={item.id}
              className="side-item"
              onClick={() => onSelect(item)}
            >
              <div className="side-item-content">
                <span className="side-item-title">{item.title}</span>
                <span className="side-item-meta">
                  {new Date(item.createdAt).toLocaleDateString('vi-VN')} · {item.messageCount} tin nhắn
                </span>
              </div>
              <button
                className="side-item-del"
                title="Xóa buổi học này"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
