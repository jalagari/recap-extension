/**
 * Recap - Config Module
 * Configuration UI, export/import, and event actions
 * @version 1.0.0
 */

'use strict';

(function() {
  const { DOM, State, Toast, Modal, Log, Config: RecapConfig } = window.Recap;

  // ============================================================================
  // EVENT ACTIONS (Configuration)
  // ============================================================================

  const EventActions = {
    handle(action, eventId) {
      const event = State.events.find(e => e.id === eventId);
      if (!event) return;

      const handlers = {
        mask: () => this.toggleMask(event),
        scrub: () => this.showScrubModal(event),
        step: () => this.toggleStep(event),
        success: () => this.setSuccess(event)
      };

      handlers[action]?.();
      window.Recap.Timeline?.render();
      ConfigUI.update();
    },

    toggleMask(event) {
      const sel = event.data?.selector;
      if (!sel) return;

      const idx = State.config.masking.selectors.indexOf(sel);
      if (idx >= 0) {
        State.config.masking.selectors.splice(idx, 1);
        Toast.info('Mask removed');
      } else {
        State.config.masking.selectors.push(sel);
        Toast.success('Field will be masked');
      }
    },

    showScrubModal(event) {
      const payload = event.data?.body || {};
      const keys = this.extractKeys(payload);

      if (!keys.length) {
        Modal.content('Select Keys to Scrub', '<p>No JSON keys detected in this request.</p>',
          [{ id: 'btn-scrub-done', label: 'Done' }]);
        return;
      }

      Modal.content(
        'Select Keys to Scrub',
        `<p style="margin-bottom:12px;color:var(--text-muted);">Click keys to add/remove from scrub list:</p>
         <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto;">
           ${keys.map(k => this.renderKeyBtn(k)).join('')}
         </div>`,
        [{ id: 'btn-scrub-done', label: 'Done', handler: () => Toast.success('Scrub settings updated') }]
      );

      DOM.$$('.scrub-key-btn').forEach(btn => {
        btn.addEventListener('click', () => this.toggleScrubKey(btn));
      });
    },

    extractKeys(obj) {
      if (!obj || typeof obj !== 'object') return [];
      const keys = new Set();
      for (const key of Object.keys(obj)) {
        if (key === '_raw') continue;
        keys.add(key);
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          this.extractKeys(obj[key]).forEach(k => keys.add(k));
        }
      }
      return [...keys];
    },

    renderKeyBtn(key) {
      const active = State.config.network.scrubKeys.includes(key);
      return `<button class="scrub-key-btn ${active ? 'active' : ''}" data-key="${DOM.escapeAttr(key)}"
              style="padding:6px 10px;background:${active ? 'var(--purple)' : 'var(--bg-tertiary)'};
              border:1px solid ${active ? 'var(--purple)' : 'var(--border)'};border-radius:4px;
              color:${active ? 'white' : 'var(--text-secondary)'};cursor:pointer;font-size:11px;font-family:monospace;">
        ${DOM.escapeHtml(key)}
      </button>`;
    },

    toggleScrubKey(btn) {
      const key = btn.dataset.key;
      const idx = State.config.network.scrubKeys.indexOf(key);

      if (idx >= 0) {
        State.config.network.scrubKeys.splice(idx, 1);
        btn.classList.remove('active');
        btn.style.background = 'var(--bg-tertiary)';
        btn.style.borderColor = 'var(--border)';
        btn.style.color = 'var(--text-secondary)';
      } else {
        State.config.network.scrubKeys.push(key);
        btn.classList.add('active');
        btn.style.background = 'var(--purple)';
        btn.style.borderColor = 'var(--purple)';
        btn.style.color = 'white';
      }
      Toast.info(idx >= 0 ? `"${key}" removed` : `"${key}" will be scrubbed`);
    },

    toggleStep(event) {
      const sel = event.data?.selector;
      if (!sel) return;

      const existing = State.config.journey.steps.findIndex(s => (s.selector || s) === sel);

      if (existing >= 0) {
        State.config.journey.steps.splice(existing, 1);
        Toast.info('Step removed');
      } else {
        this.showStepNameModal(event);
      }
    },

    showStepNameModal(event) {
      const suggestedName = event.data?.text || event.data?.label || '';

      Modal.content(
        'Add Journey Step',
        `<div style="margin-bottom:16px;">
          <p style="color:var(--text-muted);margin-bottom:12px;">Give this step a descriptive name:</p>
          <input type="text" id="step-name-input" class="input-field" placeholder="e.g., Personal Details..."
                 value="${DOM.escapeAttr(suggestedName)}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;">
        </div>
        <div style="background:var(--bg-secondary);padding:10px;border-radius:6px;font-size:12px;">
          <strong>Selector:</strong> <code style="color:var(--purple);">${DOM.escapeHtml(event.data?.selector)}</code>
        </div>`,
        [
          { id: 'btn-cancel-step', label: 'Cancel', class: 'btn btn-ghost' },
          { id: 'btn-save-step', label: 'Save Step', class: 'btn btn-primary', handler: () => {
            const name = DOM.$('step-name-input')?.value?.trim() || 'Unnamed Step';
            State.config.journey.steps.push({ selector: event.data?.selector, name });
            Toast.success(`Step "${name}" added`);
            window.Recap.Timeline?.render();
            ConfigUI.update();
          }}
        ]
      );

      setTimeout(() => {
        const input = DOM.$('step-name-input');
        input?.focus();
        input?.select();
        input?.addEventListener('keydown', e => e.key === 'Enter' && DOM.$('btn-save-step')?.click());
      }, 100);
    },

    setSuccess(event) {
      const sel = event.data?.selector;
      if (State.config.journey.successSelector === sel) {
        State.config.journey.successSelector = null;
        Toast.info('Success trigger removed');
      } else {
        State.config.journey.successSelector = sel;
        Toast.success('Marked as success trigger');
      }
    }
  };

  // ============================================================================
  // CONFIG UI
  // ============================================================================

  const ConfigUI = {
    update() {
      this.renderList('mask-fields', State.config.masking.selectors, 'mask', 'mask-count');
      this.renderList('scrub-keys', State.config.network.scrubKeys, 'scrub', 'scrub-count');
      this.renderSteps();
      this.renderSuccess();
    },

    renderList(containerId, items, type, countId) {
      const container = DOM.$(containerId);
      const countEl = DOM.$(countId);

      if (countEl) countEl.textContent = String(items.length);
      if (!container) return;

      if (!items.length) {
        const hints = { mask: 'Click "Mask" on input events', scrub: 'Click "Scrub Keys" on network events' };
        container.innerHTML = `<div class="empty-hint">${hints[type]}</div>`;
        return;
      }

      container.innerHTML = items.map(item => `
        <div class="config-item">
          <code>${DOM.escapeHtml(item)}</code>
          <button class="remove-btn" data-type="${type}" data-value="${DOM.escapeAttr(item)}">×</button>
        </div>
      `).join('');

      container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const arr = btn.dataset.type === 'mask' ? State.config.masking.selectors : State.config.network.scrubKeys;
          const idx = arr.indexOf(btn.dataset.value);
          if (idx >= 0) arr.splice(idx, 1);
          this.update();
          window.Recap.Timeline?.render();
        });
      });
    },

    renderSteps() {
      const container = DOM.$('journey-steps');
      if (!container) return;

      if (!State.config.journey.steps.length) {
        container.innerHTML = '<div class="empty-hint">Click "Mark Step" on click events</div>';
        return;
      }

      container.innerHTML = State.config.journey.steps.map((step, i) => {
        const name = step.name || `Step ${i + 1}`;
        const sel = step.selector || step;
        return `
          <div class="config-item" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
              <strong>${DOM.escapeHtml(name)}</strong>
              <button class="remove-btn" data-selector="${DOM.escapeAttr(sel)}">×</button>
            </div>
            <code style="font-size:10px;color:var(--text-muted);">${DOM.escapeHtml(sel)}</code>
          </div>
        `;
      }).join('');

      container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          State.config.journey.steps = State.config.journey.steps.filter(s => (s.selector || s) !== btn.dataset.selector);
          this.update();
          window.Recap.Timeline?.render();
        });
      });
    },

    renderSuccess() {
      const container = DOM.$('success-trigger');
      if (!container) return;

      if (!State.config.journey.successSelector) {
        container.innerHTML = '<div class="empty-hint">Click "Success" on a submit/click event</div>';
        return;
      }

      container.innerHTML = `
        <div class="config-item">
          <code>${DOM.escapeHtml(State.config.journey.successSelector)}</code>
          <button class="remove-btn" id="btn-remove-success">×</button>
        </div>
      `;

      DOM.$('btn-remove-success')?.addEventListener('click', () => {
        State.config.journey.successSelector = null;
        this.update();
        window.Recap.Timeline?.render();
      });
    }
  };

  // ============================================================================
  // CONFIG EXPORT
  // ============================================================================

  const ConfigExport = {
    build() {
      const ignoreSelectors = State.config.ignored.selectors.filter(Boolean);
      const maskSelectors = State.config.masking.selectors.filter(Boolean);

      return {
        config_version: RecapConfig.CONFIG_VERSION,
        created_at: new Date().toISOString(),
        form: {
          id: State.config.formId,
          name: State.config.formName,
          path_pattern: State.config.pathPattern || '/',
          allowed_domains: [],
          excluded_domains: []
        },
        sampling_rate: State.config.samplingRate,
        masking: {
          selectors: maskSelectors,
          mask_all_inputs: State.config.masking.maskAllInputs,
          mask_input_options: { password: true, ...(State.config.masking.maskAllInputs && { text: true, email: true, tel: true }) }
        },
        ignored: {
          selectors: ignoreSelectors,
          _usage: 'Pass to rrweb.record({ ignoreSelector: selectors.join(",") })'
        },
        network: {
          scrub_payload_keys: State.config.network.scrubKeys,
          strip_headers: State.config.network.stripHeaders
        },
        journey: {
          steps: State.config.journey.steps.map(s => typeof s === 'object' ? s : { selector: s, name: null }),
          success_selector: State.config.journey.successSelector
        },
        errors: { capture_console: State.config.options.captureConsole },
        rrweb_options: {
          ignoreSelector: ignoreSelectors.length ? ignoreSelectors.join(',') : null,
          maskTextSelector: maskSelectors.length ? maskSelectors.join(',') : null,
          maskInputOptions: {
            password: true,
            ...(State.config.masking.maskAllInputs && { text: true, email: true, tel: true, number: true })
          },
          sampling: { input: 'last', mousemove: false, scroll: 150, media: 800 },
          blockSelector: '.recap-block',
          ignoreClass: 'recap-ignore',
          blockClass: 'recap-block',
          recordCanvas: false,
          collectFonts: false
        }
      };
    },

    async save() {
      try {
        await chrome.storage.local.set({ [`config_${State.config.formId || 'default'}`]: this.build() });
        Toast.success('Configuration saved!');
      } catch (e) {
        Toast.error('Failed to save');
      }
    },

    download() {
      const blob = new Blob([JSON.stringify(this.build(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recap-config-${State.config.formId || 'form'}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Toast.success('Configuration exported');
    }
  };

  // Export
  window.Recap.EventActions = EventActions;
  window.Recap.ConfigUI = ConfigUI;
  window.Recap.ConfigExport = ConfigExport;
})();


