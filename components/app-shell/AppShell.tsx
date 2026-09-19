'use client';

import React, { useState, useEffect, useRef } from 'react';
import Sidebar from '../sidebar/Sidebar';
import TopBar from '../chat/TopBar';
import Thread, { ChatMessage } from '../chat/Thread';
import Composer from '../composer/Composer';
import SettingsModal, { UserSettings } from '../settings/SettingsModal';
import AddSourceModal from '../source-panel/AddSourceModal';
import NoteModal from '../notes/NoteModal';
import PracticeModal from '../study-tools/PracticeModal';
import FlashcardDrawer, { Flashcard } from '../flashcards/FlashcardDrawer';
import RecommendDrawer, { RecommendItem } from '../study-tools/RecommendDrawer';
import BackgroundTaskDrawer, { BackgroundTask } from '../study-tools/BackgroundTaskDrawer';

export default function AppShell() {
  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'sources' | 'history' | 'notes' | 'formulas'>('sources');

  // Chat state
  const [chatTitle, setChatTitle] = useState('Buổi học mới');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'ready' | 'thinking' | 'streaming' | 'error'>('ready');
  const [selectedSubject, setSelectedSubject] = useState('auto');
  const [thinkingModes, setThinkingModes] = useState({ deepThinking: false, crossCheck: false });

  // Persistent user resources
  const [sources, setSources] = useState<any[]>([]);
  const [recentSources, setRecentSources] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>([]);

  // Modals state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddSourceOpen, setIsAddSourceOpen] = useState(false);
  const [isNoteModalOpen, setIsNoteModalOpen] = useState(false);
  const [currentNoteData, setCurrentNoteData] = useState<{ id?: string; question: string; text: string }>({
    question: '',
    text: ''
  });
  const [isPracticeModalOpen, setIsPracticeModalOpen] = useState(false);
  const [practiceTopic, setPracticeTopic] = useState('');

  // Drawers state
  const [isFlashcardOpen, setIsFlashcardOpen] = useState(false);
  const [flashcardData, setFlashcardData] = useState<{ topic: string; cards: Flashcard[] }>({
    topic: '',
    cards: []
  });
  const [isRecommendOpen, setIsRecommendOpen] = useState(false);
  const [recommendData, setRecommendData] = useState<{ topic: string; items: RecommendItem[] }>({
    topic: '',
    items: []
  });
  const [isBgTasksOpen, setIsBgTasksOpen] = useState(false);

  // User Settings
  const [settings, setSettings] = useState<UserSettings>({
    detail: 'tiêu chuẩn',
    visual: 'auto',
    language: 'Tiếng Việt',
    theme: 'light',
    school: 'thpt',
    grade: '10',
    rules: []
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  // Load saved preferences on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const savedTheme = localStorage.getItem('theme_pref') as 'light' | 'dark' | null;
        if (savedTheme) {
          setTheme(savedTheme);
          document.documentElement.dataset.theme = savedTheme;
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
          setTheme('dark');
          document.documentElement.dataset.theme = 'dark';
        }

        const savedSettings = localStorage.getItem('user_settings');
        if (savedSettings) setSettings(JSON.parse(savedSettings));

        const savedNotes = localStorage.getItem('study_notes');
        if (savedNotes) setNotes(JSON.parse(savedNotes));

        const savedHistory = localStorage.getItem('study_history');
        if (savedHistory) setHistory(JSON.parse(savedHistory));

        const savedSources = localStorage.getItem('study_sources');
        if (savedSources) setSources(JSON.parse(savedSources));

        const savedRecentSources = localStorage.getItem('recent_sources');
        if (savedRecentSources) setRecentSources(JSON.parse(savedRecentSources));
      } catch {}
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme_pref', next);
    } catch {}
  };

  const handleUpdateSettings = (newVal: Partial<UserSettings>) => {
    const updated = { ...settings, ...newVal };
    setSettings(updated);
    try {
      localStorage.setItem('user_settings', JSON.stringify(updated));
    } catch {}
  };

  const handleToggleThinkingMode = (mode: 'deepThinking' | 'crossCheck') => {
    setThinkingModes((prev) => ({
      ...prev,
      [mode]: !prev[mode]
    }));
  };

  const handleNewChat = () => {
    if (messages.length > 0) {
      const newSession = {
        id: 'sess_' + Date.now(),
        title: chatTitle,
        subject: selectedSubject,
        createdAt: new Date().toISOString(),
        messageCount: messages.length,
        messages: [...messages]
      };
      const updatedHist = [newSession, ...history.slice(0, 29)];
      setHistory(updatedHist);
      try {
        localStorage.setItem('study_history', JSON.stringify(updatedHist));
      } catch {}
    }
    setMessages([]);
    setChatTitle('Buổi học mới');
    setStatus('ready');
    setSidebarOpen(false);
  };

  const handleSelectHistory = (item: any) => {
    setChatTitle(item.title || 'Buổi học cũ');
    setMessages(item.messages || []);
    if (item.subject) setSelectedSubject(item.subject);
    setSidebarOpen(false);
  };

  const handleDeleteHistory = (id: string) => {
    const filtered = history.filter((h) => h.id !== id);
    setHistory(filtered);
    try {
      localStorage.setItem('study_history', JSON.stringify(filtered));
    } catch {}
  };

  // Add source files
  const handleAddSourceFiles = async (files: FileList | File[]) => {
    const newItems: any[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      const ext = file.name.split('.').pop()?.toLowerCase() || 'txt';
      const item = {
        id: 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: file.name,
        type: ext,
        size: file.size,
        text: text.slice(0, 50000)
      };
      newItems.push(item);
    }
    const updated = [...sources, ...newItems];
    setSources(updated);
    const updatedRecent = [...newItems, ...recentSources].slice(0, 10);
    setRecentSources(updatedRecent);
    try {
      localStorage.setItem('study_sources', JSON.stringify(updated));
      localStorage.setItem('recent_sources', JSON.stringify(updatedRecent));
    } catch {}
  };

  // Add source URL (web or youtube)
  const handleAddSourceUrl = async (url: string) => {
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    const endpoint = isYoutube ? '/api/source/youtube' : '/api/source/web';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Lỗi khi trích xuất tài liệu từ URL');
    }
    const data = await res.json();
    const item = {
      id: 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: data.title || url,
      type: isYoutube ? 'youtube' : 'web',
      url,
      text: data.content || data.transcript || ''
    };
    const updated = [...sources, item];
    setSources(updated);
    const updatedRecent = [item, ...recentSources].slice(0, 10);
    setRecentSources(updatedRecent);
    try {
      localStorage.setItem('study_sources', JSON.stringify(updated));
      localStorage.setItem('recent_sources', JSON.stringify(updatedRecent));
    } catch {}
  };

  const handleRemoveSource = (id: string) => {
    const updated = sources.filter((s) => s.id !== id);
    setSources(updated);
    try {
      localStorage.setItem('study_sources', JSON.stringify(updated));
    } catch {}
  };

  // Note management
  const handleSaveNote = (noteText: string) => {
    const newNote = {
      id: currentNoteData.id || 'note_' + Date.now(),
      question: currentNoteData.question,
      note: noteText,
      createdAt: new Date().toISOString()
    };
    const existingIndex = notes.findIndex((n) => n.id === newNote.id);
    let updated;
    if (existingIndex >= 0) {
      updated = [...notes];
      updated[existingIndex] = newNote;
    } else {
      updated = [newNote, ...notes];
    }
    setNotes(updated);
    try {
      localStorage.setItem('study_notes', JSON.stringify(updated));
    } catch {}
  };

  const handleDeleteNote = () => {
    if (!currentNoteData.id) return;
    const updated = notes.filter((n) => n.id !== currentNoteData.id);
    setNotes(updated);
    try {
      localStorage.setItem('study_notes', JSON.stringify(updated));
    } catch {}
  };

  // Practice generation
  const handleGeneratePractice = async (topic: string, difficulty: string, count: number) => {
    try {
      setStatus('thinking');
      const res = await fetch('/api/study/similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problem: topic,
          difficulty,
          count,
          language: settings.language
        })
      });
      const data = await res.json();
      if (data.problem || data.text) {
        const assistantMsg: ChatMessage = {
          id: 'msg_' + Date.now(),
          role: 'assistant',
          content: `🎯 **Bài tập luyện tập tương tự (${difficulty === 'easier' ? 'Củng cố' : difficulty === 'harder' ? 'Nâng cao' : 'Tương đương'}):**\n\n${data.problem || data.text}`,
          approach: data.approach,
          detail: data.solution || data.detail,
          showDetail: false
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStatus('ready');
      }
    } catch {
      setStatus('error');
    }
  };

  // Flashcards generation
  const handleOpenFlashcardsForMessage = async (msg: ChatMessage) => {
    setIsFlashcardOpen(true);
    setFlashcardData({
      topic: msg.content?.slice(0, 40) || 'Đang tạo...',
      cards: [{ q: 'Đang trích xuất câu hỏi ôn tập từ nội dung bài...', a: 'Vui lòng đợi giây lát...' }]
    });

    try {
      const res = await fetch('/api/generate/flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: msg.content?.slice(0, 100) || 'Kiến thức cốt lõi',
          context: (msg.approach || '') + '\n' + (msg.detail || msg.content || '')
        })
      });
      const data = await res.json();
      if (Array.isArray(data.flashcards) && data.flashcards.length > 0) {
        setFlashcardData({
          topic: data.topic || 'Ôn tập cốt lõi',
          cards: data.flashcards.map((f: any) => ({
            q: f.question || f.front || f.q,
            a: f.answer || f.back || f.a
          }))
        });
      }
    } catch {}
  };

  // Self check
  const handleSelfCheckForMessage = async (msg: ChatMessage) => {
    const studentAnswer = prompt('Nhập bài làm của bạn để AI kiểm tra từng bước tính và chỉ ra điểm cần sửa:');
    if (!studentAnswer) return;

    try {
      setStatus('thinking');
      const res = await fetch('/api/study/self-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problem: msg.content || 'Đề bài',
          studentAttempt: studentAnswer,
          referenceSolution: msg.detail || msg.approach || '',
          language: settings.language
        })
      });
      const data = await res.json();
      const checkMsg: ChatMessage = {
        id: 'msg_' + Date.now(),
        role: 'assistant',
        content: `🔍 **Kết quả kiểm tra bài làm của bạn:**\n\n**Bài làm học sinh:** ${studentAnswer}\n\n${data.feedback || data.evaluation || data.detail || 'Bài làm đã được kiểm tra.'}`
      };
      setMessages((prev) => [...prev, checkMsg]);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  // Send message
  const handleSend = async (
    text: string,
    images: string[],
    subject: string,
    modes: { deepThinking: boolean; crossCheck: boolean }
  ) => {
    if (messages.length === 0) {
      setChatTitle(text.slice(0, 30) || 'Buổi học mới');
    }

    const userMsg: ChatMessage = {
      id: 'msg_user_' + Date.now(),
      role: 'user',
      content: text,
      images,
      subject
    };

    const assistantMsgId = 'msg_bot_' + (Date.now() + 1);
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      showDetail: true
    };

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setStatus('thinking');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const payload = {
        message: text,
        images,
        subject,
        deepThinking: modes.deepThinking,
        crossCheck: modes.crossCheck,
        detailLevel: settings.detail,
        visualPreference: settings.visual,
        language: settings.language,
        schoolGrade: settings.grade,
        rules: settings.rules,
        sources: sources.map((s) => ({
          name: s.name,
          type: s.type,
          text: s.text?.slice(0, 10000)
        })),
        history: messages.slice(-10).map((m) => ({
          role: m.role,
          content: m.content || m.detail || ''
        }))
      };

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      setStatus('streaming');

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamedContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.content || parsed.text) {
                  streamedContent += (parsed.content || parsed.text);
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: streamedContent } : m
                    )
                  );
                } else if (parsed.approach || parsed.detail) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? {
                            ...m,
                            approach: parsed.approach || m.approach,
                            detail: parsed.detail || m.detail,
                            thinking: parsed.thinking || m.thinking,
                            visuals: parsed.visuals || m.visuals,
                            sources: parsed.sources || m.sources
                          }
                        : m
                    )
                  );
                }
              } catch {}
            }
          }
        }
      } else {
        const json = await res.json();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: json.content || json.text || '',
                  approach: json.approach,
                  detail: json.detail,
                  thinking: json.thinking,
                  visuals: json.visuals,
                  sources: json.sources
                }
              : m
          )
        );
      }
      setStatus('ready');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setStatus('ready');
      } else {
        setStatus('error');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: `❌ Gặp sự cố khi kết nối: ${err.message || 'Vui lòng thử lại sau.'}`
                }
              : m
          )
        );
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStatus('ready');
  };

  return (
    <div id="app">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewChat}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        sources={sources}
        onAddSourceClick={() => setIsAddSourceOpen(true)}
        onRemoveSource={handleRemoveSource}
        history={history}
        onSelectHistory={handleSelectHistory}
        onDeleteHistory={handleDeleteHistory}
        notes={notes}
        onOpenNote={(n) => {
          setCurrentNoteData({ id: n.id, question: n.question, text: n.note });
          setIsNoteModalOpen(true);
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        schoolGrade={settings.grade}
      />

      <main id="main">
        <TopBar
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          title={chatTitle}
          gradeBadge={`Lớp ${settings.grade}`}
          status={status}
          bgTaskCount={bgTasks.filter((t) => t.status === 'running').length}
          onOpenBgTasks={() => setIsBgTasksOpen(true)}
          onOpenFlashcards={() => setIsFlashcardOpen(true)}
          onOpenRecommend={() => setIsRecommendOpen(true)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />

        <Thread
          messages={messages}
          onPromptClick={(text) => handleSend(text, [], selectedSubject, thinkingModes)}
          onSaveNote={(msg) => {
            setCurrentNoteData({
              question: msg.content?.slice(0, 80) || 'Lời giải đã chọn',
              text: ''
            });
            setIsNoteModalOpen(true);
          }}
          onPractice={(msg) => {
            setPracticeTopic(msg.content || '');
            setIsPracticeModalOpen(true);
          }}
          onFlashcards={handleOpenFlashcardsForMessage}
          onSelfCheck={handleSelfCheckForMessage}
          onToggleDetail={(id) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id ? { ...m, showDetail: m.showDetail === false } : m
              )
            );
          }}
        />

        <Composer
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={status === 'streaming' || status === 'thinking'}
          selectedSubject={selectedSubject}
          onSelectSubject={setSelectedSubject}
          thinkingModes={thinkingModes}
          onToggleThinkingMode={handleToggleThinkingMode}
        />
      </main>

      {/* Modals and Drawers */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onClearHistory={() => setMessages([])}
      />

      <AddSourceModal
        isOpen={isAddSourceOpen}
        onClose={() => setIsAddSourceOpen(false)}
        onAddFiles={handleAddSourceFiles}
        onAddUrl={handleAddSourceUrl}
        recentSources={recentSources}
        onSelectRecent={(src) => {
          if (!sources.some((s) => s.id === src.id)) {
            setSources((prev) => [...prev, src]);
          }
        }}
      />

      <NoteModal
        isOpen={isNoteModalOpen}
        onClose={() => setIsNoteModalOpen(false)}
        question={currentNoteData.question}
        initialNote={currentNoteData.text}
        onSave={handleSaveNote}
        onDelete={currentNoteData.id ? handleDeleteNote : undefined}
      />

      <PracticeModal
        isOpen={isPracticeModalOpen}
        onClose={() => setIsPracticeModalOpen(false)}
        initialTopic={practiceTopic}
        onGenerate={handleGeneratePractice}
      />

      <FlashcardDrawer
        isOpen={isFlashcardOpen}
        onClose={() => setIsFlashcardOpen(false)}
        topic={flashcardData.topic}
        cards={flashcardData.cards}
      />

      <RecommendDrawer
        isOpen={isRecommendOpen}
        onClose={() => setIsRecommendOpen(false)}
        topic={recommendData.topic}
        items={recommendData.items}
      />

      <BackgroundTaskDrawer
        isOpen={isBgTasksOpen}
        onClose={() => setIsBgTasksOpen(false)}
        tasks={bgTasks}
      />
    </div>
  );
}
