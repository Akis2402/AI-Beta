'use strict';

(function () {
  const form = document.getElementById('image-form');
  const promptInput = document.getElementById('prompt-input');
  const negativePromptInput = document.getElementById('negative-prompt-input');
  const aspectRatioSelect = document.getElementById('aspect-ratio-select');
  const styleSelect = document.getElementById('style-select');
  const generateBtn = document.getElementById('generate-btn');

  const loadingSkeleton = document.getElementById('loading-skeleton');
  const resultContainer = document.getElementById('result-container');
  const emptyState = document.getElementById('empty-state');
  const resultImage = document.getElementById('result-image');
  const resultProviderBadge = document.getElementById('result-provider');
  const downloadBtn = document.getElementById('download-btn');

  let lastImageSrc = null;

  function setLoading(isLoading) {
    generateBtn.disabled = isLoading;
    generateBtn.querySelector('.btn-label').textContent = isLoading ? 'Đang tạo ảnh...' : 'Tạo ảnh';
    loadingSkeleton.hidden = !isLoading;
    if (isLoading) {
      resultContainer.hidden = true;
      emptyState.hidden = true;
    }
  }

  function showResult(imageSrc, provider) {
    lastImageSrc = imageSrc;
    resultImage.src = imageSrc;
    resultProviderBadge.textContent = provider === 'gemini' ? 'Gemini Imagen 3' : 'OpenAI DALL-E 3 (Fallback)';
    resultContainer.hidden = false;
    emptyState.hidden = true;
    loadingSkeleton.hidden = true;
  }

  function showEmpty() {
    resultContainer.hidden = true;
    loadingSkeleton.hidden = true;
    emptyState.hidden = false;
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt) {
      alert('Vui lòng nhập mô tả hình ảnh trước khi tạo.');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/visual/generate-v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          aspectRatio: aspectRatioSelect.value,
          style: styleSelect.value,
          negativePrompt: negativePromptInput.value.trim()
        })
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.success !== true) {
        const message = (payload && payload.error) ? payload.error : 'Hệ thống tạo ảnh hiện đang quá tải, vui lòng thử lại sau.';
        alert(message);
        showEmpty();
        return;
      }

      const images = payload.data && Array.isArray(payload.data.images) ? payload.data.images : [];
      if (images.length === 0) {
        alert('Hệ thống tạo ảnh hiện đang quá tải, vui lòng thử lại sau.');
        showEmpty();
        return;
      }

      showResult(images[0], payload.data.provider);
    } catch (networkError) {
      console.error('[image-studio] Lỗi mạng khi gọi /api/visual/generate-v2:', networkError);
      alert('Không thể kết nối tới máy chủ. Vui lòng kiểm tra mạng và thử lại.');
      showEmpty();
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!lastImageSrc) return;
    const link = document.createElement('a');
    link.href = lastImageSrc;
    link.download = `image-studio-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  form.addEventListener('submit', handleSubmit);
  downloadBtn.addEventListener('click', handleDownload);
})();
