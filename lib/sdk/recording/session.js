/**
 * Session Persistence Module
 * Handles cross-page recording via sessionStorage
 * @module sdk/recording/session
 */

import { State } from '../core/state.js';
import { Logger } from '../core/logger.js';

/** Storage key */
const STORAGE_KEY = 'recap_sdk_session';

/**
 * Session Persistence Manager
 */
export const Session = {
  /**
   * Save current session to sessionStorage
   * For cross-page continuation
   */
  save() {
    const state = State.get();
    if (!state.recording) return;
    
    try {
      const data = {
        sessionId: state.sessionId,
        config: state.config,
        startTime: state.startTime,
        quality: state.quality,
        recording: true,
        savedAt: Date.now()
      };
      
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      Logger.debug('Session saved for cross-page continuation');
    } catch (e) {
      Logger.error('Session save failed:', e);
    }
  },
  
  /**
   * Load saved session from sessionStorage
   * @returns {Object|null} Saved session data
   */
  load() {
    try {
      const data = sessionStorage.getItem(STORAGE_KEY);
      if (!data) return null;
      
      const session = JSON.parse(data);
      
      // Check if session is still valid (not too old)
      const maxAge = 30 * 60 * 1000; // 30 minutes
      if (Date.now() - session.savedAt > maxAge) {
        Logger.debug('Session expired, clearing');
        this.clear();
        return null;
      }
      
      return session;
    } catch (e) {
      Logger.error('Session load failed:', e);
      return null;
    }
  },
  
  /**
   * Clear saved session
   */
  clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      Logger.debug('Session cleared');
    } catch (e) {}
  },
  
  /**
   * Check if there's a session to resume
   * @returns {boolean}
   */
  hasSession() {
    return this.load() !== null;
  },
  
  /**
   * Setup page unload handlers for session persistence
   * @param {Function} onUnload - Optional callback before unload
   */
  setupUnloadHandlers(onUnload) {
    const handler = () => {
      if (onUnload) {
        try {
          onUnload();
        } catch (e) {}
      }
      this.save();
    };
    
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    
    Logger.debug('Unload handlers configured');
  }
};

