/*
 * public/js/speed-insights.js — tích hợp Vercel Speed Insights cho vanilla HTML/JS.
 * 
 * Script này khởi tạo Vercel Speed Insights để theo dõi Core Web Vitals và các chỉ số hiệu suất
 * khác. Dữ liệu chỉ được thu thập trên production (không thu thập ở development).
 * 
 * Tài liệu: https://vercel.com/docs/speed-insights/quickstart
 */

'use strict';

(function() {
  // Chỉ chạy trong môi trường browser
  if (typeof window === 'undefined') return;

  // Khởi tạo queue cho Speed Insights
  if (!window.si) {
    window.si = function() {
      (window.siq = window.siq || []).push(arguments);
    };
  }

  // Tránh inject script nhiều lần
  const scriptSrc = '/_vercel/speed-insights/script.js';
  if (document.querySelector(`script[src*="${scriptSrc}"]`)) return;

  // Tạo và inject script tag
  const script = document.createElement('script');
  script.defer = true;
  script.src = scriptSrc;
  
  // Thêm dataset cho SDK info
  script.setAttribute('data-sdkn', '@vercel/speed-insights');
  script.setAttribute('data-sdkv', '2.0.0');

  // Error handler nếu script không load được (vd: content blocker)
  script.onerror = function() {
    console.log(
      '[Vercel Speed Insights] Failed to load script. Please check if any content blockers are enabled.'
    );
  };

  // Inject vào head
  document.head.appendChild(script);
})();
