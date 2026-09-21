'use client';

import React, { useState, useRef, useEffect } from 'react';
import { SUBJECTS, getSubjectInfo } from '@/lib/data/subjects';

interface ComposerProps {
  onSend: (text: string, images: string[], subject: string, thinking: { deepThinking: boolean; crossCheck: boolean }) => void;
  onStop: () => void;
  isStreaming: boolean;
  selectedSubject: string;
  onSelectSubject: (subject: string) => void;
  thinkingModes: { deepThinking: boolean; crossCheck: boolean };
  onToggleThinkingMode: (mode: 'deepThinking' | 'crossCheck') => void;
}

export default function Composer({
  onSend,
  onStop,
  isStreaming,
  selectedSubject,
  onSelectSubject,
  thinkingModes,
  onToggleThinkingMode
}: ComposerProps) {
  const [inputText, setInputText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [subjectOpen, setSubjectOpen] = useState(false);
  const [thinkOpen, setThinkOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [inputText]);

  // Voice input handling via Web Speech API
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recog = new SpeechRecognition();
        recog.continuous = true;
        recog.interimResults = true;
        recog.lang = 'vi-VN';

        recog.onresult = (e: any) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; ++i) {
            if (e.results[i].isFinal) {
              setInputText((prev) => prev + ' ' + e.results[i][0].transcript);
            } else {
              interim += e.results[i][0].transcript;
            }
          }
          setVoiceInterim(interim);
        };

        recog.onerror = () => {
          setIsListening(false);
          setVoiceInterim('');
        };

        recog.onend = () => {
          setIsListening(false);
          setVoiceInterim('');
        };

        recognitionRef.current = recog;
      }
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert('Trình duyệt của bạn chưa hỗ trợ nhập bằng giọng nói.');
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch {
        setIsListening(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (!inputText.trim() && images.length === 0) return;
    if (isStreaming) return;
    onSend(inputText.trim(), images, selectedSubject, thinkingModes);
    setInputText('');
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setImages((prev) => [...prev, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const currentSub = getSubjectInfo(selectedSubject);

  return (
    <div id="composer">
      <div id="composerInner">
        {images.length > 0 && (
          <div id="imgPreviewWrap" style={{ display: 'flex', gap: 8, paddingBottom: 8 }}>
            {images.map((img, i) => (
              <div key={i} className="preview-item" style={{ position: 'relative' }}>
                <img src={img} alt="Đề bài đã chọn" className="preview-thumb" />
                <button
                  type="button"
                  className="preview-remove"
                  onClick={() => removeImage(i)}
                  title="Gỡ ảnh này"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div id="chatBar">
          <textarea
            id="qInput"
            ref={textareaRef}
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Nhập câu hỏi, dán đề bài, dán ảnh (Ctrl+V), kéo-thả ảnh hoặc tải ảnh từ máy…"
          />

          <div id="chatBarTools">
            <input
              type="file"
              id="imageInput"
              ref={fileInputRef}
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileAttach}
            />

            <button
              id="attachBtn"
              type="button"
              className="tool-btn icon-only"
              title="Tải ảnh đề bài"
              aria-label="Tải ảnh đề bài"
              onClick={() => fileInputRef.current?.click()}
            >
              📷
            </button>

            <button
              id="micBtn"
              type="button"
              className={`tool-btn icon-only ${isListening ? 'listening' : ''}`}
              title="Nhập bằng giọng nói"
              aria-label="Nhập câu hỏi bằng giọng nói"
              onClick={toggleListening}
            >
              🎙️
            </button>

            {/* Subject Selector Popover */}
            <div id="subjectBtnWrap" style={{ position: 'relative' }}>
              <button
                id="subjectBtn"
                type="button"
                className="tool-btn"
                onClick={() => setSubjectOpen(!subjectOpen)}
                aria-haspopup="true"
              >
                {currentSub.icon} {currentSub.name}
              </button>

              {subjectOpen && (
                <div
                  id="subjectPopover"
                  style={{ display: 'block' }}
                  onClick={() => setSubjectOpen(false)}
                >
                  {SUBJECTS.map((s) => (
                    <button
                      key={s.id}
                      className={`subject-opt ${selectedSubject === s.id ? 'active' : ''}`}
                      onClick={() => onSelectSubject(s.id)}
                    >
                      <span>{s.icon}</span> {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Thinking Mode Popover */}
            <div id="thinkBtnWrap" style={{ position: 'relative' }}>
              <button
                id="thinkBtn"
                type="button"
                className={`tool-btn ${thinkingModes.deepThinking || thinkingModes.crossCheck ? 'active' : ''}`}
                onClick={() => setThinkOpen(!thinkOpen)}
                aria-haspopup="true"
              >
                🧠 Chế độ suy nghĩ
              </button>

              {thinkOpen && (
                <div id="thinkPopover" style={{ display: 'block' }}>
                  <button
                    className={`think-opt ${thinkingModes.deepThinking ? 'active' : ''}`}
                    type="button"
                    onClick={() => onToggleThinkingMode('deepThinking')}
                  >
                    <span className="ic">✨</span>
                    <span className="think-opt-text">
                      <span className="tt">Suy nghĩ sâu</span>
                      <br />
                      <span className="dd">
                        AI tự phản biện, kiểm tra lại từng bước suy luận của chính mình trước khi chốt câu trả lời.
                      </span>
                    </span>
                    <span className="think-switch">
                      {thinkingModes.deepThinking ? ' [BẬT]' : ' [TẮT]'}
                    </span>
                  </button>

                  <button
                    className={`think-opt ${thinkingModes.crossCheck ? 'active' : ''}`}
                    type="button"
                    onClick={() => onToggleThinkingMode('crossCheck')}
                  >
                    <span className="ic">🧭</span>
                    <span className="think-opt-text">
                      <span className="tt">Đối chiếu đa hướng</span>
                      <br />
                      <span className="dd">
                        Tự giải 2 hướng độc lập, kiểm tra chéo công thức trước khi chốt lời giải chi tiết.
                      </span>
                    </span>
                    <span className="think-switch">
                      {thinkingModes.crossCheck ? ' [BẬT]' : ' [TẮT]'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {isStreaming ? (
              <button id="stopBtn" type="button" onClick={onStop}>
                Dừng
              </button>
            ) : (
              <button id="sendBtn" type="button" onClick={handleSend}>
                Giải bài
              </button>
            )}
          </div>
        </div>

        {isListening && (
          <div id="voiceStatus" role="status">
            <span className="voice-dot" />
            <span>Đang lắng nghe: </span>
            <span className="voice-interim">{voiceInterim || '...'}</span>
          </div>
        )}

        <div id="hint">
          Enter để gửi · Shift+Enter xuống dòng · AI sẽ đưa hướng giải trước, bấm "Xem lời giải chi tiết" khi cần
        </div>
      </div>
    </div>
  );
}
