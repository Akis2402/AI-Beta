'use client';

import React, { useEffect, useRef } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  approach?: string;
  detail?: string;
  thinking?: string;
  images?: string[];
  visuals?: any[];
  sources?: any[];
  subject?: string;
  showDetail?: boolean;
}

interface ThreadProps {
  messages: ChatMessage[];
  onPromptClick: (text: string) => void;
  onSaveNote: (msg: ChatMessage) => void;
  onPractice: (msg: ChatMessage) => void;
  onFlashcards: (msg: ChatMessage) => void;
  onSelfCheck: (msg: ChatMessage) => void;
  onToggleDetail: (msgId: string) => void;
}

export default function Thread({
  messages,
  onPromptClick,
  onSaveNote,
  onPractice,
  onFlashcards,
  onSelfCheck,
  onToggleDetail
}: ThreadProps) {
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    if (typeof window !== 'undefined' && (window as any).renderMathInElement) {
      const threadEl = document.getElementById('thread');
      if (threadEl) {
        try {
          (window as any).renderMathInElement(threadEl, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false },
              { left: '\\(', right: '\\)', display: false },
              { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false
          });
        } catch {}
      }
    }
  }, [messages]);

  const copyText = (text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  const speakText = (text: string) => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'vi-VN';
      window.speechSynthesis.speak(u);
    }
  };

  if (messages.length === 0) {
    return (
      <div id="thread" className="thread-empty">
        <div className="welcome-box">
          <h2>👋 Chào bạn, hôm nay chúng ta cùng học gì?</h2>
          <p className="welcome-desc">
            Nhập đề bài toán, lý, hóa, văn, ngoại ngữ; dán ảnh chụp đề hoặc tải tài liệu học tập (PDF, DOCX) để cùng khám phá phương pháp giải và ghi nhớ kiến thức lâu dài.
          </p>
          <div className="starter-chips">
            <button
              className="starter-chip"
              onClick={() => onPromptClick('Cho tam giác ABC vuông tại A, AB = 6cm, AC = 8cm. Tính cạnh huyền BC và diện tích tam giác.')}
            >
              📐 Tính cạnh huyền & diện tích tam giác vuông
            </button>
            <button
              className="starter-chip"
              onClick={() => onPromptClick('Một vật chuyển động thẳng biến đổi đều với vận tốc đầu v0 = 5 m/s, gia tốc a = 2 m/s². Tính quãng đường vật đi được sau 4 giây.')}
            >
              ⚛️ Bài toán chuyển động biến đổi đều
            </button>
            <button
              className="starter-chip"
              onClick={() => onPromptClick('Cân bằng phương trình phản ứng hóa học: Fe + HNO3 loãng -> Fe(NO3)3 + NO + H2O')}
            >
              🧪 Cân bằng phản ứng oxi hóa - khử
            </button>
            <button
              className="starter-chip"
              onClick={() => onPromptClick('Phân tích giá trị nhân đạo trong truyện ngắn Vợ nhặt của nhà văn Kim Lân.')}
            >
              📖 Hướng dẫn phân tích bài văn Vợ nhặt
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="thread">
      {messages.map((m) => (
        <div key={m.id} className={`msg-row ${m.role === 'user' ? 'user-row' : 'bot-row'}`}>
          <div className="msg-avatar">
            {m.role === 'user' ? '👤' : '💡'}
          </div>

          <div className="msg-bubble">
            {m.role === 'user' ? (
              <div className="user-msg-content">
                {m.images && m.images.length > 0 && (
                  <div className="user-images-preview">
                    {m.images.map((img, idx) => (
                      <img key={idx} src={img} alt="Đề bài" className="preview-thumb" />
                    ))}
                  </div>
                )}
                <div className="msg-text">{m.content}</div>
              </div>
            ) : (
              <div className="bot-msg-content">
                {/* Thinking / Cross-check section */}
                {m.thinking && (
                  <details className="thinking-details">
                    <summary className="thinking-summary">
                      <span>🧠 Quá trình suy luận & kiểm tra chéo</span>
                    </summary>
                    <div className="thinking-content">{m.thinking}</div>
                  </details>
                )}

                {/* Approach Section */}
                {m.approach && (
                  <div className="solution-section approach-section">
                    <div className="section-badge">🎯 Hướng tiếp cận & Phương pháp</div>
                    <div className="section-body">{m.approach}</div>
                  </div>
                )}

                {/* Detail Section */}
                {m.detail && (
                  <div className="solution-section detail-section">
                    <div className="section-badge-row">
                      <div className="section-badge">📝 Lời giải chi tiết</div>
                      <button
                        className="toggle-detail-btn"
                        onClick={() => onToggleDetail(m.id)}
                      >
                        {m.showDetail === false ? 'Hiện lời giải' : 'Thu gọn'}
                      </button>
                    </div>
                    {m.showDetail !== false && (
                      <div className="section-body">{m.detail}</div>
                    )}
                  </div>
                )}

                {/* Standard Content if neither approach nor detail */}
                {!m.approach && !m.detail && m.content && (
                  <div className="msg-text">{m.content}</div>
                )}

                {/* Visuals Rendering */}
                {m.visuals && m.visuals.length > 0 && (
                  <div className="visuals-container">
                    {m.visuals.map((vis, vi) => (
                      <div key={vi} className="visual-card">
                        {vis.url && (
                          <img src={vis.url} alt={vis.title || 'Minh họa'} className="visual-img" />
                        )}
                        {vis.title && <div className="visual-title">{vis.title}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Sources Used / Citations */}
                {m.sources && m.sources.length > 0 && (
                  <div className="sources-cited">
                    <div className="sources-cited-title">📌 Căn cứ từ tài liệu:</div>
                    <ul className="sources-cited-list">
                      {m.sources.map((s, si) => (
                        <li key={si} className="citation-item">
                          <b>{s.name || s.title}</b>
                          {s.page ? ` (trang ${s.page})` : ''}
                          {s.snippet && <span className="citation-snippet">: "{s.snippet}"</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="bot-actions-row">
                  <button className="action-pill" onClick={() => onSaveNote(m)} title="Lưu ghi chú để nhớ lâu">
                    📝 Lưu ghi chú
                  </button>
                  <button className="action-pill" onClick={() => onPractice(m)} title="Tạo bài tập tương tự">
                    🎯 Luyện tập
                  </button>
                  <button className="action-pill" onClick={() => onFlashcards(m)} title="Tạo bộ flashcard ôn tập">
                    🗂️ Flashcard
                  </button>
                  <button className="action-pill" onClick={() => onSelfCheck(m)} title="Tự kiểm tra bài làm">
                    🔍 Kiểm tra bài làm
                  </button>
                  <button className="action-pill" onClick={() => copyText(m.detail || m.content || '')} title="Sao chép lời giải">
                    📋 Sao chép
                  </button>
                  <button className="action-pill" onClick={() => speakText(m.detail || m.content || '')} title="Đọc to bằng giọng nói">
                    🔊 Đọc
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={threadEndRef} />
    </div>
  );
}
