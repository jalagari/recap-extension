/**
 * Recap - Player Module (ESM)
 * Leverages rrweb-player built-in features
 * @version 4.0.0
 */

import { Log, escapeHtml } from './core.js';

// ============================================================================
// RRWEB-PLAYER FEATURE REFERENCE
// ============================================================================
//
// We leverage these BUILT-IN rrweb-player features:
//
// PLAYBACK:
// - autoPlay: boolean - start playing immediately
// - speed: number - playback speed (1, 2, 4, 8)
// - speedOption: number[] - available speed options
// - skipInactive: boolean - skip long pauses
// - showWarning: boolean - show warning for missing assets
//
// CONTROLS:
// - showController: boolean - show/hide built-in controller
// - showDebug: boolean - show debug info
//
// EVENTS:
// - player.play() / player.pause()
// - player.goto(timeOffset)
// - player.setSpeed(speed)
// - player.on('start' | 'pause' | 'finish' | 'ui-update-*')
//
// REPLAYER ACCESS:
// - player.getReplayer() - get underlying replayer
// - replayer.getCurrentTime()
// - replayer.getMetaData()
//
// ============================================================================

let currentPlayer = null;

export const Player = {
  /**
   * Check if rrweb-player is available
   */
  get isAvailable() {
    return typeof rrwebPlayer !== 'undefined';
  },

  /**
   * Get current player instance
   */
  get current() {
    return currentPlayer;
  },

  /**
   * Create player in container
   * 
   * @param {HTMLElement} container - Container element
   * @param {Array} events - rrweb events array
   * @param {Object} options - Player options
   */
  create(container, events, options = {}) {
    if (!container) {
      Log.error('Player: container not found');
      return null;
    }

    if (!events?.length || events.length < 2) {
      container.innerHTML = this.renderEmpty();
      return null;
    }

    if (!this.isAvailable) {
      container.innerHTML = this.renderError('rrweb-player not loaded');
      return null;
    }

    // Destroy existing
    this.destroy();

    try {
      // Get container dimensions
      const rect = container.getBoundingClientRect();
      const parentRect = container.parentElement?.getBoundingClientRect();
      
      // Use available space
      let containerW = rect.width || parentRect?.width || 600;
      let containerH = rect.height || parentRect?.height || 500;
      
      // For modal, use more of the available space
      if (container.closest('.modal-body')) {
        containerW = parentRect?.width || window.innerWidth * 0.9;
        containerH = parentRect?.height || window.innerHeight * 0.75;
      }
      
      // Ensure reasonable minimum
      containerW = Math.max(containerW, 400);
      containerH = Math.max(containerH, 300);
      
      const controllerH = 60; // Height for rrweb controller

      // Find recorded viewport from meta event
      const meta = events.find(e => e.type === 4);
      const recordedW = meta?.data?.width || 1024;
      const recordedH = meta?.data?.height || 768;

      // Calculate available space for video (minus controller)
      const availableH = containerH - controllerH;
      
      // Calculate scale to FIT container 
      // Allow scaling up to 1.5x for smaller recordings
      const scaleW = containerW / recordedW;
      const scaleH = availableH / recordedH;
      const maxScale = recordedW < 800 ? 1.5 : 1; // Allow upscaling small recordings
      const scale = Math.min(scaleW, scaleH, maxScale);

      // Calculate final display dimensions
      const displayW = Math.floor(recordedW * scale);
      const displayH = Math.floor(recordedH * scale);

      Log.debug('Player dimensions:', { 
        container: `${containerW}x${containerH}`, 
        recorded: `${recordedW}x${recordedH}`,
        display: `${displayW}x${displayH}`,
        scale: scale.toFixed(2)
      });

      // Create wrapper
      container.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'recap-player';
      wrapper.style.width = '100%';
      wrapper.style.height = '100%';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
      container.appendChild(wrapper);

      // Use rrweb-player - pass the DISPLAY dimensions
      const player = new rrwebPlayer({
        target: wrapper,
        props: {
          events,
          width: displayW,
          height: displayH,
          autoPlay: options.autoPlay ?? false,
          showController: options.showController ?? true,
          skipInactive: true,
          speedOption: [1, 2, 4, 8],
          speed: 1
        }
      });

      currentPlayer = player;
      
      // Extract and display step markers from custom events
      this.setupStepMarkers(events, player);
      
      return player;

    } catch (e) {
      Log.error('Player creation failed:', e);
      container.innerHTML = this.renderError(e.message);
      return null;
    }
  },
  
  /**
   * Setup step markers from rrweb custom events (type 5)
   * These are events created with rrweb.record.addCustomEvent()
   */
  setupStepMarkers(events, player) {
    // Find all custom events with tag 'recap:step'
    const stepEvents = events.filter(e => 
      e.type === 5 && // Custom event type
      e.data?.tag === 'recap:step'
    );
    
    if (!stepEvents.length) {
      Log.debug('No step events found');
      return;
    }
    
    Log.info(`Found ${stepEvents.length} step events`);
    
    // Get the replayer to listen for step events
    try {
      const replayer = player.getReplayer();
      
      // Listen for custom events during replay
      replayer.on('custom-event', (event) => {
        if (event.data?.tag === 'recap:step') {
          const payload = event.data?.payload;
          Log.info(`📍 Step ${payload?.step}: ${payload?.label}`);
          
          // Could show a toast or overlay here
          this.showStepIndicator(payload);
        }
      });
      
      // Add step markers to the timeline (if visible)
      this.addTimelineMarkers(stepEvents, events, player);
      
    } catch (e) {
      Log.debug('Could not setup step listener:', e);
    }
  },
  
  /**
   * Show step indicator during replay
   */
  showStepIndicator(step) {
    // Create floating indicator
    const existing = document.querySelector('.recap-step-indicator');
    if (existing) existing.remove();
    
    const indicator = document.createElement('div');
    indicator.className = 'recap-step-indicator';
    indicator.innerHTML = `📍 Step ${step?.step || '?'}: ${escapeHtml(step?.label || 'Unknown')}`;
    indicator.style.cssText = `
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--accent, #6366f1);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
      z-index: 10000;
      animation: stepFadeIn 0.3s ease;
    `;
    
    document.body.appendChild(indicator);
    
    // Auto-remove after 2s
    setTimeout(() => indicator.remove(), 2000);
  },
  
  /**
   * Add visual markers to the player timeline
   */
  addTimelineMarkers(stepEvents, allEvents, player) {
    if (!stepEvents.length) return;
    
    // Calculate total duration
    const firstTime = allEvents[0]?.timestamp || 0;
    const lastTime = allEvents[allEvents.length - 1]?.timestamp || 0;
    const duration = lastTime - firstTime;
    
    if (duration <= 0) return;
    
    // Find the rrweb player's progress bar
    setTimeout(() => {
      const progressBar = document.querySelector('.rr-progress');
      if (!progressBar) return;
      
      // Create markers container
      let markers = progressBar.querySelector('.step-markers');
      if (!markers) {
        markers = document.createElement('div');
        markers.className = 'step-markers';
        markers.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
        `;
        progressBar.appendChild(markers);
      }
      
      // Add marker for each step
      stepEvents.forEach((event, i) => {
        const eventTime = event.timestamp - firstTime;
        const percent = (eventTime / duration) * 100;
        
        const marker = document.createElement('div');
        marker.className = 'step-marker';
        marker.title = `Step ${i + 1}: ${event.data?.payload?.label || 'Step'}`;
        marker.style.cssText = `
          position: absolute;
          left: ${percent}%;
          top: -8px;
          width: 16px;
          height: 16px;
          background: #f59e0b;
          border-radius: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          color: white;
          pointer-events: auto;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        `;
        marker.textContent = i + 1;
        
        // Click to jump to this step
        marker.addEventListener('click', () => {
          player.goto(eventTime);
        });
        
        markers.appendChild(marker);
      });
      
      Log.debug(`Added ${stepEvents.length} timeline markers`);
    }, 500); // Wait for player to render
  },

  /**
   * Destroy current player
   */
  destroy() {
    if (currentPlayer) {
      try {
        currentPlayer.$destroy();
      } catch {}
      currentPlayer = null;
    }
  },

  /**
   * Play
   */
  play() {
    currentPlayer?.play();
  },

  /**
   * Pause
   */
  pause() {
    currentPlayer?.pause();
  },

  /**
   * Seek to time
   */
  goto(timeMs) {
    currentPlayer?.goto(timeMs);
  },

  /**
   * Set speed
   */
  setSpeed(speed) {
    currentPlayer?.setSpeed(speed);
  },

  /**
   * Get current time
   */
  getCurrentTime() {
    return currentPlayer?.getReplayer()?.getCurrentTime?.() || 0;
  },

  /**
   * Get metadata
   */
  getMetaData() {
    return currentPlayer?.getMetaData?.() || null;
  },

  /**
   * Render empty state
   */
  renderEmpty() {
    return `
      <div class="player-empty">
        <div class="player-empty-icon">🎬</div>
        <h3>No Recording</h3>
        <p>Record a session to see the replay</p>
      </div>
    `;
  },

  /**
   * Render error state
   */
  renderError(message) {
    return `
      <div class="player-error">
        <div class="player-error-icon">❌</div>
        <h3>Playback Error</h3>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }
};

// ============================================================================
// MASKING APPLIER - Apply masking to recorded events for preview
// ============================================================================

export const MaskingApplier = {
  /**
   * PRIVACY-FIRST: Mask ALL inputs EXCEPT those in clearSelectors
   * This is the default mode for preview
   */
  applyPrivacyFirst(events, clearSelectors = []) {
    if (!events.length) return events;

    // Find full snapshot to build node map
    const snapshot = events.find(e => e.type === 2);
    if (!snapshot?.data?.node) return events;

    // Build set of ALL input node IDs
    const allInputNodeIds = new Set();
    this.findAllInputNodes(snapshot.data.node, allInputNodeIds);

    // Build set of "clear" node IDs (should NOT be masked)
    const clearNodeIds = new Set();
    if (clearSelectors.length) {
      this.findMatchingNodes(snapshot.data.node, clearSelectors, clearNodeIds);
    }

    // Mask all inputs EXCEPT those in clear list
    const toMask = new Set([...allInputNodeIds].filter(id => !clearNodeIds.has(id)));

    if (!toMask.size) return events;

    Log.debug(`Privacy-first: masking ${toMask.size} inputs (${clearNodeIds.size} cleared)`);

    return events.map(event => {
      if (event.type !== 3) return event;
      if (event.data?.source !== 5) return event;

      if (toMask.has(event.data.id)) {
        return {
          ...event,
          data: { ...event.data, text: '••••••••' }
        };
      }
      return event;
    });
  },

  /**
   * Find all input nodes (inputs, textareas, selects)
   */
  findAllInputNodes(node, inputIds) {
    if (!node) return;

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      inputIds.add(node.id);
    }

    if (node.childNodes) {
      for (const child of node.childNodes) {
        this.findAllInputNodes(child, inputIds);
      }
    }
  },

  /**
   * Apply masking to specific selectors (legacy mode)
   */
  apply(events, maskSelectors = []) {
    if (!maskSelectors.length) return events;
    if (!events.length) return events;

    const snapshot = events.find(e => e.type === 2);
    if (!snapshot?.data?.node) return events;

    const maskedNodeIds = new Set();
    this.findMatchingNodes(snapshot.data.node, maskSelectors, maskedNodeIds);

    if (!maskedNodeIds.size) return events;

    Log.debug(`Masking ${maskedNodeIds.size} nodes`);

    return events.map(event => {
      if (event.type !== 3) return event;
      if (event.data?.source !== 5) return event;

      if (maskedNodeIds.has(event.data.id)) {
        return {
          ...event,
          data: { ...event.data, text: '••••••••' }
        };
      }
      return event;
    });
  },

  findMatchingNodes(node, selectors, matchedIds) {
    if (!node) return;

    // Check if this node matches any selector
    if (node.attributes) {
      for (const selector of selectors) {
        if (this.nodeMatchesSelector(node, selector)) {
          matchedIds.add(node.id);
          break;
        }
      }
    }

    // Recurse children
    if (node.childNodes) {
      for (const child of node.childNodes) {
        this.findMatchingNodes(child, selectors, matchedIds);
      }
    }
  },

  nodeMatchesSelector(node, selector) {
    const attrs = node.attributes || {};
    
    // ID selector: #myId
    if (selector.startsWith('#')) {
      return attrs.id === selector.slice(1);
    }
    
    // Class selector: .myClass
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return (attrs.class || '').split(' ').includes(className);
    }
    
    // Attribute selector: [name="myName"]
    const attrMatch = selector.match(/\[(\w+)="([^"]+)"\]/);
    if (attrMatch) {
      return attrs[attrMatch[1]] === attrMatch[2];
    }
    
    // Tag selector
    return (node.tagName || '').toLowerCase() === selector.toLowerCase();
  }
};
