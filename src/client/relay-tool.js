/**
 * Comms Shim — Relay Tool v0.7.1 (core)
 *
 * Served by localhostServer (GET /relay-tool.js) and loaded by the
 * client snippet. A floating tool window built from standard web
 * components — vanilla JS/HTML/CSS, no frameworks.
 *
 * The core ships with NO functions. Functions are loadable:
 * localhostServer catalogs them (JSON-RPC functions.list —
 * metadata: id, name, version, description, script URL,
 * dependencies) and serves each script at /functions/<id>.js.
 * The File menu's "Settings" view (a settings panel with a
 * section list on the left, VS Code style) enables and disables
 * them in its Functions section; enabling loads the function's
 * dependencies (in declared order) and its script, which
 * registers its panel via window.RelayTool.registerFunction.
 * Adding a function is a server-side change — neither the
 * snippet nor this core changes.
 *
 * Components (tag names carry the core version — see below):
 *   <relay-tool-v0-5-0>           the floating window + menu bar
 *   <relay-function-list-v0-5-0>  left panel: the enabled functions
 *   <relay-settings-panel-v0-7-0> the Settings view (sections)
 * Function panels are separate components with their own
 * versions, defined by the function scripts.
 *
 * Versioned tags: a custom element name can only ever be defined
 * once per page, so tag names are suffixed with a version. Core
 * tags use the core version; function tags use the function's own
 * version. Different versions coexist on one page without
 * colliding; every core tag lookup is computed from VERSION via
 * tag(). There is deliberately no catch-and-retry on define() —
 * refresh the page for a clean slate.
 *
 * Communication follows the project UI rules: components talk via
 * custom elements, data- attributes, and CustomEvents; animations
 * are CSS, not JS.
 */
