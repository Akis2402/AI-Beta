'use client';

import React from 'react';

interface TopBarProps {
  onToggleSidebar: () => void;
  title: string;
  gradeBadge: string;
  status: 'ready' | 'thinking' | 'streaming' | 'error';
  bgTaskCount: number;
  onOpenBgTasks: () => void;
  onOpenFlashcards: () => void;
  onOpenRecommend: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function TopBar({
  onToggleSidebar,
  title,
  gradeBadge,
  status,
  bgTaskCount,
  onOpenBgTasks,
  onOpenFlashcards,
  onOpenRecommend,
  theme,
  onToggleTheme,
  onOpenSettings
}: TopBarProps) {
  const getStatusText = () => {
    switch (status) {
      case 'thinking':
        return 'ĐANG SUY NGHĨ...';
      case 'streaming':
        return 'ĐANG GIẢI BÀI...';
      case 'error':
        return 'GẶP LỖI';
      default:
        return 'SẴN SÀNG';
    }
  };

  return (
    <div id="topbar">
      <div className="left">
        <button
          id="menuBtn"
          className="iconbtn"
          title="Mở menu"
          aria-label="Mở menu điều hướng"
          onClick={onToggleSidebar}
        >
          ☰
        </button>
        <div className="title-wrap">
          <span className="title" id="chatTitle">
            {title || 'Buổi học mới'}
          </span>
          <span className="title-meta" id="chatMeta"></span>
        </div>
        {gradeBadge && (
          <span className="grade-badge" id="chatGradeBadge">
            {gradeBadge}
          </span>
        )}
      </div>

      <div className="right">
        <span className={`status status-${status}`} id="statusText">
          {getStatusText()}
        </span>

        {bgTaskCount > 0 && (
          <button
            id="bgTaskBtn"
            className="iconbtn bgtask-btn"
            type="button"
            title="Tác vụ AI đang chạy"
            aria-label="Tác vụ AI đang chạy"
            onClick={onOpenBgTasks}
          >
            <span className="bgtask-ic" aria-hidden="true">
              🤖
            </span>
            <span className="bgtask-badge" id="bgTaskBadge">
              {bgTaskCount}
            </span>
          </button>
        )}

        <button
          id="flashcardTopBtn"
          className="iconbtn"
          title="Mở Flashcard ôn tập"
          aria-label="Mở Flashcard ôn tập"
          onClick={onOpenFlashcards}
        >
          🗂️
        </button>

        <button
          id="recommendTopBtn"
          className="iconbtn"
          title="Mở Đề xuất ôn tập"
          aria-label="Mở Đề xuất ôn tập"
          onClick={onOpenRecommend}
        >
          💡
        </button>

        <button
          id="themeBtn"
          className="iconbtn"
          title="Đổi giao diện sáng/tối"
          aria-label="Đổi giao diện sáng/tối"
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        <button
          id="settingsBtnTop"
          className="iconbtn"
          title="Cài đặt học tập"
          aria-label="Mở cài đặt học tập"
          onClick={onOpenSettings}
        >
          ⚙️
        </button>
      </div>
    </div>
  );
}
