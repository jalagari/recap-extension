/**
 * Report Button Module
 * Floating FAB for user feedback
 * @module sdk/quality/report-button
 */

import { State } from '../core/state.js';
import { Logger } from '../core/logger.js';
import { Scorer } from './scorer.js';

/** @type {HTMLElement|null} Button element */
let buttonEl = null;

/** @type {HTMLElement|null} Modal element */
let modalEl = null;

/** @type {Object} Configuration */
let config = {
  enabled: false,
  mode: 'on_error',
  position: 'bottom-right',
  showAfterScore: 40,
  autoHideMs: 15000,
  categories: ['Bug', 'Slow', 'Confusing', 'Other'],
  allowComment: true,
  onReport: null
};

/** @type {number|null} Auto-hide timer */
let hideTimer = null;

/** CSS Styles */
const STYLES = `
.recap-report-btn {
  position: fixed;
  z-index: 999999;
  padding: 12px 20px;
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 50px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}
.recap-report-btn:hover {
  background: #dc2626;
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0,0,0,0.25);
}
.recap-report-btn.bottom-right { bottom: 20px; right: 20px; }
.recap-report-btn.bottom-left { bottom: 20px; left: 20px; }
.recap-report-btn.top-right { top: 20px; right: 20px; }

.recap-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 9999999;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.recap-modal-overlay.visible { opacity: 1; }

.recap-modal {
  background: white;
  border-radius: 12px;
  width: 90%;
  max-width: 400px;
  max-height: 90vh;
  overflow: auto;
  box-shadow: 0 20px 40px rgba(0,0,0,0.3);
  transform: translateY(20px);
  transition: transform 0.2s ease;
}
.recap-modal-overlay.visible .recap-modal {
  transform: translateY(0);
}

.recap-modal-header {
  padding: 20px;
  border-bottom: 1px solid #e5e7eb;
}
.recap-modal-header h3 {
  margin: 0;
  font-size: 18px;
  color: #1f2937;
}

.recap-modal-body {
  padding: 20px;
}

.recap-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.recap-category {
  padding: 8px 16px;
  background: #f3f4f6;
  border: 2px solid transparent;
  border-radius: 20px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}
.recap-category:hover { background: #e5e7eb; }
.recap-category.selected {
  background: #eff6ff;
  border-color: #3b82f6;
  color: #1d4ed8;
}

.recap-comment {
  width: 100%;
  min-height: 80px;
  padding: 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
  margin-bottom: 16px;
}
.recap-comment:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
}

.recap-modal-footer {
  padding: 16px 20px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.recap-btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.recap-btn-secondary {
  background: white;
  border: 1px solid #d1d5db;
  color: #374151;
}
.recap-btn-secondary:hover { background: #f9fafb; }
.recap-btn-primary {
  background: #3b82f6;
  border: none;
  color: white;
}
.recap-btn-primary:hover { background: #2563eb; }
.recap-btn-primary:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}

.recap-thank-you {
  text-align: center;
  padding: 40px 20px;
}
.recap-thank-you-icon { font-size: 48px; margin-bottom: 16px; }
.recap-thank-you-text { font-size: 16px; color: #374151; }
`;

/**
 * Report Button Manager
 */
