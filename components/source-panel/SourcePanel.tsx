'use client';

import React from 'react';

interface SourceItem {
  id: string;
  name: string;
  type: string;
  size?: number;
  snippet?: string;
  url?: string;
}

interface SourcePanelProps {
  sources: SourceItem[];
  onAddClick: () => void;
  onRemove: (id: string) => void;
}

export default function SourcePanel({ sources, onAddClick, onRemove }: SourcePanelProps) {
  return (
    <div id="sourcesPanel">
      <div className="sp-head">
        <h2>
          <span>Tài liệu học tập</span>
          <span className="sp-count" id="sourceCount">
            {sources.length > 0 ? ` (${sources.length})` : ''}
          </span>
        </h2>
        <button id="addSourceBtn" onClick={onAddClick}>
          ＋ Thêm nguồn
        </button>
      </div>

      <div id="dropHint" onClick={onAddClick} role="button" tabIndex={0}>
        <span className="drop-ic">📂</span>
        <br />
        <b>Thả tài liệu vào đây</b>
        <br />
        <span className="drop-sub">PDF, DOCX hoặc TXT — hoặc bấm "Thêm nguồn"</span>
      </div>

      {sources.length === 0 ? (
        <div id="emptySources">
          Chưa có nguồn nào. Thêm tài liệu để AI dùng làm căn cứ trả lời và trích dẫn chính xác.
        </div>
      ) : (
        <ul id="sourceList">
          {sources.map((src) => (
            <li key={src.id} className="source-item">
              <div className="source-info">
                <span className="source-icon">
                  {src.type === 'pdf' ? '📄' : src.type === 'youtube' ? '🎥' : src.type === 'web' ? '🌐' : '📝'}
                </span>
                <span className="source-name" title={src.name}>
                  {src.name}
                </span>
              </div>
              <button
                className="source-remove-btn"
                title="Xóa tài liệu này"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(src.id);
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
