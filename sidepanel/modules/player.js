/**
 * Recap - Player Module
 * Shared rrweb-player wrapper for both Trainer and Tester modes
 * Minimal UI with clean replay experience
 * @version 2.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log } = window.Recap;

  // ============================================================================
  // PLAYER - Shared replay component
  // ============================================================================

  const Player = {
    // Track active players for cleanup
    instances: new Map(),
    
    /**
     * Create a player instance in a container
     * @param {HTMLElement|string} container - Container element or ID
     * @param {Array} events - rrweb events array
     * @param {Object} options - Player options
     * @returns {Object|null} rrwebPlayer instance or null on error
     */
    create(container, events, options = {}) {
      const containerEl = typeof container === 'string' ? DOM.$(container) : container;
      
      if (!containerEl) {
        Log.error('Player container not found');
        return null;
      }

      // Cleanup any existing player in this container
      this.destroy(containerEl);

      // Validate events
      const validation = this.validateEvents(events);
      if (!validation.valid) {
        containerEl.innerHTML = this.renderError(validation.error);
        return null;
      }

      // Clear container
      containerEl.innerHTML = '';

      // Check rrwebPlayer availability
      if (typeof rrwebPlayer === 'undefined') {
        containerEl.innerHTML = this.renderError('rrweb-player not loaded');
        return null;
      }

      // Get event stats
      const stats = this.getStats(validation.events);
      const fullSnapshot = validation.events.find(e => e.type === 2);
      const metaEvent = validation.events.find(e => e.type === 4);
      
      // Get recorded viewport size from Meta event
      const recordedWidth = metaEvent?.data?.width || 1920;
      const recordedHeight = metaEvent?.data?.height || 1080;
      
      // Count nodes and fix corruption
      const nodeStats = { count: 0, nullNodes: 0, noIdNodes: 0 };
      this._countNodes(fullSnapshot?.data?.node, nodeStats);
      
      if (nodeStats.nullNodes > 0) {
        this._validateAndFixNodeTree(fullSnapshot.data.node);
      }
      
      // Calculate dimensions - maximize space usage
      const containerWidth = options.width || containerEl.clientWidth || 800;
      const containerHeight = options.height || containerEl.clientHeight || 500;
      
      // Calculate scale to fit container while maintaining aspect ratio
      const aspectRatio = recordedWidth / recordedHeight;
      let playerWidth, playerHeight, scale;
      
      // Calculate the best fit
      const scaleX = containerWidth / recordedWidth;
      const scaleY = containerHeight / recordedHeight;
      scale = Math.min(scaleX, scaleY, 1); // Don't scale up
      
      playerWidth = recordedWidth;
      playerHeight = recordedHeight;

      try {
        // Create wrapper for player and controls
        const wrapper = document.createElement('div');
        wrapper.className = 'recap-player-wrapper';
        containerEl.appendChild(wrapper);
        
        // Create player container
        const playerContainer = document.createElement('div');
        playerContainer.className = 'recap-player-viewport';
        wrapper.appendChild(playerContainer);
        
        // Create player with NO built-in controller
        const player = new rrwebPlayer({
          target: playerContainer,
          props: {
            events: validation.events,
            width: playerWidth,
            height: playerHeight,
            autoPlay: options.autoPlay ?? false,
            showController: false, // Hide built-in controls
            skipInactive: true,
            liveMode: false,
            showWarning: false,
            showDebug: false,
            insertStyleRules: this._getInsertStyleRules()
          }
        });
        
        // Apply scaling and center the player
        const playerEl = playerContainer.querySelector('.rr-player');
        if (playerEl) {
          const scaledWidth = playerWidth * scale;
          const scaledHeight = playerHeight * scale;
          
          if (scale < 1) {
            playerEl.style.transform = `scale(${scale})`;
            playerEl.style.transformOrigin = 'top left';
          }
          
          // Set viewport container dimensions and center content
          playerContainer.style.width = `${scaledWidth}px`;
          playerContainer.style.height = `${scaledHeight}px`;
          playerContainer.style.overflow = 'hidden';
          playerContainer.style.margin = '0 auto'; // Center horizontally
        }
        
        // Add custom minimal controls
        const controls = this._createControls(player, stats, options);
        wrapper.appendChild(controls);
        
        // Store instance for cleanup
        this.instances.set(containerEl, { player, wrapper });
        
        return player;

      } catch (e) {
        console.error('[Recap Player] Creation failed:', e);
        containerEl.innerHTML = this.renderError(e.message);
        return null;
      }
    },
    
    /**
     * Create minimal custom controls
     * @private
     */
    _createControls(player, stats, options = {}) {
      const controls = document.createElement('div');
      controls.className = 'recap-player-controls';
      
      // rrwebPlayer exposes methods directly on the player object
      // getReplayer() returns the internal replayer for advanced operations
      let isPlaying = options.autoPlay ?? false;
      let currentTime = 0;
      const totalTime = stats.duration;
      
      controls.innerHTML = `
        <button class="rpc-play-btn" title="Play/Pause">
          <svg class="rpc-icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <svg class="rpc-icon-pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none">
            <rect x="6" y="4" width="4" height="16"/>
            <rect x="14" y="4" width="4" height="16"/>
          </svg>
        </button>
        <div class="rpc-progress-wrap">
          <div class="rpc-progress-bar">
            <div class="rpc-progress-fill"></div>
          </div>
        </div>
        <span class="rpc-time">${this._formatTime(currentTime)} / ${this._formatTime(totalTime)}</span>
        ${options.showFullscreen !== false ? `
          <button class="rpc-fullscreen-btn" title="Fullscreen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          </button>
        ` : ''}
      `;
      
      const playBtn = controls.querySelector('.rpc-play-btn');
      const iconPlay = controls.querySelector('.rpc-icon-play');
      const iconPause = controls.querySelector('.rpc-icon-pause');
      const progressBar = controls.querySelector('.rpc-progress-bar');
      const progressFill = controls.querySelector('.rpc-progress-fill');
      const timeDisplay = controls.querySelector('.rpc-time');
      const fullscreenBtn = controls.querySelector('.rpc-fullscreen-btn');
      
      const updatePlayState = (playing) => {
        isPlaying = playing;
        iconPlay.style.display = playing ? 'none' : 'block';
        iconPause.style.display = playing ? 'block' : 'none';
      };
      
      const updateProgress = (time) => {
        currentTime = time;
        const pct = totalTime > 0 ? (time / totalTime) * 100 : 0;
        progressFill.style.width = `${pct}%`;
        timeDisplay.textContent = `${this._formatTime(time)} / ${this._formatTime(totalTime)}`;
      };
      
      // Get the internal replayer for seeking and time tracking
      const replayer = player.getReplayer?.();
      
      // Store player reference for controls
      controls._player = player;
      controls._replayer = replayer;
      
      // Play/Pause - rrwebPlayer exposes play/pause directly
      playBtn.addEventListener('click', () => {
        try {
          // rrwebPlayer methods: play(), pause(), toggle()
          if (isPlaying) {
            player.pause();
          } else {
            player.play();
          }
          isPlaying = !isPlaying;
          updatePlayState(isPlaying);
        } catch (e) {
          console.error('[Recap Player] Play/Pause error:', e);
          // Fallback to replayer
          try {
            if (replayer) {
              if (isPlaying) replayer.pause();
              else replayer.play();
              isPlaying = !isPlaying;
              updatePlayState(isPlaying);
            }
          } catch (e2) {}
        }
      });
      
      // Progress bar click to seek
      progressBar.addEventListener('click', (e) => {
        const rect = progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const seekTime = pct * totalTime;
        try {
          // Seek using replayer.pause(time) or player.goto(time, false)
          if (replayer?.pause) {
            replayer.pause(seekTime);
          }
          updateProgress(seekTime);
          isPlaying = false;
          updatePlayState(false);
        } catch (e) {
          console.error('[Recap Player] Seek error:', e);
        }
      });
      
      // Fullscreen
      if (fullscreenBtn && options.onFullscreen) {
        fullscreenBtn.addEventListener('click', options.onFullscreen);
      } else if (fullscreenBtn) {
        fullscreenBtn.style.display = 'none';
      }
      
      // Listen for replayer events if available
      if (replayer?.on) {
        try {
          replayer.on('finish', () => {
            isPlaying = false;
            updatePlayState(false);
            updateProgress(totalTime);
          });
        } catch (e) {}
      }
      
      // Update progress periodically when playing
      const progressInterval = setInterval(() => {
        if (isPlaying) {
          try {
            const time = replayer?.getCurrentTime?.() || 0;
            updateProgress(time);
            // Check if finished
            if (time >= totalTime) {
              updatePlayState(false);
            }
          } catch (e) {}
        }
      }, 100);
      
      // Store interval for cleanup
      controls._progressInterval = progressInterval;
      
      if (options.autoPlay) {
        updatePlayState(true);
      }
      
      return controls;
    },
    
    /**
     * Format time in mm:ss
     * @private
     */
    _formatTime(ms) {
      const secs = Math.floor((ms || 0) / 1000);
      const mins = Math.floor(secs / 60);
      const remainSecs = secs % 60;
      return `${mins}:${remainSecs.toString().padStart(2, '0')}`;
    },
    
    /**
     * Get CSS rules to inject into replay
     * @private
     */
    _getInsertStyleRules() {
      return [
        '* { box-sizing: border-box; }',
        'html, body { margin: 0; padding: 0; min-height: 100%; background: #f5f5f5 !important; color: #333 !important; }',
        'div, section, article, main, header, footer, nav, aside { display: block; }',
        'form { display: block; padding: 16px; background: #fff; }',
        'input, select, textarea, button { display: inline-block; padding: 8px 12px; margin: 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; min-width: 100px; background: #fff; color: #333; }',
        'button, input[type="submit"], input[type="button"] { background: #4a90d9; color: white; cursor: pointer; padding: 10px 20px; border: none; }',
        'label { display: inline-block; margin: 4px 8px 4px 0; font-weight: 500; color: #333; }',
        'h1, h2, h3, h4, h5, h6, p, span, label, a, li, td, th { color: #333 !important; }',
        'img { max-width: 100%; height: auto; }',
        'table { border-collapse: collapse; width: 100%; background: #fff; }',
        'td, th { border: 1px solid #ddd; padding: 8px; }',
        'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; }'
      ];
    },
    
    /**
     * Destroy player instance
     */
    destroy(container) {
      const containerEl = typeof container === 'string' ? DOM.$(container) : container;
      if (!containerEl) return;
      
      const instance = this.instances.get(containerEl);
      if (instance) {
        // Clear progress interval
        if (instance.wrapper) {
          const controls = instance.wrapper.querySelector('.recap-player-controls');
          if (controls?._progressInterval) {
            clearInterval(controls._progressInterval);
          }
        }
        // Destroy player
        try {
          instance.player?.$destroy?.();
        } catch (e) {}
        this.instances.delete(containerEl);
      }
      containerEl.innerHTML = '';
    },
    
    /**
     * Count nodes in a tree and check for corruption
     * @private
     * @returns {Object} { count: number, nullNodes: number, noIdNodes: number }
     */
    _countNodes(node, stats = { count: 0, nullNodes: 0, noIdNodes: 0 }) {
      if (!node) return stats.count;
      
      stats.count++;
      
      // Check for missing id (required by rrweb-player)
      if (typeof node.id !== 'number') {
        stats.noIdNodes++;
      }
      
      if (node.childNodes && Array.isArray(node.childNodes)) {
        node.childNodes.forEach((child, idx) => {
          if (child === null || child === undefined) {
            stats.nullNodes++;
            console.warn('[Recap Player] Null child at index', idx, 'in node', node.id);
          } else {
            this._countNodes(child, stats);
          }
        });
      }
      return stats.count;
    },
    
    /**
     * Deep validate and fix a FullSnapshot node tree
     * @private
     */
    _validateAndFixNodeTree(node) {
      if (!node) return null;
      
      // Filter out null children
      if (node.childNodes && Array.isArray(node.childNodes)) {
        node.childNodes = node.childNodes.filter(child => child !== null && child !== undefined);
        // Recursively fix children
        node.childNodes.forEach(child => this._validateAndFixNodeTree(child));
      }
      
      return node;
    },
    
    /**
     * Count external stylesheet links (for debugging CSS issues)
     * @private
     */
    _countStylesheets(node, count = 0) {
      if (!node) return 0;
      // Check if this is a link tag with rel="stylesheet"
      if (node.tagName === 'link' && node.attributes?.rel === 'stylesheet') {
        count++;
      }
      // Check if this is a style tag (inline CSS - good!)
      // We only count external links as potential issues
      if (node.childNodes) {
        node.childNodes.forEach(child => {
          count += this._countStylesheets(child, 0);
        });
      }
      return count;
    },

    /**
     * Validate rrweb events for playback
     * @param {Array} events - Events to validate
     * @returns {Object} { valid: boolean, events: Array, error: string }
     */
    validateEvents(events) {
      if (!events || !Array.isArray(events)) {
        return { valid: false, error: 'No events provided' };
      }

      // Filter valid events (must have timestamp)
      const validEvents = events.filter(e => e && typeof e.timestamp === 'number');

      if (validEvents.length < 2) {
        return { valid: false, error: `Not enough events (${validEvents.length})` };
      }

      // Check for required Meta event (type 4)
      const hasMeta = validEvents.some(e => e.type === 4);
      if (!hasMeta) {
        return { valid: false, error: 'Missing Meta event (type 4)' };
      }

      // Check for required FullSnapshot event (type 2)
      const fullSnapshot = validEvents.find(e => e.type === 2);
      if (!fullSnapshot) {
        return { valid: false, error: 'Missing FullSnapshot (type 2)' };
      }

      // Verify FullSnapshot has node data
      if (!fullSnapshot.data?.node) {
        return { valid: false, error: 'FullSnapshot has no DOM data' };
      }

      // Log event breakdown for debugging
      const typeCount = {};
      validEvents.forEach(e => { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });
      Log.debug('Event types:', typeCount);

      return { valid: true, events: validEvents, error: null };
    },

    /**
     * Apply masking to events for privacy preview
     * @param {Array} events - Original events
     * @param {Object} config - Masking configuration
     * @returns {Array} Masked events (deep cloned)
     */
    applyMasking(events, config) {
      const selectors = config?.masking?.selectors || [];
      const scrubKeys = config?.network?.scrubKeys || [];
      
      console.log('[Recap Player] applyMasking called:', {
        eventCount: events?.length,
        selectors,
        scrubKeys
      });

      if (!selectors.length && !scrubKeys.length) {
        console.log('[Recap Player] No selectors/scrubKeys, returning original events');
        return events;
      }

      // Deep clone to avoid mutating originals
      const masked = JSON.parse(JSON.stringify(events));

      // Build node ID to DOM ID map from FullSnapshot
      const nodeIdToDomId = new Map();
      const fullSnapshot = masked.find(e => e.type === 2);
      if (fullSnapshot?.data?.node) {
        this._buildNodeMap(fullSnapshot.data.node, nodeIdToDomId);
      }

      // Find which node IDs should be masked
      const maskedNodeIds = new Set();
      for (const sel of selectors) {
        nodeIdToDomId.forEach((attrs, nodeId) => {
          if (this._selectorMatches(sel, attrs)) {
            maskedNodeIds.add(nodeId);
          }
        });
      }
      
      Log.debug('Masking selectors:', selectors, 'matched nodes:', maskedNodeIds.size);

      // Apply masking to input events
      let maskedCount = 0;
      masked.forEach(event => {
        // Input events: type 3, source 5
        if (event.type === 3 && event.data?.source === 5 && event.data.text) {
          if (maskedNodeIds.has(event.data.id)) {
            event.data.text = '••••••••';
            maskedCount++;
          }
        }

        // Mask values in FullSnapshot
        if (event.type === 2 && event.data?.node) {
          this._maskSnapshotValues(event.data.node, maskedNodeIds);
        }

        // Scrub network events
        if (event.type === 5 && event.data?.tag === 'network' && scrubKeys.length) {
          const payload = event.data.payload;
          if (payload?.body) {
            scrubKeys.forEach(key => {
              if (payload.body[key] !== undefined) {
                payload.body[key] = '[SCRUBBED]';
              }
            });
          }
        }
      });

      Log.debug('Masked', maskedCount, 'input events');
      return masked;
    },

    /**
     * Build map of rrweb node IDs to DOM element attributes
     * @private
     */
    _buildNodeMap(node, map) {
      if (!node) return;
      // Store all relevant attributes for selector matching
      if (node.id !== undefined && node.attributes) {
        map.set(node.id, {
          id: node.attributes.id || null,
          name: node.attributes.name || null,
          class: node.attributes.class || null,
          tagName: node.tagName?.toLowerCase() || null
        });
      }
      if (node.childNodes) {
        node.childNodes.forEach(child => this._buildNodeMap(child, map));
      }
    },

    /**
     * Check if a selector matches element attributes
     * @private
     */
    _selectorMatches(selector, attrs) {
      if (!attrs) return false;
      
      // #id selector
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        return attrs.id === id || (attrs.id && attrs.id.includes(id));
      }
      
      // .class selector
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return attrs.class && attrs.class.includes(cls);
      }
      
      // [name="value"] selector
      if (selector.startsWith('[name=')) {
        const match = selector.match(/\[name="?([^"\]]+)"?\]/);
        if (match) {
          const name = match[1];
          return attrs.name === name || (attrs.name && attrs.name.includes(name));
        }
      }
      
      // Direct ID/name match (for simple selectors like "firstName")
      return attrs.id === selector || 
             attrs.name === selector ||
             (attrs.id && attrs.id.includes(selector)) ||
             (attrs.name && attrs.name.includes(selector));
    },

    /**
     * Mask values in snapshot tree
     * @private
     */
    _maskSnapshotValues(node, maskedNodeIds) {
      if (!node) return;
      if (maskedNodeIds.has(node.id) && node.attributes?.value) {
        node.attributes.value = '••••••••';
      }
      if (node.childNodes) {
        node.childNodes.forEach(child => this._maskSnapshotValues(child, maskedNodeIds));
      }
    },

    /**
     * Get stats from events
     * @param {Array} events - rrweb events
     * @returns {Object} { eventCount, duration, hasSnapshot }
     */
    getStats(events) {
      if (!events?.length) {
        return { eventCount: 0, duration: 0, hasSnapshot: false };
      }

      const duration = events.length >= 2
        ? events[events.length - 1].timestamp - events[0].timestamp
        : 0;

      return {
        eventCount: events.length,
        duration,
        durationFormatted: DOM.formatDuration(duration),
        hasSnapshot: events.some(e => e.type === 2)
      };
    },

    /**
     * Render error state HTML
     * @param {string} message - Error message
     * @returns {string} HTML
     */
    renderError(message) {
      return `
        <div class="player-error">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="1">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <p>${DOM.escapeHtml(message)}</p>
        </div>
      `;
    },

    /**
     * Render empty state HTML
     * @param {string} title - Title text
     * @param {string} message - Message text
     * @returns {string} HTML
     */
    renderEmpty(title = 'No Recording', message = 'Record a session first') {
      return `
        <div class="player-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <h3>${DOM.escapeHtml(title)}</h3>
          <p>${DOM.escapeHtml(message)}</p>
        </div>
      `;
    },

    /**
     * Open fullscreen player modal
     * @param {Array} events - rrweb events
     * @param {string} modalId - Modal element ID
     * @param {string} containerId - Container element ID
     * @param {Object} options - Player options
     */
    openFullscreen(events, modalId = 'replay-modal', containerId = 'fullscreen-player-container', options = {}) {
      if (!events?.length) {
        Toast.error('No recording to replay');
        return null;
      }

      const container = DOM.$(containerId);
      if (!container) {
        Log.error('Fullscreen container not found:', containerId);
        return null;
      }

      this.destroy(container);
      Modal.show(modalId);

      // Delay creation to allow modal to render and get proper dimensions
      return setTimeout(() => {
        // Get actual container dimensions after modal is visible
        const rect = container.getBoundingClientRect();
        const width = rect.width || container.clientWidth || 850;
        const height = rect.height || container.clientHeight || 500;
        
        Log.debug('Fullscreen container dimensions:', width, 'x', height);
        
        this.create(container, events, {
          width: width,
          height: height,
          autoPlay: true,
          showFullscreen: false, // Already fullscreen
          ...options
        });
      }, 150);
    },

    /**
     * Download events as JSON
     * @param {Array} events - Events to download
     * @param {Object} metadata - Additional metadata
     * @param {string} filename - Download filename
     */
    download(events, metadata = {}, filename = null) {
      if (!events?.length) {
        Toast.error('No recording to download');
        return;
      }

      const stats = this.getStats(events);
      const pkg = {
        version: '1.0',
        type: 'rrweb-recording',
        created_at: new Date().toISOString(),
        metadata: {
          event_count: stats.eventCount,
          duration_ms: stats.duration,
          ...metadata
        },
        events: events
      };

      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `recap-recording-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      Toast.success(`Downloaded ${stats.eventCount} events`);
    }
  };

  // Export
  window.Recap.Player = Player;
})();

