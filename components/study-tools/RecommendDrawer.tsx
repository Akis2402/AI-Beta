'use client';

import React from 'react';

export interface RecommendItem {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
}

interface RecommendDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  topic: string;
  items: RecommendItem[];
}

export default function RecommendDrawer({
  isOpen,
  onClose,
  topic,
  items
}: RecommendDrawerProps) {
  if (!isOpen) return null;

  return (
    <div id="recommendDrawer" className="side-drawer visible">
      <div className="drawer-head">
        <h2>
          <span>💡 Đề xuất ôn tập & Mở rộng</span>
        </h2>
        <button className="drawer-close" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>

      <div className="drawer-sub">Chủ đề: {topic || 'Kiến thức liên quan'}</div>

      <div className="drawer-body">
        {items.length === 0 ? (
          <div className="panel-empty">
            Chưa có gợi ý ôn tập cho chủ đề này. Hãy gửi câu hỏi hoặc giải bài để nhận tài liệu tham khảo phù hợp nhất.
          </div>
        ) : (
          <ul className="recommend-list">
            {items.map((item, idx) => (
              <li key={idx} className="recommend-item">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="recommend-link"
                >
                  <span className="recommend-title">{item.title}</span>
                  {item.source && (
                    <span className="recommend-source">[{item.source}]</span>
                  )}
                </a>
                {item.snippet && (
                  <p className="recommend-snippet">{item.snippet}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