(() => {
  const VERSION = '0.7.1';

  // This exact version already loaded? Then there is nothing to
  // do — the same code is already registered under the same tags.
  window.CommsShimTools ??= {};
  if (window.CommsShimTools[VERSION]) return;

  const tagSuffix = `-v${VERSION.replaceAll('.', '-')}`;
  const tag = (base) => base + tagSuffix;

  // color-scheme is pinned to light in every component's :host
  // rule: it is inherited into shadow trees, and without a pin
  // the UA-styled parts (inputs, checkboxes, button text) follow
  // the ambient scheme — on a dark-scheme browser they render
  // dark-on-light and the ✕ buttons go white-on-white.
  const panelCSS = `
    :host { display: block; height: 100%; color-scheme: light; }
    .panel { height: 100%; box-sizing: border-box; padding: 0.6rem;
             animation: panel-in 160ms ease-out; }
    @keyframes panel-in {
      from { opacity: 0; transform: translateX(6px); }
      to   { opacity: 1; transform: none; }
    }
  `;

  // --------------------------------------------------------------
  // Loader — URL-keyed dedupe: a script or style loads at most
  // once per page, however many functions depend on it. Repeat
  // loads across pages are the HTTP cache's job. There is no
  // separate dependency manager: dependencies are declared in
  // the catalog and resolved here, in declared order.
  // --------------------------------------------------------------
  const loadPromises = new Map(); // url -> Promise

  function loadScriptOnce(url) {
    if (!loadPromises.has(url)) {
      const p = window.CommsShim?.loadScript
        ? window.CommsShim.loadScript(url)
        : new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(s);
          });
      loadPromises.set(url, p);
    }
    return loadPromises.get(url);
  }

  function loadStyleOnce(url) {
    if (!loadPromises.has(url)) {
      loadPromises.set(url, new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(link);
      }));
    }
    return loadPromises.get(url);
  }

  /** Catalog URLs are asset-server paths ("/…") or absolute. */
  function resolveURL(url) {
    if (/^https?:\/\//.test(url)) return url;
    const base = window.CommsShim?.assetBase || 'http://127.0.0.1:8765';
    return base + url;
  }

  // --------------------------------------------------------------
  // Core state — the catalog, the enabled functions, and which
  // panel tags the loaded function scripts registered.
  // --------------------------------------------------------------
  const core = {
    available: null,      // catalog array from functions.list (null = not loaded)
    availableError: null, // string when the catalog fetch failed
    enabled: new Map(),   // id -> { meta, state, tag, error }
    registered: new Map(), // id -> panel tag, set by registerFunction
    activeId: null,       // function shown in the panel host
    _listeners: new Set(),
    on(fn) { this._listeners.add(fn); },
    emit() { this._listeners.forEach((fn) => { try { fn(); } catch { /* keep going */ } }); },
  };

  const STORAGE_KEY = 'comms-shim:enabled-functions';

  function persistEnabled() {
    try {
      const ids = [...core.enabled.values()]
        .filter((e) => e.state === 'ready')
        .map((e) => e.meta.id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch { /* storage unavailable — session-only */ }
  }

  function persistedIds() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  /** Fetch the function catalog from localhostServer (once). */
  async function loadCatalog() {
    if (core.available) return core.available;
    try {
      const rpc = window.CommsShim?.rpc;
      if (!rpc) throw new Error('not connected to localhostServer');
      core.available = await rpc.call('functions.list');
      core.availableError = null;
    } catch (err) {
      core.available = [];
      core.availableError = err.message || String(err);
    }
    core.emit();
    return core.available;
  }

  /**
   * Enable a function: list entry appears immediately in state
   * "loading" (grayed), dependencies load in declared order, then
   * the function script — which registers its panel — and the
   * entry goes "ready" (or "error").
   */
  async function enableFunction(id) {
    const meta = core.available?.find((f) => f.id === id);
    if (!meta || core.enabled.has(id)) return;
    const entry = { meta, state: 'loading', tag: null, error: null };
    core.enabled.set(id, entry);
    core.emit();
    try {
      for (const dep of meta.dependencies ?? []) {
        if (dep.type === 'script') await loadScriptOnce(resolveURL(dep.url));
        else if (dep.type === 'style') await loadStyleOnce(resolveURL(dep.url));
      }
      if (!core.registered.has(id)) {
        await loadScriptOnce(resolveURL(meta.script));
      }
      const panelTag = core.registered.get(id);
      if (!panelTag) throw new Error(`${meta.name} did not register itself`);
      entry.tag = panelTag;
      entry.state = 'ready';
    } catch (err) {
      entry.state = 'error';
      entry.error = err.message || String(err);
    }
    core.emit();
    persistEnabled();
  }

  /** Disable a function: drop it from the list (its script stays
   *  loaded in the page, so re-enabling is instant). */
  function disableFunction(id) {
    if (!core.enabled.delete(id)) return;
    if (core.activeId === id) core.activeId = null;
    core.emit();
    persistEnabled();
  }

  /** Load the catalog, then re-enable the persisted functions. */
  async function initCore() {
    await loadCatalog();
    for (const id of persistedIds()) {
      // Sequential: keeps dependency order deterministic (the
      // loader dedupes shared URLs anyway).
      await enableFunction(id);
    }
  }

  // The public API function scripts use. panelCSS is the shared
  // panel styling; registerFunction is how a loaded script hands
  // its panel to the core: define() defines the custom element
  // (once) and returns its tag.
  window.RelayTool = {
    version: VERSION,
    panelCSS,
    registerFunction({ id, define }) {
      core.registered.set(id, define());
    },
  };

  // ----------------------------------------------------------------
  // <relay-function-list-vX-Y-Z> — left panel listing the ENABLED
  // functions from core state. Entries carry data-state: loading
  // entries are grayed and inert, error entries are red. Clicking
  // a ready entry marks it active and fires relay-function-select.
  // ----------------------------------------------------------------
  class RelayFunctionList extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; height: 100%; color-scheme: light; }
          nav { height: 100%; box-sizing: border-box; padding: 0.4rem;
                background: var(--rt-list-bg, #f4f4f6);
                border-right: 1px solid var(--rt-border, #ddd); }
          button { display: block; width: 100%; text-align: left;
                   padding: 0.45rem 0.6rem; margin-bottom: 0.25rem;
                   border: 1px solid transparent; border-radius: 6px;
                   background: none; font: inherit; cursor: pointer;
                   color: var(--rt-text, #222);
                   transition: background 120ms ease, opacity 120ms ease; }
          button:hover { background: var(--rt-hover, #e8e8ee); }
          button[aria-selected="true"] {
            background: var(--rt-accent, #2f6fed); color: #fff; }
          button[data-state="loading"] { opacity: 0.45; font-style: italic;
                                         cursor: default; }
          button[data-state="error"] { color: #b3261e; cursor: default; }
          .empty { padding: 0.45rem 0.6rem; color: var(--rt-muted, #777);
                   font-size: 0.85rem; }
        </style>
        <nav part="list"></nav>`;
      this._nav = this.shadowRoot.querySelector('nav');
      this._render();
      core.on(() => this._render());
      this.shadowRoot.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-function-id]');
        if (btn && btn.dataset.state === 'ready') {
          this.dispatchEvent(new CustomEvent('relay-function-select', {
            detail: { id: btn.dataset.functionId },
            bubbles: true, composed: true,
          }));
        }
      });
    }

    _render() {
      const entries = [...core.enabled.values()];
      this._nav.innerHTML = entries.length
        ? entries.map((e) => `
            <button type="button" role="option" data-function-id="${e.meta.id}"
                    data-state="${e.state}"
                    aria-selected="${String(core.activeId === e.meta.id)}"
                    ${e.state === 'error' ? `title="${e.error ?? ''}"` : ''}
                    >${e.meta.name}</button>`).join('')
        : '<div class="empty">No functions enabled</div>';
    }
  }

  // ----------------------------------------------------------------
  // <relay-settings-panel-vX-Y-Z> — the Settings view, laid out
  // like an IDE settings page: a section list on the left, the
  // selected section's settings on the right, and an × in the
  // header that closes back to the previous view (it fires
  // relay-settings-close; <relay-tool> handles the return).
  //
  // Sections are a small registry — one entry per section, its
  // content rendered by _renderSection. The Functions section
  // lists the catalog: one checkbox row per function (name,
  // version, description). Toggling a checkbox fires
  // relay-function-toggle; the core does the loading and this
  // panel re-renders from core state.
  // ----------------------------------------------------------------
  const SETTINGS_SECTIONS = [
    { id: 'functions', label: 'Functions' },
  ];

  class RelaySettingsPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._section = SETTINGS_SECTIONS[0].id;
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          ${panelCSS}
          .settings { display: flex; flex-direction: column; }
          .settings-head { flex: none; display: flex; align-items: center;
                           gap: 0.5rem; margin-bottom: 0.4rem; }
          .settings-head h3 { flex: 1; margin: 0; font-size: 0.95rem; }
          .settings-head button { border: none; background: none;
                                  font: inherit; cursor: pointer;
                                  color: inherit; padding: 0 0.3rem; }
          .settings-body { flex: 1; display: flex; min-height: 0; }
          .sections { width: 118px; flex: none; padding-right: 0.5rem;
                      border-right: 1px solid var(--rt-border, #ddd); }
          .sections button { display: block; width: 100%; text-align: left;
                             padding: 0.4rem 0.5rem; margin-bottom: 0.25rem;
                             border: 1px solid transparent; border-radius: 6px;
                             background: none; font: inherit; cursor: pointer;
                             color: var(--rt-text, #222); }
          .sections button:hover { background: var(--rt-hover, #e8e8ee); }
          .sections button[aria-selected="true"] {
            background: var(--rt-accent, #2f6fed); color: #fff; }
          .section-content { flex: 1; min-width: 0; overflow-y: auto;
                             padding-left: 0.7rem; }
          .row { display: flex; gap: 0.5rem; align-items: flex-start;
                 padding: 0.45rem 0.2rem;
                 border-bottom: 1px solid var(--rt-border, #eee); }
          .row input { margin-top: 0.2rem; }
          .name { font-weight: 600; }
          .version { color: var(--rt-muted, #777); font-size: 0.8rem;
                     margin-left: 0.35rem; }
          .desc { color: var(--rt-muted, #777); font-size: 0.85rem; }
          .err { color: #b3261e; font-size: 0.85rem; }
          .note { color: var(--rt-muted, #777); }
        </style>
        <div class="panel settings">
          <div class="settings-head">
            <h3>Settings</h3>
            <button type="button" data-action="close-settings"
                    aria-label="Close settings">✕</button>
          </div>
          <div class="settings-body">
            <nav class="sections"></nav>
            <div class="section-content"></div>
          </div>
        </div>`;
      this._sectionsEl = this.shadowRoot.querySelector('.sections');
      this._contentEl = this.shadowRoot.querySelector('.section-content');
      this._render();
      core.on(() => this._render());
      if (core.available === null) loadCatalog();
      this.shadowRoot.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="close-settings"]')) {
          this.dispatchEvent(new CustomEvent('relay-settings-close', {
            bubbles: true, composed: true,
          }));
          return;
        }
        const btn = e.target.closest('button[data-section-id]');
        if (btn) {
          this._section = btn.dataset.sectionId;
          this._render();
        }
      });
      this.shadowRoot.addEventListener('change', (e) => {
        const box = e.target.closest('input[type="checkbox"][data-function-id]');
        if (box) {
          this.dispatchEvent(new CustomEvent('relay-function-toggle', {
            detail: { id: box.dataset.functionId, enabled: box.checked },
            bubbles: true, composed: true,
          }));
        }
      });
    }

    _render() {
      this._sectionsEl.innerHTML = SETTINGS_SECTIONS.map((sec) => `
        <button type="button" data-section-id="${sec.id}"
                aria-selected="${String(this._section === sec.id)}"
                >${sec.label}</button>`).join('');
      this._contentEl.innerHTML = this._section === 'functions'
        ? this._functionsHTML()
        : '';
    }

    _functionsHTML() {
      if (core.available === null) {
        return '<p class="note">Loading available functions…</p>';
      }
      if (core.availableError) {
        return `<p class="err">Could not load the function list: ${core.availableError}</p>`;
      }
      return core.available.map((meta) => {
        const entry = core.enabled.get(meta.id);
        const state = entry?.state ?? 'off';
        return `
          <div class="row">
            <input type="checkbox" data-function-id="${meta.id}"
                   ${entry ? 'checked' : ''}
                   ${state === 'loading' ? 'disabled' : ''}>
            <div>
              <span class="name">${meta.name}</span><span class="version">v${meta.version}</span>
              <div class="desc">${meta.description ?? ''}</div>
              ${state === 'loading' ? '<div class="note">Loading…</div>' : ''}
              ${state === 'error' ? `<div class="err">Failed to load: ${entry.error ?? ''}</div>` : ''}
            </div>
          </div>`;
      }).join('');
    }
  }

  // ----------------------------------------------------------------
  // <relay-tool-vX-Y-Z> — the floating window. Drag by the header
  // (pointer events), resize by the corner (pure CSS resize),
  // close with the × button. A menu bar under the header holds
  // the File menu ("Settings"). The body hosts
  // the function list on the left and the active view (a function
  // panel, the config panel, or an empty hint) on the right.
  // ----------------------------------------------------------------
  class RelayTool extends HTMLElement {
    constructor() {
      super();
      // A custom element constructor must not add attributes or
      // children to the element — createElement throws
      // NotSupportedError ("The result must not have attributes").
      // attachShadow is allowed; everything else goes in
      // connectedCallback.
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.dataset.version = VERSION;
      this.shadowRoot.innerHTML = `
        <style>
          :host { position: fixed; top: 16px; right: 16px; z-index: 2147483000;
                  font-family: system-ui, sans-serif; font-size: 14px;
                  color: var(--rt-text, #222); color-scheme: light; }
          .window { width: 560px; height: 380px; min-width: 340px;
                    min-height: 220px; resize: both; overflow: hidden;
                    display: flex; flex-direction: column;
                    background: var(--rt-bg, #fff);
                    border: 1px solid var(--rt-border, #ccc);
                    border-radius: 10px;
                    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
                    animation: tool-in 180ms ease-out; }
          @keyframes tool-in {
            from { opacity: 0; transform: translateY(-6px) scale(0.98); }
            to   { opacity: 1; transform: none; }
          }
          header { display: flex; align-items: center; gap: 0.5rem;
                   padding: 0.45rem 0.7rem; cursor: move; user-select: none;
                   background: var(--rt-header-bg, #ececf1);
                   border-bottom: 1px solid var(--rt-border, #ddd); }
          header .title { font-weight: 600; flex: 1; }
          header .version { color: var(--rt-muted, #777);
                            font-size: 0.8rem; }
          header button { border: none; background: none; font: inherit;
                          cursor: pointer; color: inherit;
                          padding: 0 0.3rem; }
          .menubar { display: flex; padding: 0.15rem 0.4rem;
                     background: var(--rt-bg, #fff);
                     border-bottom: 1px solid var(--rt-border, #ddd); }
          .menu { position: relative; }
          .menu > button { border: none; background: none; font: inherit;
                           padding: 0.25rem 0.5rem; border-radius: 4px;
                           cursor: pointer; color: inherit; }
          .menu > button:hover,
          .menu[data-open="true"] > button {
            background: var(--rt-hover, #e8e8ee); }
          .menu-dropdown { display: none; position: absolute; top: 100%;
                           left: 0; min-width: 220px; z-index: 10;
                           background: var(--rt-bg, #fff);
                           border: 1px solid var(--rt-border, #ccc);
                           border-radius: 6px; padding: 0.25rem;
                           box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); }
          .menu[data-open="true"] .menu-dropdown { display: block; }
          .menu-dropdown button { display: block; width: 100%;
                                  text-align: left; border: none;
                                  background: none; font: inherit;
                                  padding: 0.4rem 0.5rem; border-radius: 4px;
                                  cursor: pointer; color: inherit; }
          .menu-dropdown button:hover { background: var(--rt-hover, #e8e8ee); }
          main { flex: 1; display: flex; min-height: 0; }
          ${tag('relay-function-list')} { width: 150px; flex: none; }
          .host { flex: 1; min-width: 0; }
          .hint { padding: 0.8rem; color: var(--rt-muted, #777); }
          .settings-host { display: none; }
          .window[data-view="settings"] main { display: none; }
          .window[data-view="settings"] .settings-host {
            display: block; flex: 1; min-height: 0; }
        </style>
        <div class="window">
          <header part="header">
            <span class="title">Comms Shim — Relay Tool</span>
            <span class="version">v${VERSION}</span>
            <button type="button" data-action="close"
                    aria-label="Close">✕</button>
          </header>
          <div class="menubar">
            <div class="menu" data-open="false">
              <button type="button" data-action="menu" aria-haspopup="true">File</button>
              <div class="menu-dropdown" role="menu">
                <button type="button" data-action="settings" role="menuitem">Settings</button>
              </div>
            </div>
          </div>
          <main>
            <${tag('relay-function-list')}></${tag('relay-function-list')}>
            <div class="host" part="panel-host"></div>
          </main>
          <div class="settings-host" part="settings-host"></div>
        </div>`;

      this._window = this.shadowRoot.querySelector('.window');
      this._host = this.shadowRoot.querySelector('.host');
      this._settingsHost = this.shadowRoot.querySelector('.settings-host');
      this._menu = this.shadowRoot.querySelector('.menu');
      this._view = 'empty';
      this._panels = new Map(); // function id -> panel element (kept alive)
      this._hintEl = document.createElement('div');
      this._hintEl.className = 'hint';
      this._hintEl.textContent =
        'No function selected. Enable functions under File → Settings';

      this.addEventListener('relay-function-select', (e) =>
        this.showFunction(e.detail.id));
      this.addEventListener('relay-function-toggle', (e) => {
        if (e.detail.enabled) enableFunction(e.detail.id);
        else disableFunction(e.detail.id);
      });
      core.on(() => {
        // A disabled function's panel is destroyed with it.
        for (const [id, el] of this._panels) {
          if (!core.enabled.has(id)) {
            el.remove();
            this._panels.delete(id);
          }
        }
        // If the visible function went away, fall back to the hint.
        if (this._view === 'function' && !core.enabled.has(core.activeId)) {
          this._showEmpty();
        }
      });

      this.shadowRoot.querySelector('[data-action="close"]')
        .addEventListener('click', () => this.remove());
      this.shadowRoot.querySelector('[data-action="menu"]')
        .addEventListener('click', () => this._toggleMenu());
      this.shadowRoot.querySelector('[data-action="settings"]')
        .addEventListener('click', () => {
          this._closeMenu();
          this.showSettings();
        });
      this.addEventListener('relay-settings-close', () => {
        const back = this._returnFunctionId;
        this._returnFunctionId = null;
        if (back && core.enabled.get(back)?.state === 'ready') {
          this.showFunction(back);
        } else {
          this._showEmpty();
        }
      });
      this._onDocPointerDown = (e) => {
        if (!e.composedPath().includes(this._menu)) this._closeMenu();
      };
      this._onKeyDown = (e) => {
        if (e.key === 'Escape') this._closeMenu();
      };
      document.addEventListener('pointerdown', this._onDocPointerDown, true);
      document.addEventListener('keydown', this._onKeyDown);
      this._dragSetup(this.shadowRoot.querySelector('header'));

      this._showEmpty();
      initCore();
    }

    disconnectedCallback() {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
      document.removeEventListener('keydown', this._onKeyDown);
    }

    _toggleMenu() {
      this._menu.dataset.open = String(this._menu.dataset.open !== 'true');
    }

    _closeMenu() {
      this._menu.dataset.open = 'false';
    }

    /**
     * Show the panel of an enabled, ready function. Panels are
     * created once and then only hidden/shown — switching away
     * never destroys a panel, so its state (a chat connection,
     * a scrollback, a half-typed message) is still there when
     * you switch back. Disabling the function destroys it.
     */
    showFunction(id) {
      const entry = core.enabled.get(id);
      if (!entry || entry.state !== 'ready') return;
      delete this._window.dataset.view;
      let el = this._panels.get(id);
      if (!el) {
        el = document.createElement(entry.tag);
        this._panels.set(id, el);
        this._host.appendChild(el);
      }
      this._hintEl.remove();
      for (const [pid, panel] of this._panels) {
        panel.style.display = pid === id ? '' : 'none';
      }
      core.activeId = id;
      this._view = 'function';
      this.dataset.activeFunction = id;
      core.emit();
    }

    /** Show the Settings view — it takes over the whole body
     *  (data-view="settings" hides <main>, function list and
     *  all) — remembering the function to return to when
     *  Settings closes (the × button). Panels stay alive
     *  underneath, so a chat in progress is not interrupted. */
    showSettings() {
      if (this._view === 'function') {
        this._returnFunctionId = core.activeId;
      } else if (this._view !== 'settings') {
        this._returnFunctionId = null;
      }
      this._view = 'settings';
      delete this.dataset.activeFunction;
      this._window.dataset.view = 'settings';
      this._settingsHost.replaceChildren(
        document.createElement(tag('relay-settings-panel')));
    }

    _showEmpty() {
      this._view = 'empty';
      delete this.dataset.activeFunction;
      delete this._window.dataset.view;
      for (const panel of this._panels.values()) {
        panel.style.display = 'none';
      }
      this._host.appendChild(this._hintEl);
    }

    _dragSetup(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const rect = this.getBoundingClientRect();
        // Switch from right-anchored to explicit left/top once.
        this.style.left = `${rect.left}px`;
        this.style.top = `${rect.top}px`;
        this.style.right = 'auto';
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          this.style.left = `${ev.clientX - dx}px`;
          this.style.top = `${ev.clientY - dy}px`;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }
  }

  // Plain defines: the versioned names cannot collide with a
  // different version, and the same version returned early above.
  customElements.define(tag('relay-function-list'), RelayFunctionList);
  customElements.define(tag('relay-settings-panel'), RelaySettingsPanel);
  customElements.define(tag('relay-tool'), RelayTool);

  try {
    const host = document.body ?? document.documentElement;
    host.appendChild(document.createElement(tag('relay-tool')));
    window.CommsShimTools[VERSION] = { tagSuffix };
    if (window.CommsShim) window.CommsShim.toolVersion = VERSION;
    window.dispatchEvent(new CustomEvent('comms-shim:tool-ready', {
      detail: { version: VERSION },
    }));
  } catch (e) {
    console.error('[Comms Shim] Relay Tool failed to start:', e);
  }
})();
