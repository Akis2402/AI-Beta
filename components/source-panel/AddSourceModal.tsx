'use client';

import React, { useState } from 'react';

interface AddSourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddFiles: (files: FileList | File[]) => void;
  onAddUrl: (url: string) => Promise<void>;
  recentSources: any[];
  onSelectRecent: (source: any) => void;
}

export default function AddSourceModal({
  isOpen,
  onClose,
  onAddFiles,
  onAddUrl,
  recentSources,
  onSelectRecent
}: AddSourceModalProps) {
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  if (!isOpen) return null;

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    try {
      setLoading(true);
      setStatusMsg('Đang nạp và trích xuất nội dung từ URL...');
      await onAddUrl(urlInput.trim());
      setUrlInput('');
      setStatusMsg('Thêm nguồn thành công!');
      setTimeout(() => {
        setStatusMsg('');
        onClose();
      }, 1000);
    } catch (err: any) {
      setStatusMsg('Lỗi: ' + (err.message || 'Không thể nạp URL'));
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
      onClose();
    }
  };

  return (
    <div
      id="addSourceOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="addSourceTitle"
      className="visible"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div id="addSourceModal">
        <div className="set-head">
          <h2 id="addSourceTitle">
            <span className="modal-ic">📂</span>
            <span>＋ Thêm nguồn tài liệu</span>
          </h2>
          <button className="set-close" onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </div>

        <div className="set-section">
          <label
            id="addSourceDropZone"
            tabIndex={0}
            role="button"
            style={{ display: 'block', cursor: 'pointer' }}
          >
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.txt"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <span className="drop-ic">📄</span>
            <br />
            <b>Thả tài liệu vào đây hoặc bấm để chọn file</b>
            <br />
            <span className="drop-sub">PDF, DOCX hoặc TXT</span>
          </label>
        </div>

        <div className="set-section" id="urlSourceSection">
          <h3>Thêm nguồn từ URL (Web / YouTube)</h3>
          <form className="url-source-row" onSubmit={handleUrlSubmit}>
            <input
              type="url"
              id="urlSourceInput"
              placeholder="Dán link bài viết web hoặc video YouTube..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              disabled={loading}
              autoComplete="off"
            />
            <button id="urlSourceAddBtn" type="submit" disabled={loading || !urlInput.trim()}>
              {loading ? 'Đang thêm...' : 'Thêm'}
            </button>
          </form>
          {statusMsg && (
            <p className="set-empty" id="urlSourceStatus" style={{ display: 'block', marginTop: 8 }}>
              {statusMsg}
            </p>
          )}
        </div>

        <div className="set-section" id="recentSourcesSection">
          <h3>Nguồn gần đây</h3>
          {recentSources && recentSources.length > 0 ? (
            <ul id="recentSourcesList">
              {recentSources.map((r, i) => (
                <li
                  key={i}
                  className="recent-source-item"
                  onClick={() => {
                    onSelectRecent(r);
                    onClose();
                  }}
                >
                  <span>{r.name}</span>
                  <button className="chip">Sử dụng lại</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="set-empty" id="recentSourcesEmpty">
              Chưa có nguồn nào được dùng trước đây.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
