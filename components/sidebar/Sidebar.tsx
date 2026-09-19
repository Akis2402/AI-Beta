'use client';

import React from 'react';
import SourcePanel from '../source-panel/SourcePanel';
import HistoryPanel from '../history/HistoryPanel';
import NotesPanel from '../notes/NotesPanel';
import FormulaPanel from '../formula-panel/FormulaPanel';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  activeTab: 'sources' | 'history' | 'notes' | 'formulas';
  onTabChange: (tab: 'sources' | 'history' | 'notes' | 'formulas') => void;
  sources: any[];
  onAddSourceClick: () => void;
  onRemoveSource: (id: string) => void;
  history: any[];
  onSelectHistory: (item: any) => void;
  onDeleteHistory: (id: string) => void;
  notes: any[];
  onOpenNote: (note: any) => void;
  onOpenSettings: () => void;
  schoolGrade: string;
}

export default function Sidebar({
  isOpen,
  onClose,
  onNewChat,
  activeTab,
  onTabChange,
  sources,
  onAddSourceClick,
  onRemoveSource,
  history,
  onSelectHistory,
  onDeleteHistory,
  notes,
  onOpenNote,
  onOpenSettings,
  schoolGrade
}: SidebarProps) {
  return (
    <>
      <div
        id="sidebarOverlay"
        className={isOpen ? 'visible' : ''}
        onClick={onClose}
      />
      <aside id="sidebar" className={isOpen ? 'open' : ''}>
        <div className="brand">
          <button
            id="closeSidebarBtn"
            title="Đóng"
            aria-label="Đóng menu"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
          <h1>
            <svg
              className="brand-pencil"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Trợ Giải
          </h1>
          <span className="eyebrow">AI Study Workspace</span>
        </div>

        <button id="newChatBtn" onClick={onNewChat}>
          ＋ Buổi học mới
        </button>

        <div id="sidebarTabs">
          <button
            className={`sbtab ${activeTab === 'sources' ? 'active' : ''}`}
            data-tab="sources"
            title="Nguồn tài liệu"
            onClick={() => onTabChange('sources')}
          >
            <span className="sbtab-ic">📚</span>
            <span>Nguồn</span>
          </button>
          <button
            className={`sbtab ${activeTab === 'history' ? 'active' : ''}`}
            data-tab="history"
            title="Lịch sử học"
            onClick={() => onTabChange('history')}
          >
            <span className="sbtab-ic">🕒</span>
            <span>Lịch sử</span>
          </button>
          <button
            className={`sbtab ${activeTab === 'notes' ? 'active' : ''}`}
            data-tab="notes"
            title="Ghi chú"
            onClick={() => onTabChange('notes')}
          >
            <span className="sbtab-ic">📝</span>
            <span>Ghi chú</span>
          </button>
          <button
            className={`sbtab ${activeTab === 'formulas' ? 'active' : ''}`}
            data-tab="formulas"
            title="Danh mục công thức"
            onClick={() => onTabChange('formulas')}
          >
            <span className="sbtab-ic">📐</span>
            <span>Công thức</span>
          </button>
        </div>

        <div id="sidebarPanels">
          <div className={`sbpanel ${activeTab === 'sources' ? 'active' : ''}`} id="panel-sources">
            <SourcePanel
              sources={sources}
              onAddClick={onAddSourceClick}
              onRemove={onRemoveSource}
            />
          </div>

          <div className={`sbpanel ${activeTab === 'history' ? 'active' : ''}`} id="panel-history">
            <HistoryPanel
              history={history}
              onSelect={onSelectHistory}
              onDelete={onDeleteHistory}
            />
          </div>

          <div className={`sbpanel ${activeTab === 'notes' ? 'active' : ''}`} id="panel-notes">
            <NotesPanel notes={notes} onOpenNote={onOpenNote} />
          </div>

          <div className={`sbpanel ${activeTab === 'formulas' ? 'active' : ''}`} id="panel-formulas">
            <FormulaPanel schoolGrade={schoolGrade} />
          </div>
        </div>

        <button id="settingsBtnSide" onClick={onOpenSettings}>
          <span className="gear">⚙️</span>
          <span>Cài đặt AI</span>
        </button>
      </aside>
    </>
  );
}
