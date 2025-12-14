/**
 * Recap - Timeline Module
 * Event timeline display and filtering
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Modal, EventTypes, VisibleEvents, HiddenEvents, Log } = window.Recap;

  // ============================================================================
  // IGNORED FIELDS (Auto-detected non-visible elements)
  // ============================================================================

  const IgnoredFields = {
    add(selector, info) {
      if (!selector) return;

      const existing = State.ignoredFields.get(selector);
      if (existing) {
        existing.count = (existing.count || 1) + 1;
      } else {
        State.ignoredFields.set(selector, {
          selector,
          reason: info.reason || 'unknown',
          label: info.label || selector,
          type: info.type || 'unknown',
          count: 1,
          dontIgnore: false,
          addedAt: Date.now()
        });

        if (!State.config.ignored.selectors.includes(selector)) {
          State.config.ignored.selectors.push(selector);
        }
      }

      this.updateBadge();
    },

    toggle(selector) {
      const field = State.ignoredFields.get(selector);
      if (field) {
        field.dontIgnore = !field.dontIgnore;

        if (field.dontIgnore) {
          State.config.ignored.selectors = State.config.ignored.selectors.filter(s => s !== selector);
        } else {
          if (!State.config.ignored.selectors.includes(selector)) {
            State.config.ignored.selectors.push(selector);
          }
        }

        this.render();
        Timeline.render();
      }
    },

    getReasonLabel(reason) {
      const labels = {
        'display-none': 'display: none',
        'visibility-hidden': 'visibility: hidden',
        'opacity-zero': 'opacity: 0',
        'zero-size': 'Zero dimensions',
        'hidden-input': 'type="hidden"',
        'off-screen': 'Off-screen',
        'aria-hidden': 'aria-hidden',
        'parent-hidden': 'Parent hidden',
        'no-node': 'Node not found',
        'check-failed': 'Check failed'
      };
      return labels[reason] || reason;
    },

    updateBadge() {
      const count = State.ignoredFields.size;
      const badge = DOM.$('ignored-count');
      if (badge) {
        badge.textContent = count > 0 ? String(count) : '';
        badge.style.display = count > 0 ? 'inline-flex' : 'none';
      }
    },

    render() {
      const container = DOM.$('ignored-fields-list');
      if (!container) return;

      this.updateBadge();

      if (State.ignoredFields.size === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </div>
            <h3>No Hidden Fields Detected</h3>
            <p>Non-visible form fields will appear here during recording.</p>
          </div>
        `;
        return;
      }

      const items = Array.from(State.ignoredFields.values());
      container.innerHTML = `
        <div class="ignored-header">
          <span>${items.length} hidden field${items.length !== 1 ? 's' : ''} detected</span>
        </div>
        ${items.map(field => `
          <div class="ignored-item ${field.dontIgnore ? 'active' : ''}" data-selector="${DOM.escapeAttr(field.selector)}">
            <div class="ignored-info">
              <div class="ignored-selector"><code>${DOM.escapeHtml(DOM.truncate(field.selector, 40))}</code></div>
              <div class="ignored-meta">
                <span class="ignored-reason">${DOM.escapeHtml(this.getReasonLabel(field.reason))}</span>
                <span class="ignored-type">${DOM.escapeHtml(field.type)}</span>
              </div>
            </div>
            <button class="dont-ignore-btn ${field.dontIgnore ? 'active' : ''}" data-selector="${DOM.escapeAttr(field.selector)}">
              ${field.dontIgnore ? '✓ Recording' : 'Ignore'}
            </button>
          </div>
        `).join('')}
      `;

      container.querySelectorAll('.dont-ignore-btn').forEach(btn => {
        btn.addEventListener('click', () => this.toggle(btn.dataset.selector));
      });
    }
  };

  // ============================================================================
  // EVENT TIMELINE
  // ============================================================================

  const Timeline = {
    add(eventData) {
      Log.debug('Timeline.add:', eventData?.type);
      const event = {
        ...eventData,
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        relativeTime: State.recordingStartTime ? (eventData.timestamp || Date.now()) - State.recordingStartTime : 0
      };

      // Auto-detect non-visible fields
      if (eventData.data?.isVisible === false && eventData.data?.selector) {
        IgnoredFields.add(eventData.data.selector, {
          reason: eventData.data.visibilityReason,
          label: eventData.data.label || eventData.data.text,
          type: eventData.type
        });
      }

      State.events.unshift(event);
      DOM.$('event-count')?.replaceChildren(String(State.events.length));
      window.Recap.Stats?.update();
      this.render();
    },

    render() {
      const container = DOM.$('event-timeline');
      if (!container) return;

      let filtered = State.activeFilter === EventTypes.ALL
        ? State.events
        : State.events.filter(e => e.type === State.activeFilter);

      if (!State.showAllEvents) {
        filtered = filtered.filter(e => VisibleEvents.has(e.type) || e.data?.ignored === false);
      }

      const hiddenCount = State.events.filter(e => HiddenEvents.has(e.type)).length;
      this.updateShowAllToggle(hiddenCount);

      if (!filtered.length) {
        container.innerHTML = this.emptyState();
        return;
      }

      container.innerHTML = filtered.map(e => this.renderItem(e)).join('');
      this.attachHandlers(container);
    },

    updateShowAllToggle(hiddenCount) {
      const toggle = DOM.$('toggle-show-all');
      const badge = DOM.$('hidden-count');
      if (toggle) toggle.checked = State.showAllEvents;
      if (badge) {
        badge.textContent = hiddenCount > 0 ? `(${hiddenCount} hidden)` : '';
        badge.style.display = hiddenCount > 0 ? 'inline' : 'none';
      }
    },

    emptyState() {
      return `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.3"/>
            </svg>
          </div>
          <h3>${State.isRecording ? 'Capturing events...' : 'Ready to Record'}</h3>
          <p>${State.isRecording ? 'Interact with the form.' : 'Click "Start Recording" to begin.'}</p>
        </div>
      `;
    },

    renderItem(event) {
      const display = this.getDisplay(event);
      const tags = this.getEventTags(event);
      const tagClasses = tags.map(t => `tagged-${t}`).join(' ');

      return `
        <div class="event-item ${DOM.escapeHtml(event.type)} ${tagClasses}" data-id="${DOM.escapeHtml(event.id)}">
          <span class="event-time">${DOM.formatTime(event.relativeTime)}</span>
          <span class="event-icon">${display.icon}</span>
          <div class="event-body">
            <div class="event-title">${DOM.escapeHtml(display.title)}</div>
            <div class="event-detail">${DOM.escapeHtml(display.detail)}</div>
            ${tags.length ? `<div class="event-tags">${tags.map(t => `<span class="event-tag tag-${t}">${this.getTagLabel(t)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="event-actions">
            ${display.actions.map(a => `
              <button class="event-action ${a.applied ? 'applied' : ''}" 
                      data-action="${a.action}" data-id="${DOM.escapeHtml(event.id)}">
                ${DOM.escapeHtml(a.label)}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    },

    getEventTags(event) {
      const tags = [];
      const sel = event.data?.selector || '';

      if (sel && State.config.masking.selectors.includes(sel)) tags.push('masked');
      if (sel && State.config.journey.steps.some(s => (s.selector || s) === sel)) tags.push('step');
      if (sel && sel === State.config.journey.successSelector) tags.push('success');
      if (State.config.network.scrubKeys.length && event.type === 'network') {
        const body = event.data?.body || {};
        if (State.config.network.scrubKeys.some(k => body[k] !== undefined)) tags.push('scrubbed');
      }

      return tags;
    },

    getTagLabel(tag) {
      const labels = { masked: '🔒 Masked', step: '📍 Step', success: '✅ Success', scrubbed: '🔐 Scrubbed' };
      return labels[tag] || tag;
    },

    getDisplay(event) {
      const sel = event.data?.selector || '';
      const isMasked = State.config.masking.selectors.includes(sel);
      const isStep = State.config.journey.steps.some(s => (s.selector || s) === sel);
      const stepName = State.config.journey.steps.find(s => s.selector === sel)?.name || 'Step';
      const isSuccess = event.data?.selector === State.config.journey.successSelector;

      const displays = {
        input: {
          icon: '⌨️',
          title: event.data?.label || sel,
          detail: event.data?.value ? `"${DOM.truncate(event.data.value, 30)}"` : '',
          actions: sel ? [{ action: 'mask', label: isMasked ? '✓ Masked' : 'Mask', applied: isMasked }] : []
        },
        click: {
          icon: '🖱️',
          title: event.data?.text ? `"${DOM.truncate(event.data.text, 25)}"` : sel,
          detail: isStep ? `📍 Step: ${stepName}` : '',
          actions: [
            { action: 'step', label: isStep ? '✓ Step' : 'Mark Step', applied: isStep },
            { action: 'success', label: isSuccess ? '✓ Success' : 'Success', applied: isSuccess }
          ]
        },
        focus: { icon: '👆', title: `focus ${sel}`, detail: '', actions: [] },
        blur: { icon: '👇', title: `blur ${sel}`, detail: '', actions: [] },
        network: {
          icon: '📡',
          title: `${event.data?.method || 'GET'} ${DOM.truncate(event.data?.url, 35)}`,
          detail: `${event.data?.status || '...'} • ${event.data?.duration || 0}ms`,
          actions: event.data?.body ? [{ action: 'scrub', label: 'Scrub Keys' }] : []
        },
        error: {
          icon: '❌',
          title: `error (${event.data?.errorType || 'unknown'})`,
          detail: DOM.truncate(event.data?.message, 50),
          actions: []
        },
        navigation: {
          icon: '🔄',
          title: 'Page redirect',
          detail: DOM.truncate(event.data?.fromUrl, 40),
          actions: []
        },
        session: {
          icon: event.subtype === 'start' ? '🚀' : '🏁',
          title: event.subtype === 'start' ? 'Recording started' : 'Recording ended',
          detail: event.subtype === 'start' ? 'rrweb capturing DOM' : `${event.data?.rrwebEvents || 0} events`,
          actions: []
        }
      };

      return displays[event.type] || { icon: '📌', title: event.type, detail: '', actions: [] };
    },

    attachHandlers(container) {
      container.querySelectorAll('.event-item').forEach(item => {
        item.addEventListener('click', () => this.showDetails(item.dataset.id));
      });
      container.querySelectorAll('.event-action').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          window.Recap.EventActions?.handle(btn.dataset.action, btn.dataset.id);
        });
      });
    },

    showDetails(eventId) {
      const event = State.events.find(e => e.id === eventId);
      if (!event) return;
      Modal.content(
        `${event.type} Event`,
        `<pre>${DOM.escapeHtml(JSON.stringify(event, null, 2))}</pre>`,
        [{ id: 'btn-close-details', label: 'Close' }]
      );
    }
  };

  // Export
  window.Recap.Timeline = Timeline;
  window.Recap.IgnoredFields = IgnoredFields;
})();


