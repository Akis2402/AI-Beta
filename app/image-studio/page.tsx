'use client';

import React, { useState } from 'react';

export default function ImageStudioPage() {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [style, setStyle] = useState('');
  const [loading, setLoading] = useState(false);
  const [resultImg, setResultImg] = useState<string | null>(null);
  const [providerBadge, setProviderBadge] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    setErrorMsg(null);
    setResultImg(null);

    try {
      const res = await fetch('/api/visual/hq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim(),
          aspectRatio,
          style
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Lỗi máy chủ (${res.status})`);
      }

      const data = await res.json();
      if (data.imageUrl || data.url) {
        setResultImg(data.imageUrl || data.url);
        setProviderBadge(data.provider || 'AI Generated');
      } else {
        throw new Error('Không nhận được ảnh từ phản hồi của máy chủ.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Không thể tạo ảnh.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!resultImg) return;
    const a = document.createElement('a');
    a.href = resultImg;
    a.download = `ai-image-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="studio-wrap" style={{ minHeight: '100vh', padding: '24px 16px' }}>
      <header className="studio-header">
        <a href="/" style={{ textDecoration: 'none', color: '#4550E6', display: 'inline-block', marginBottom: 12 }}>
          ← Quay lại Trợ Giải
        </a>
        <h1>🎨 Image Studio</h1>
        <p className="studio-subtitle">
          Tạo ảnh minh họa học tập bằng AI — Hỗ trợ tạo ảnh chất lượng cao phục vụ trực quan hóa bài toán và thí nghiệm.
        </p>
      </header>

      <main className="studio-main">
        <form id="image-form" className="studio-form" onSubmit={handleSubmit}>
          <label htmlFor="prompt-input">Mô tả hình ảnh</label>
          <textarea
            id="prompt-input"
            name="prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ví dụ: mô hình thí nghiệm bình tam giác chứa dung dịch màu xanh, có bọt khí sủi lên..."
            required
          />

          <label htmlFor="negative-prompt-input">Loại trừ (không bắt buộc)</label>
          <input
            type="text"
            id="negative-prompt-input"
            name="negativePrompt"
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder="Ví dụ: mờ, biến dạng, chữ viết sai"
          />

          <div className="studio-form-row">
            <div className="studio-field">
              <label htmlFor="aspect-ratio-select">Tỉ lệ khung hình</label>
              <select
                id="aspect-ratio-select"
                name="aspectRatio"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
              >
                <option value="1:1">Vuông (1:1)</option>
                <option value="16:9">Ngang (16:9)</option>
                <option value="9:16">Dọc (9:16)</option>
              </select>
            </div>

            <div className="studio-field">
              <label htmlFor="style-select">Phong cách</label>
              <select
                id="style-select"
                name="style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
              >
                <option value="">Mặc định</option>
                <option value="photorealistic">Ảnh thực (Photorealistic)</option>
                <option value="anime">Anime</option>
                <option value="3d-render">3D Render</option>
                <option value="cinematic">Điện ảnh (Cinematic)</option>
              </select>
            </div>
          </div>

          <button type="submit" id="generate-btn" className="studio-generate-btn" disabled={loading}>
            <span className="btn-label">{loading ? 'Đang tạo ảnh...' : 'Tạo ảnh'}</span>
          </button>
        </form>

        <section className="studio-preview" id="preview-section" aria-live="polite">
          {loading && (
            <div id="loading-skeleton" className="loading-skeleton">
              <div className="pulse-block" />
              <p className="loading-text">Đang tạo ảnh, vui lòng đợi...</p>
            </div>
          )}

          {errorMsg && (
            <div className="panel-empty" style={{ color: '#ef4444' }}>
              {errorMsg}
            </div>
          )}

          {resultImg && !loading && (
            <div id="result-container" className="result-container">
              <img id="result-image" className="result-image" src={resultImg} alt="Ảnh do AI tạo" />
              <div className="result-meta">
                {providerBadge && (
                  <span id="result-provider" className="result-provider-badge">
                    {providerBadge}
                  </span>
                )}
                <button
                  type="button"
                  id="download-btn"
                  className="studio-download-btn"
                  onClick={handleDownload}
                >
                  ⬇ Tải ảnh xuống
                </button>
              </div>
            </div>
          )}

          {!resultImg && !loading && !errorMsg && (
            <div id="empty-state" className="empty-state">
              <p>Ảnh của bạn sẽ hiện ở đây sau khi tạo.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
