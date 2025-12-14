/**
 * Recap - Player Module
 * Shared rrweb-player wrapper for both Trainer and Tester modes
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log } = window.Recap;

  // ============================================================================
  // PLAYER - Shared replay component
  // ============================================================================

  const Player = {
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

      // Debug: Log event structure
      const fullSnapshot = validation.events.find(e => e.type === 2);
      const metaEvent = validation.events.find(e => e.type === 4);
      
      // Get recorded viewport size from Meta event
      const recordedWidth = metaEvent?.data?.width || 1920;
      const recordedHeight = metaEvent?.data?.height || 1080;
      
      console.log('[Recap Player] Recorded viewport:', recordedWidth, 'x', recordedHeight);
      
      // Count nodes and check for corruption
      const nodeStats = { count: 0, nullNodes: 0, noIdNodes: 0 };
      this._countNodes(fullSnapshot?.data?.node, nodeStats);
      
      // Check for stylesheet links in the snapshot
      const stylesheetCount = this._countStylesheets(fullSnapshot?.data?.node);
      
      console.log('[Recap Player] Creating player:', {
        total: validation.events.length,
        nodeCount: nodeStats.count,
        recordedViewport: `${recordedWidth}x${recordedHeight}`,
        stylesheetCount: stylesheetCount,
        hasNode: !!fullSnapshot?.data?.node
      });

      // Warn if DOM tree seems empty
      if (nodeStats.count < 10) {
        console.warn('[Recap Player] WARNING: FullSnapshot has very few nodes:', nodeStats.count);
      }
      
      // Warn about external stylesheets
      if (stylesheetCount > 0) {
        console.warn('[Recap Player] NOTE: Recording has', stylesheetCount, 'external stylesheets that may not load in replay');
      }
      
      // FIX corrupted nodes before replay
      if (nodeStats.nullNodes > 0) {
        console.warn('[Recap Player] Fixing', nodeStats.nullNodes, 'null nodes in tree...');
        this._validateAndFixNodeTree(fullSnapshot.data.node);
      }
      
      // Determine player dimensions based on container size
      const containerWidth = options.width || containerEl.clientWidth || 800;
      const containerHeight = options.height || containerEl.clientHeight || 500;
      
      // For small containers (preview/thumbnail), use container dimensions directly
      // For large containers (fullscreen/modal), use recorded dimensions with scaling
      const isSmallContainer = containerWidth < 400 || containerHeight < 300;
      
      let playerWidth, playerHeight, scale;
      
      if (isSmallContainer) {
        // Small container: fit player directly to container (simpler approach)
        playerWidth = containerWidth;
        playerHeight = containerHeight - 50; // Leave room for controller
        scale = 1; // No scaling needed
        console.log('[Recap Player] Small container mode:', playerWidth, 'x', playerHeight);
      } else {
        // Large container: use recorded dimensions with scaling
        const scaleX = containerWidth / recordedWidth;
        const scaleY = containerHeight / recordedHeight;
        scale = Math.min(scaleX, scaleY, 1); // Don't scale up, only down
        playerWidth = recordedWidth;
        playerHeight = recordedHeight;
        console.log('[Recap Player] Large container mode, scale:', scale.toFixed(2));
      }

      try {
        // Apply container scaling style for proper viewport handling
        containerEl.style.overflow = 'hidden';
        containerEl.style.position = 'relative';
        
        console.log('[Recap Player] Using dimensions:', playerWidth, 'x', playerHeight, 'scale:', scale.toFixed(2));
        
        // Create player with RECORDED viewport size (critical for CSS media queries)
        const player = new rrwebPlayer({
          target: containerEl,
          props: {
            events: validation.events,
            // USE RECORDED DIMENSIONS - this prevents responsive CSS from triggering
            width: playerWidth,
            height: playerHeight,
            autoPlay: options.autoPlay ?? false,
            showController: options.showController ?? true,
            speedOption: options.speedOption || [1, 2, 4, 8],
            // Don't use live mode - we have complete recordings
            liveMode: false,
            // Skip missing nodes instead of throwing errors
            showWarning: true,
            showDebug: false,
            // CRITICAL: Inject fallback CSS so content is visible even when external CSS fails
            insertStyleRules: [
              // Reset and base visibility
              '* { box-sizing: border-box; }',
              'html, body { margin: 0; padding: 0; min-height: 100%; background: #f5f5f5 !important; color: #333 !important; }',
              // Make all elements visible with basic styling
              'div, section, article, main, header, footer, nav, aside { display: block; }',
              'form { display: block; padding: 16px; background: #fff; }',
              // Form elements - ensure they're visible
              'input, select, textarea, button { display: inline-block; padding: 8px 12px; margin: 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; min-width: 100px; background: #fff; color: #333; }',
              'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="password"] { width: 200px; }',
              'button, input[type="submit"], input[type="button"] { background: #4a90d9; color: white; cursor: pointer; padding: 10px 20px; border: none; }',
              'label { display: inline-block; margin: 4px 8px 4px 0; font-weight: 500; color: #333; }',
              // Text visibility
              'h1, h2, h3, h4, h5, h6, p, span, label, a, li, td, th { color: #333 !important; }',
              'a { color: #0066cc !important; text-decoration: underline; }',
              // Images
              'img { max-width: 100%; height: auto; border: 1px dashed #ccc; min-height: 20px; min-width: 20px; background: #f0f0f0; }',
              // Tables
              'table { border-collapse: collapse; width: 100%; background: #fff; }',
              'td, th { border: 1px solid #ddd; padding: 8px; }',
              // Lists
              'ul, ol { padding-left: 20px; }',
              // Generic fallback font
              'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; }'
            ]
          }
        });

        console.log('[Recap Player] Player created successfully');
        
        // Apply CSS transform to scale down the player to fit container
        const playerWrapper = containerEl.querySelector('.rr-player');
        
        if (isSmallContainer) {
          // Small container: ensure player fits without scaling
          if (playerWrapper) {
            playerWrapper.style.transform = 'none';
            playerWrapper.style.margin = '0';
          }
          containerEl.style.height = 'auto';
          containerEl.style.minHeight = `${containerHeight}px`;
        } else if (playerWrapper && scale < 1) {
          // Large container with scaling
          playerWrapper.style.transform = `scale(${scale})`;
          playerWrapper.style.transformOrigin = 'top center';
          
          // Calculate scaled dimensions
          const scaledWidth = playerWidth * scale;
          const scaledHeight = (playerHeight + 80) * scale; // +80 for controller
          
          // Set container height to match scaled player
          containerEl.style.height = `${scaledHeight + 20}px`;
          containerEl.style.minHeight = 'auto';
          
          // Center the scaled player
          playerWrapper.style.margin = '0 auto';
          
          console.log('[Recap Player] Scaled to:', scaledWidth.toFixed(0), 'x', scaledHeight.toFixed(0));
        } else {
          // No scaling needed
          containerEl.style.height = 'auto';
          containerEl.style.minHeight = 'auto';
        }
        
        // Listen for errors from the replayer
        if (player.getReplayer) {
          const replayer = player.getReplayer();
          if (replayer && replayer.on) {
            replayer.on('warn', (warn) => {
              console.warn('[Recap Player] Replayer warning:', warn);
            });
          }
        }
        
        return player;

      } catch (e) {
        console.error('[Recap Player] Creation failed:', e);
        containerEl.innerHTML = this.renderError(e.message);
        return null;
      }
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
      if (!container) return null;

      container.innerHTML = '';
      Modal.show(modalId);

      return this.create(container, events, {
        width: options.width || 900,
        height: options.height || 550,
        autoPlay: true,
        showController: true,
        speedOption: [0.5, 1, 2, 4, 8],
        ...options
      });
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

