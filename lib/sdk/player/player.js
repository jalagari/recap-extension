/**
 * Recap Player Module
 * Uses extension's bundled rrweb-player
 * @module sdk/player
 */

let playerInstance = null;
let rrwebPlayerLoaded = false;

/**
 * Load rrweb-player from extension bundle
 */
async function loadRrwebPlayer() {
  if (rrwebPlayerLoaded) return true;
  
  // Check if already loaded
  if (typeof rrwebPlayer !== 'undefined') {
    rrwebPlayerLoaded = true;
    return true;
  }
  
  try {
    // Load CSS from extension
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('lib/rrweb-player.min.css');
    document.head.appendChild(css);
    
    // Load JS from extension
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('lib/rrweb-player.min.js');
    
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    
    rrwebPlayerLoaded = true;
    console.log('[Recap Player] rrweb-player loaded from extension');
    return true;
  } catch (e) {
    console.error('[Recap Player] Failed to load rrweb-player:', e);
    return false;
  }
}

/**
 * Recap Player
 */
export const RecapPlayer = {
  /**
   * Initialize and play recording
   * @param {HTMLElement} container - Container element
   * @param {Array} events - rrweb events
   * @param {Object} options - Player options
   * @returns {Object} Player instance
   */
  async play(container, events, options = {}) {
    if (!container) {
      console.error('[Recap Player] Container element required');
      return null;
    }
    
    if (!events || events.length === 0) {
      console.error('[Recap Player] No events to play');
      return null;
    }
    
    // Load player if needed
    const loaded = await loadRrwebPlayer();
    if (!loaded) {
      console.error('[Recap Player] Failed to load player library');
      return null;
    }
    
    // Destroy previous instance
    this.destroy();
    
    // Clear container
    container.innerHTML = '';
    
    // Default options
    const playerOptions = {
      target: container,
      props: {
        events,
        width: options.width || container.clientWidth || 800,
        height: options.height || 500,
        autoPlay: options.autoPlay ?? false,
        showController: options.showController ?? true,
        speedOption: options.speedOption || [1, 2, 4, 8],
        skipInactive: options.skipInactive ?? true,
        mouseTail: options.mouseTail ?? false, // Disable red cursor trail by default
        ...options.props
      }
    };
    
    try {
      // Create player instance
      playerInstance = new rrwebPlayer(playerOptions);
      
      // Setup event listeners
      if (options.onTimeUpdate) {
        playerInstance.addEventListener('ui-update-current-time', (e) => {
          options.onTimeUpdate(e.payload);
        });
      }
      
      if (options.onStateChange) {
        playerInstance.addEventListener('ui-update-player-state', (e) => {
          options.onStateChange(e.payload);
        });
      }
      
      console.log('[Recap Player] Initialized with', events.length, 'events');
      return playerInstance;
    } catch (e) {
      console.error('[Recap Player] Failed to initialize:', e);
      return null;
    }
  },
  
  /**
   * Play/resume playback
   */
  resume() {
    if (playerInstance) {
      playerInstance.play();
    }
  },
  
  /**
   * Pause playback
   */
  pause() {
    if (playerInstance) {
      playerInstance.pause();
    }
  },
  
  /**
   * Toggle play/pause
   */
  toggle() {
    if (playerInstance) {
      playerInstance.toggle();
    }
  },
  
  /**
   * Seek to time
   * @param {number} timeOffset - Time in milliseconds
   */
  goto(timeOffset) {
    if (playerInstance) {
      playerInstance.goto(timeOffset);
    }
  },
  
  /**
   * Set playback speed
   * @param {number} speed - Speed multiplier (1, 2, 4, 8)
   */
  setSpeed(speed) {
    if (playerInstance) {
      playerInstance.setSpeed(speed);
    }
  },
  
  /**
   * Get current time
   * @returns {number} Current time in ms
   */
  getCurrentTime() {
    return playerInstance?.getCurrentTime() || 0;
  },
  
  /**
   * Get total duration
   * @returns {number} Total duration in ms
   */
  getDuration() {
    return playerInstance?.getMetaData()?.totalTime || 0;
  },
  
  /**
   * Destroy player instance
   */
  destroy() {
    if (playerInstance) {
      try {
        playerInstance.pause();
        playerInstance = null;
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  },
  
  /**
   * Check if player is ready
   * @returns {boolean}
   */
  isReady() {
    return playerInstance !== null;
  }
};

export default RecapPlayer;