export const ReportButton = {
  /**
   * Initialize report button
   * @param {Object} cfg - Button configuration
   */
  init(cfg = {}) {
    config = { ...config, ...cfg };
    
    if (!config.enabled) {
      Logger.debug('ReportButton disabled');
      return;
    }
    
    // Inject styles
    this._injectStyles();
    
    // Create button
    this._createButton();
    
    // Show based on mode
    if (config.mode === 'always') {
      this.show();
    }
    
    // Subscribe to score changes for 'on_error' mode
    if (config.mode === 'on_error') {
      State.subscribe((state) => {
        const score = state.quality?.score || 0;
        if (score >= config.showAfterScore && !buttonEl?.classList.contains('visible')) {
          this.show();
        }
      });
    }
    
    Logger.debug('ReportButton initialized:', config.mode);
  },
  
  /**
   * Show the report button
   */
  show() {
    if (!buttonEl) return;
    
    buttonEl.style.display = 'flex';
    
    // Auto-hide timer
    if (config.autoHideMs > 0) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => this.hide(), config.autoHideMs);
    }
    
    Logger.debug('ReportButton shown');
  },
  
  /**
   * Hide the report button
   */
  hide() {
    if (!buttonEl) return;
    buttonEl.style.display = 'none';
    
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  },
  
  /**
   * Open feedback modal
   */
  openModal() {
    if (!modalEl) {
      this._createModal();
    }
    
    modalEl.classList.add('visible');
    this.hide();
  },
  
  /**
   * Close feedback modal
   */
  closeModal() {
    if (modalEl) {
      modalEl.classList.remove('visible');
    }
  },
  
  /**
   * Submit report
   * @param {Object} report - Report data
   */
  submit(report) {
    const fullReport = {
      ...report,
      sessionId: State.get().sessionId,
      timestamp: Date.now(),
      url: location.href,
      qualityScore: Scorer.getScore(),
      qualitySignals: Scorer.getSignals()
    };
    
    Logger.info('Report submitted:', fullReport);
    
    // Call callback
    if (config.onReport) {
      try {
        config.onReport(fullReport);
      } catch (e) {
        Logger.error('onReport callback error:', e);
      }
    }
    
    // Show thank you
    this._showThankYou();
  },
  
  /**
   * Destroy button and modal
   */
  destroy() {
    if (buttonEl) {
      buttonEl.remove();
      buttonEl = null;
    }
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  },
  
  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================
  
  /**
   * Inject CSS styles
   * @private
   */
  _injectStyles() {
    if (document.getElementById('recap-report-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'recap-report-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  },
  
  /**
   * Create button element
   * @private
   */
  _createButton() {
    buttonEl = document.createElement('button');
    buttonEl.className = `recap-report-btn ${config.position}`;
    buttonEl.innerHTML = '🐛 Report Issue';
    buttonEl.style.display = 'none';
    
    buttonEl.addEventListener('click', () => this.openModal());
    
    document.body.appendChild(buttonEl);
  },
  
  /**
   * Create modal element
   * @private
   */
  _createModal() {
    modalEl = document.createElement('div');
    modalEl.className = 'recap-modal-overlay';
    
    const categoriesHtml = config.categories.map(cat => 
      `<button class="recap-category" data-category="${cat}">${cat}</button>`
    ).join('');
    
    modalEl.innerHTML = `
      <div class="recap-modal">
        <div class="recap-modal-header">
          <h3>What went wrong?</h3>
        </div>
        <div class="recap-modal-body">
          <div class="recap-categories">${categoriesHtml}</div>
          ${config.allowComment ? 
            `<textarea class="recap-comment" placeholder="Describe the issue (optional)"></textarea>` : 
            ''}
        </div>
        <div class="recap-modal-footer">
          <button class="recap-btn recap-btn-secondary recap-cancel">Cancel</button>
          <button class="recap-btn recap-btn-primary recap-submit" disabled>Submit</button>
        </div>
      </div>
    `;
    
    // Event handlers
    let selectedCategory = null;
    
    modalEl.querySelectorAll('.recap-category').forEach(btn => {
      btn.addEventListener('click', () => {
        modalEl.querySelectorAll('.recap-category').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedCategory = btn.dataset.category;
        modalEl.querySelector('.recap-submit').disabled = false;
      });
    });
    
    modalEl.querySelector('.recap-cancel').addEventListener('click', () => {
      this.closeModal();
    });
    
    modalEl.querySelector('.recap-submit').addEventListener('click', () => {
      const comment = modalEl.querySelector('.recap-comment')?.value || '';
      this.submit({ category: selectedCategory, comment });
    });
    
    // Close on overlay click
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) this.closeModal();
    });
    
    document.body.appendChild(modalEl);
  },
  
  /**
   * Show thank you message
   * @private
   */
  _showThankYou() {
    if (!modalEl) return;
    
    const modal = modalEl.querySelector('.recap-modal');
    modal.innerHTML = `
      <div class="recap-thank-you">
        <div class="recap-thank-you-icon">✅</div>
        <div class="recap-thank-you-text">Thanks for your feedback!</div>
      </div>
    `;
    
    setTimeout(() => this.closeModal(), 2000);
  }
};


