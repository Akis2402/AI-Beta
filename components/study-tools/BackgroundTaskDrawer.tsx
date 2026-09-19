'use client';

import React from 'react';

export interface BackgroundTask {
  id: string;
  type: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  result?: any;
}

interface BackgroundTaskDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: BackgroundTask[];
  onOpenResult?: (task: BackgroundTask) => void;
}

export default function BackgroundTaskDrawer({
  isOpen,
  onClose,
  tasks,
  onOpenResult
}: BackgroundTaskDrawerProps) {
  if (!isOpen) return null;

  return (
    <div id="bgtaskDrawer" className="side-drawer visible">
      <div className="drawer-head">
        <h2>
          <span>🤖 Tác vụ nền AI</span>
        </h2>
        <button className="drawer-close" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>

      <div className="drawer-sub">
        Các tác vụ nặng (tạo đề kiểm tra, trích xuất tài liệu, tạo mindmap) chạy ngầm không gián đoạn việc học
      </div>

      <div className="drawer-body">
        {tasks.length === 0 ? (
          <div className="panel-empty">
            Không có tác vụ nào đang chạy trong nền.
          </div>
        ) : (
          <ul className="bgtask-list">
            {tasks.map((task) => (
              <li key={task.id} className="bgtask-item">
                <div className="bgtask-item-header">
                  <span className="bgtask-item-title">{task.title}</span>
                  <span className={`bgtask-status-badge ${task.status}`}>
                    {task.status === 'running'
                      ? 'Đang xử lý...'
                      : task.status === 'completed'
                      ? 'Hoàn thành'
                      : task.status === 'failed'
                      ? 'Thất bại'
                      : 'Đang chờ'}
                  </span>
                </div>
                {task.status === 'completed' && onOpenResult && (
                  <button
                    className="action-pill"
                    onClick={() => onOpenResult(task)}
                    style={{ marginTop: 8 }}
                  >
                    Xem kết quả
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
