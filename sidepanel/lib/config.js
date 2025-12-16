/**
 * Recap - Config Module (ESM)
 * Configuration builder leveraging rrweb options
 * @version 3.0.0
 */

import { Log, generateId, UrlUtils } from './core.js';
import { Storage } from './storage.js';

// ============================================================================
// CONFIG BUILDER
// ============================================================================

export const ConfigBuilder = {
  /**
   * Create new config from fields
   * 
   * PRIVACY-FIRST: All inputs masked by default
   * - clear: fields explicitly marked as NOT masked (safe to show)
   * - ignored: fields not recorded at all
   * - steps: journey milestones (buttons, actions)
   */
  create(options = {}) {
    const { name, urlPattern, fields = {}, sample } = options;

    // NOTE: "clear" = fields that should NOT be masked (user marked safe)
    const clear = fields.clear || [];
    const ignored = fields.ignored || [];
    const steps = fields.steps || [];

    return {
      id: null,
      name: name || 'Untitled Form',
      url_pattern: urlPattern || '',
      created_at: null,
      updated_at: null,

      // Field configurations (PRIVACY-FIRST)
      fields: {
        clear,    // Fields NOT to mask (everything else is masked)
        ignored,  // Fields not recorded
        steps,    // Journey milestones
        completion: fields.completion || null
      },

      // rrweb options - BUILT FROM FIELDS
      rrweb_options: this.buildRrwebOptions(clear, ignored),

      // Sample recording
      sample: sample ? {
        events: sample.events || [],
        duration_ms: sample.duration_ms || 0,
        recorded_at: new Date().toISOString()
      } : null,

      // Network scrubbing
      network: {
        enabled: true,
        scrub_keys: ['password', 'token', 'secret', 'authorization', 'apiKey']
      },

      // SDK settings
      settings: {
        sampling_rate: 0.25,
        capture_console: true,
        capture_network: true
      }
    };
  },

  /**
   * Build rrweb options from field configurations
   * PRIVACY-FIRST: maskAllInputs + selective unmasking
   */
  buildRrwebOptions(clear = [], ignored = []) {
    const clearSelectors = clear.map(f => f.selector).filter(Boolean);
    const ignoreSelectors = ignored.map(f => f.selector).filter(Boolean);

    return {
      // MASKING - rrweb native (PRIVACY-FIRST)
      maskAllInputs: true,  // Mask ALL by default
      maskInputOptions: { password: true },
      // Store clear selectors for maskInputFn to use
      clearSelectors: clearSelectors,

      // IGNORING - rrweb native
      ignoreSelector: ignoreSelectors.length ? ignoreSelectors.join(', ') : null,
      blockSelector: '.ads, .chat-widget, [data-norecord]',

      // SAMPLING - rrweb native
      sampling: {
        mousemove: 50,
        mouseInteraction: true,
        scroll: 150,
        input: 'last'
      },

      // SLIM DOM - rrweb native
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaSocial: true,
        headMetaRobots: true,
        headMetaHttpEquiv: true,
        headMetaAuthorship: true,
        headMetaVerification: true
      }
    };
  },

  /**
   * Export config as JSON
   */
  export(config) {
    const exported = { ...config };
    // Optionally exclude sample events for smaller export
    if (exported.sample) {
      exported.sample = { ...exported.sample, events: [] };
    }
    return JSON.stringify(exported, null, 2);
  },

  /**
   * Import config from JSON
   */
  import(jsonString) {
    const config = JSON.parse(jsonString);
    if (!config.name && !config.url_pattern) {
      throw new Error('Invalid config: missing name or url_pattern');
    }
    config.id = null; // Will get new ID on save
    return config;
  },

  /**
   * Validate config
   */
  validate(config) {
    const errors = [];
    if (!config.name?.trim()) errors.push('Name is required');
    if (!config.url_pattern?.trim()) errors.push('URL pattern is required');
    return { valid: errors.length === 0, errors };
  }
};

// ============================================================================
// CONFIG MANAGER
// ============================================================================

export const ConfigManager = {
  currentConfig: null,

  /**
   * Load config for URL
   */
  async loadForUrl(url) {
    this.currentConfig = await Storage.getConfigByUrl(url);
    return this.currentConfig;
  },

  /**
   * Save config
   */
  async save(config) {
    const validation = ConfigBuilder.validate(config);
    if (!validation.valid) {
      throw new Error(validation.errors.join(', '));
    }
    const saved = await Storage.saveConfig(config);
    this.currentConfig = saved;
    return saved;
  },

  /**
   * Delete config
   */
  async delete(id) {
    await Storage.deleteConfig(id);
    if (this.currentConfig?.id === id) {
      this.currentConfig = null;
    }
  },

  /**
   * Create config from detected fields
   * 
   * PRIVACY-FIRST:
   * - All inputs are masked by default
   * - "clear" list contains fields explicitly marked as safe to show (action: 'none')
   */
  createFromFields(options = {}) {
    const { name, urlPattern, detectedFields = [], sampleEvents = [] } = options;

    // PRIVACY-FIRST categorization:
    // - clear: input fields marked 'none' (user says safe to show)
    // - masked fields don't need to be stored (it's the default!)
    // - ignored: fields not recorded
    // - steps: journey milestones
    const clear = detectedFields.filter(f => f.action === 'none' && f.type === 'input');
    const ignored = detectedFields.filter(f => f.action === 'ignore');
    const steps = detectedFields
      .filter(f => f.action === 'step')
      .map((f, i) => ({ ...f, order: i + 1 }));

    return ConfigBuilder.create({
      name,
      urlPattern,
      fields: { clear, ignored, steps },
      sample: {
        events: sampleEvents,
        duration_ms: sampleEvents.length > 1
          ? sampleEvents[sampleEvents.length - 1].timestamp - sampleEvents[0].timestamp
          : 0
      }
    });
  }
};

