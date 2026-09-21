// Vercel Web Analytics initialization
// This file initializes Vercel Web Analytics for tracking page views and events
(function() {
  'use strict';

  // Initialize the analytics queue
  function initQueue() {
    if (window.va) return;
    window.va = function() {
      (window.vaq = window.vaq || []).push(arguments);
    };
  }

  // Inject the Vercel analytics script
  function injectAnalytics() {
    initQueue();
    
    // Set mode based on environment
    const mode = window.location.hostname === 'localhost' || 
                 window.location.hostname === '127.0.0.1' 
                 ? 'development' 
                 : 'production';
    window.vam = mode;
    
    if (window.vai) return;
    window.vai = true;
    
    // Create and inject the analytics script
    const script = document.createElement('script');
    script.defer = true;
    script.src = '/_vercel/insights/script.js';
    
    // Add error handling
    script.onerror = function() {
      console.warn('[Analytics] Failed to load Vercel analytics script');
    };
    
    // Append to document head
    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript && firstScript.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else {
      document.head.appendChild(script);
    }
  }

  // Initialize analytics when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAnalytics);
  } else {
    injectAnalytics();
  }
})();
