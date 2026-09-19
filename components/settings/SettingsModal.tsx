'use client';

import React, { useState } from 'react';

export interface UserSettings {
  detail: string;
  visual: string;
  language: string;
  theme: string;
  school: string;
  grade: string;
  rules: string[];
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onUpdateSettings: (newSettings: Partial<UserSettings>) => void;
  onClearHistory: () => void;
}

export default function SettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onClearHistory
}: SettingsModalProps) {
  const [ruleInput, setRuleInput] = useState('');

  if (!isOpen) return null;

  const handleAddRule = () => {
    if (!ruleInput.trim()) return;
    onUpdateSettings({
      rules: [...settings.rules, ruleInput.trim()]
    });
    setRuleInput('');
  };

  const handleRemoveRule = (index: number) => {
    onUpdateSettings({
      rules: settings.rules.filter((_, i) => i !== index)
    });
  };

  const gradesForSchool = (school: string) => {
    switch (school) {
      case 'tieu-hoc':
        return ['1', '2', '3', '4', '5'];
      case 'thcs':
        return ['6', '7', '8', '9'];
      case 'thpt':
        return ['10', '11', '12'];
      case 'dai-hoc':
        return ['dai-hoc'];
      default:
        return ['10', '11', '12'];
    }
  };

  return (
    <div
      id="settingsOverlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div id="settingsModal">
        <div className="set-head">
          <h2>
            <span className="modal-ic">⚙️</span>
            <span>Cài đặt học tập</span>
          </h2>
          <button className="set-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="set-subtitle">Cá nhân hóa cách Trợ Giải hỗ trợ bạn</p>

        {/* Answer Style */}
        <div className="set-section">
          <h3>Phong cách trả lời</h3>
          <div className="set-row">
            <label>Độ chi tiết lời giải</label>
            <div className="chipset">
              <button
                className={`chip ${settings.detail === 'ngắn gọn' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ detail: 'ngắn gọn' })}
              >
                Ngắn gọn
              </button>
              <button
                className={`chip ${settings.detail === 'tiêu chuẩn' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ detail: 'tiêu chuẩn' })}
              >
                Tiêu chuẩn
              </button>
            </div>
          </div>

          <div className="set-row">
            <label>Hình minh họa</label>
            <div className="chipset">
              <button
                className={`chip ${settings.visual === 'auto' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ visual: 'auto' })}
              >
                Tự động
              </button>
              <button
                className={`chip ${settings.visual === 'always' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ visual: 'always' })}
              >
                Khi hữu ích
              </button>
              <button
                className={`chip ${settings.visual === 'never' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ visual: 'never' })}
              >
                Không bao giờ
              </button>
            </div>
          </div>

          <div className="set-row">
            <label>Ngôn ngữ trả lời</label>
            <div className="chipset">
              <button
                className={`chip ${settings.language === 'Tiếng Việt' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ language: 'Tiếng Việt' })}
              >
                Tiếng Việt
              </button>
              <button
                className={`chip ${settings.language === 'English' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ language: 'English' })}
              >
                English
              </button>
              <button
                className={`chip ${settings.language === 'tự động theo câu hỏi' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ language: 'tự động theo câu hỏi' })}
              >
                Tự động
              </button>
            </div>
          </div>
        </div>

        {/* Study Info */}
        <div className="set-section">
          <h3>Thông tin học tập (dùng cho Danh mục công thức)</h3>
          <div className="set-row">
            <label>Cấp học</label>
            <div className="chipset">
              <button
                className={`chip ${settings.school === 'tieu-hoc' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ school: 'tieu-hoc', grade: '5' })}
              >
                Tiểu học
              </button>
              <button
                className={`chip ${settings.school === 'thcs' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ school: 'thcs', grade: '9' })}
              >
                THCS
              </button>
              <button
                className={`chip ${settings.school === 'thpt' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ school: 'thpt', grade: '10' })}
              >
                THPT
              </button>
              <button
                className={`chip ${settings.school === 'dai-hoc' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ school: 'dai-hoc', grade: 'dai-hoc' })}
              >
                Đại học
              </button>
            </div>
          </div>

          <div className="set-row" id="gradeRow">
            <label>Khối / lớp đang học</label>
            <div className="chipset">
              {gradesForSchool(settings.school).map((g) => (
                <button
                  key={g}
                  className={`chip ${settings.grade === g ? 'active' : ''}`}
                  onClick={() => onUpdateSettings({ grade: g })}
                >
                  {g === 'dai-hoc' ? 'Đại học' : `Lớp ${g}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Custom Rules */}
        <div className="set-section">
          <h3>Quy tắc tự học (ghi nhớ lâu dài)</h3>
          <textarea
            id="ruleInput"
            rows={2}
            value={ruleInput}
            onChange={(e) => setRuleInput(e.target.value)}
            placeholder="VD: Luôn trình bày lời giải Toán theo từng bước có đánh số rõ ràng."
          />
          <button id="ruleAddBtn" onClick={handleAddRule}>
            ＋ Thêm quy tắc
          </button>
          <ul id="ruleList">
            {settings.rules.map((rule, idx) => (
              <li key={idx} className="rule-item">
                <span>{rule}</span>
                <button onClick={() => handleRemoveRule(idx)}>✕</button>
              </li>
            ))}
          </ul>
        </div>

        {/* Data Actions */}
        <div className="set-section">
          <h3>Dữ liệu buổi học</h3>
          <button
            className="danger-btn"
            id="clearHistoryBtn"
            onClick={() => {
              if (confirm('Bạn có chắc chắn muốn xóa toàn bộ tin nhắn trong buổi học này không?')) {
                onClearHistory();
                onClose();
              }
            }}
          >
            Xóa cuộc trò chuyện hiện tại
          </button>
        </div>
      </div>
    </div>
  );
}
