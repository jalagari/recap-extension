/**
 * Recap - Core Utilities (ESM)
 * @version 3.0.0
 */

// ============================================================================
// LOGGING
// ============================================================================

export const DEBUG = true;

export const Log = {
  debug: (...args) => DEBUG && console.log('[Recap]', ...args),
  info: (...args) => console.log('[Recap]', ...args),
  warn: (...args) => console.warn('[Recap]', ...args),
  error: (...args) => console.error('[Recap]', ...args)
};

// ============================================================================
// DOM UTILITIES
// ============================================================================

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export const escapeHtml = (text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

export const formatTime = (ms) => {
  const secs = Math.floor((ms || 0) / 1000);
  const mins = Math.floor(secs / 60);
  return `${mins}:${(secs % 60).toString().padStart(2, '0')}`;
};

export const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return formatTime(ms);
};

export const formatRelativeTime = (date) => {
  if (!date) return 'Unknown';
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(date).toLocaleDateString();
};

// ============================================================================
// URL UTILITIES
// ============================================================================

export const UrlUtils = {
  getPathname: (url) => {
    try { return new URL(url).pathname; } 
    catch { return url; }
  },
  
  getHostname: (url) => {
    try { return new URL(url).hostname; } 
    catch { return ''; }
  },
  
  getOrigin: (url) => {
    try { return new URL(url).origin; } 
    catch { return ''; }
  },
  
  // Create pattern from full URL (includes origin for uniqueness)
  createPattern: (url) => {
    try {
      const u = new URL(url);
      // Use origin + pathname (without trailing slash) + optional wildcard
      return (u.origin + u.pathname).replace(/\/$/, '');
    } catch {
      return url.replace(/\/$/, '');
    }
  },
  
  // Match URL against pattern
  matchPattern: (url, pattern) => {
    if (!url || !pattern) return false;
    
    try {
      const urlNormalized = url.split('?')[0].split('#')[0].replace(/\/$/, '');
      const patternNormalized = pattern.replace(/\/$/, '').replace(/\/\*$/, '');
      
      // Exact match
      if (urlNormalized === patternNormalized) return true;
      
      // Wildcard match (pattern ends with /*)
      if (pattern.endsWith('/*')) {
        return urlNormalized.startsWith(patternNormalized);
      }
      
      // Partial match (URL starts with pattern)
      return urlNormalized.startsWith(patternNormalized);
    } catch {
      return false;
    }
  }
};

// ============================================================================
// ID GENERATION
// ============================================================================

export const generateId = (prefix = 'id') => 
  `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

export const Toast = {
  container: null,
  
  show(message, type = 'info', duration = 3000) {
    if (!this.container) {
      this.container = document.getElementById('toast-container');
    }
    if (!this.container) return;
    
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${escapeHtml(message)}</span>`;
    
    this.container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  
  success: (msg) => Toast.show(msg, 'success'),
  error: (msg) => Toast.show(msg, 'error', 5000),
  warning: (msg) => Toast.show(msg, 'warning'),
  info: (msg) => Toast.show(msg, 'info')
};

