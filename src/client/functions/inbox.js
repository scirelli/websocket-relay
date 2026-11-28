/**
 * Comms Shim — Relay Tool function: Inbox (v1.0.0)
 *
 * A loadable function: localhostServer serves this file at
 * /functions/inbox.js and lists it in the functions.list
 * catalog. The Relay Tool core loads it on demand; it defines
 * its panel component and registers with the core via
 * window.RelayTool.registerFunction. Functions version
 * independently of the tool — the tag name carries this version.
 *
 * Inbox: one place for everything that arrives for the user to
 * review and allow or deny — the merged Script Inbox and
 * Assistant functions, whose flows were the same shape (an
 * item arrives, the user reviews it, Accept/Deny decides).
 * One panel, one broker connection, one list with two kinds
 * of item:
 *
 * - Scripts. Deliveries arrive as script.deliver JSON-RPC
 *   notifications on scripts/<username>, params {from, name,
 *   description, script}. The detail shows the full script;
 *   Accept executes it on the page (a <script> element, page
 *   scope) exactly once. States: unread, read, run, denied.
 *
 * - Read Page requests. A snapshot request arrives as an
 *   assistant.snapshot notification on
 *   assistant/<username>/request and lands in the list as a
 *   "Read Page" item. Accept captures the page at that moment
 *   and answers on assistant/<username>/snapshot with the URL
 *   and title, screen/viewport metrics, the full DOM
 *   (chunked), and the console buffer; Deny answers with a
 *   one-line {kind: "denied"} notice, so a refusal is not
 *   mistaken for a lost message. The request channel takes
 *   snapshot requests only — no eval, no arbitrary commands.
 *
 * The panel also owns the page console capture the Assistant
 * had: the page's console (log/info/warn/error,
 * window.onerror, unhandled promise rejections) is hooked
 * into a local, deduplicated buffer — repeats collapse by
 * fingerprint (level + text + source) into one entry with a
 * count and first/last timestamps, so a broken page spamming
 * the same error cannot flood it. The capture starts when the
 * panel is created; nothing leaves the page on its own. The
 * Stream console checkbox at the top of the panel instead
 * sends each new distinct entry live on
 * assistant/<username>/console. A badge on the page shows
 * the inbox is connected; clicking it disconnects.
 *
 * Both inbound channels are QoS 0: if this function is not
 * enabled and connected when an item is sent, it is lost —
 * same rule as chat.
 */
(() => {
  const VERSION = '1.0.0';
  const TAG = `relay-inbox-panel-v${VERSION.replaceAll('.', '-')}`;
  const MAX_ENTRIES = 200;   // distinct (deduplicated) entries kept
  const MAX_TEXT = 500;      // chars kept per entry
  const DOM_CHUNK = 16384;   // chars per snapshot DOM chunk
  const RECENT_SHOWN = 8;    // entries previewed in the panel

  function serializeArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) {
      const frame = a.stack ? a.stack.split('\n')[1]?.trim() : '';
      return `${a.name}: ${a.message}${frame ? ' @ ' + frame : ''}`;
    }
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  }

  class RelayInboxPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._rpc = null;
      this._unsubscribe = [];
      this._state = 'disconnected';
      this._items = []; // newest first; scripts + page requests
      this._nextId = 1;
      this._selectedId = null;
      this._entries = new Map(); // console fingerprint -> entry
      this._total = 0;
      this._dropped = 0;
      this._hooks = null;
      this._badge = null;
      this._renderTimer = null;
    }

    connectedCallback() {
      const homeBroker = window.CommsShim?.brokerUrl || 'ws://127.0.0.1:8083';
      this.shadowRoot.innerHTML = `
        <style>
          ${window.RelayTool.panelCSS}
          .inbox { display: flex; flex-direction: column; height: 100%;
                   box-sizing: border-box; gap: 0.5rem; }
          .top, .bar { display: flex; align-items: center; gap: 0.4rem; }
          .top input { flex: 1; min-width: 0; padding: 0.4rem; font: inherit;
                       font-family: ui-monospace, Menlo, monospace;
                       font-size: 0.85rem; }
          .top label, .bar label { color: var(--rt-muted, #777);
                                   font-size: 0.85rem; }
          .top input[name="me"] { flex: 0 1 7rem;
                                  font-family: inherit; font-size: inherit; }
          .connect { padding: 0.4rem 0.6rem; font: inherit; cursor: pointer; }
          .light { width: 11px; height: 11px; border-radius: 50%; flex: none;
                   background: #d64545;
                   box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset; }
          .inbox[data-state="connecting"] .light { background: #e3a008;
                   animation: pulse 900ms ease-in-out infinite; }
          .inbox[data-state="connected"] .light { background: #2da44e; }
          @keyframes pulse { 50% { opacity: 0.35; } }
          .bar .summary { color: var(--rt-muted, #777); font-size: 0.85rem;
                          margin-left: auto; }
          .body { flex: 1; display: flex; min-height: 0; gap: 0; }
          .list { width: 168px; flex: none; overflow-y: auto;
                  border: 1px solid var(--rt-border, #ddd); border-radius: 6px;
                  padding: 0.3rem; }
          .list .empty { padding: 0.4rem; color: var(--rt-muted, #777);
                         font-size: 0.85rem; }
          .item { display: block; width: 100%; text-align: left;
                  padding: 0.4rem 0.5rem; margin-bottom: 0.25rem;
                  border: 1px solid transparent; border-radius: 6px;
                  background: none; font: inherit; cursor: pointer;
                  color: var(--rt-text, #222); }
          .item:hover { background: var(--rt-hover, #e8e8ee); }
          .item[aria-selected="true"] {
            background: var(--rt-accent, #2f6fed); color: #fff; }
          .item .nm { display: block; overflow-wrap: anywhere; }
          .item .meta { display: block; font-size: 0.78rem;
                        color: var(--rt-muted, #777); }
          .item[aria-selected="true"] .meta { color: #dbe4fb; }
          .item[data-state="unread"] .nm,
          .item[data-state="new"] .nm { font-weight: 700; }
          .item[data-state="unread"] .nm::before,
          .item[data-state="new"] .nm::before {
            content: "● "; color: var(--rt-accent, #2f6fed); }
          .item[data-state="run"] .nm::after {
            content: " ✓ ran"; color: #2da44e; font-size: 0.78rem; }
          .item[data-state="sent"] .nm::after {
            content: " ✓ sent"; color: #2da44e; font-size: 0.78rem; }
          .item[data-state="denied"] .nm {
            text-decoration: line-through; color: var(--rt-muted, #777); }
          .detail { flex: 1; min-width: 0; display: flex;
                    flex-direction: column; gap: 0.4rem;
                    padding-left: 0.7rem; }
          .detail .hint { color: var(--rt-muted, #777); padding: 0.4rem 0; }
          .d-name { font-weight: 700; font-size: 1rem;
                    overflow-wrap: anywhere; }
          .d-from { color: var(--rt-muted, #777); font-size: 0.82rem; }
          .d-desc { font-size: 0.9rem; overflow-wrap: anywhere; }
          .d-script { flex: 1; min-height: 0; width: 100%;
                      box-sizing: border-box; resize: none;
                      font-family: ui-monospace, Menlo, monospace;
                      font-size: 0.8rem; padding: 0.5rem; }
          .d-page { flex: 1; min-height: 0; font-size: 0.85rem;
                    overflow-wrap: anywhere; }
          .d-page .url { font-family: ui-monospace, Menlo, monospace;
                         font-size: 0.8rem; }
          .actions { flex: none; display: flex; align-items: center;
                     gap: 0.4rem; }
          .actions button { padding: 0.4rem 0.9rem; font: inherit;
                            cursor: pointer; }
          .actions button:disabled { cursor: default; opacity: 0.5; }
          .actions .status { color: var(--rt-muted, #777);
                             font-size: 0.85rem; }
          .log { flex: none; max-height: 6.5rem; overflow: auto;
                 font-family: ui-monospace, Menlo, monospace;
                 font-size: 0.78rem; line-height: 1.5; }
          .log .row { white-space: nowrap; overflow: hidden;
                      text-overflow: ellipsis; }
          .log .count { color: var(--rt-muted, #777); }
          .log .lvl-error { color: #d64545; }
          .log .lvl-warn { color: #e3a008; }
        </style>
        <div class="inbox panel" data-state="disconnected">
          <form class="top">
            <label for="broker">Broker</label>
            <input name="broker" value="${homeBroker}"
                   placeholder="broker — ws://host:port"
                   autocomplete="off" spellcheck="false">
            <label for="me">You are</label>
            <input name="me" value="steve" autocomplete="off" spellcheck="false">
            <button class="connect" type="submit">Connect</button>
            <span class="light" role="status" aria-label="Not connected"></span>
          </form>
          <div class="bar">
            <label><input type="checkbox" name="stream"> Stream console</label>
            <span class="summary">0 distinct · 0 total</span>
          </div>
          <div class="body">
            <div class="list" part="list"></div>
            <div class="detail" part="detail"></div>
          </div>
          <div class="log" part="log"></div>
        </div>`;

      this._root = this.shadowRoot.querySelector('.inbox');
      this._broker = this.shadowRoot.querySelector('input[name="broker"]');
      this._me = this.shadowRoot.querySelector('input[name="me"]');
      this._light = this.shadowRoot.querySelector('.light');
      this._listEl = this.shadowRoot.querySelector('.list');
      this._detailEl = this.shadowRoot.querySelector('.detail');
      this._streamBox = this.shadowRoot.querySelector('input[name="stream"]');
      this._summary = this.shadowRoot.querySelector('.summary');
      this._logEl = this.shadowRoot.querySelector('.log');

      this.shadowRoot.querySelector('.top').addEventListener('submit', (e) => {
        e.preventDefault();
        this._toggleConnect();
      });
      this._me.addEventListener('change', () => {
        if (this._rpc && this._state === 'connected') {
          this._unsubscribeAs(this._subscribedAs);
          this._subscribeAs(this._me.value.trim());
        }
      });
      this._streamBox.addEventListener('change', () => {
        // Turning streaming on sends the current buffer once, so
        // the other side starts from the same picture.
        if (this._streamBox.checked && this._state === 'connected') {
          for (const e of this._entries.values()) this._publishEntry(e);
        }
      });
      this._listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-entry-id]');
        if (btn) this._select(Number(btn.dataset.entryId));
      });
      this._detailEl.addEventListener('click', (e) => {
        const action = e.target.closest('button[data-action]')?.dataset.action;
        if (action === 'accept') this._accept();
        if (action === 'deny') this._deny();
      });

      this._installHooks();
      this._renderList();
      this._renderDetail();
      this._renderLog();
      // Starts disconnected, like Chat: the user clicks Connect.
    }

    disconnectedCallback() {
      this._teardown();
      this._removeHooks();
      this._removeBadge();
    }

    _teardown() {
      this._unsubscribe.forEach((u) => u());
      this._unsubscribe = [];
      if (this._rpc) {
        this._rpc.close();
        this._rpc = null;
      }
      this._subscribedAs = null;
      this._removeBadge();
      this._setState('disconnected');
    }

    _setState(state) {
      this._state = state;
      if (!this._root) return;
      this._root.dataset.state = state;
      this._broker.disabled = state !== 'disconnected';
      this.shadowRoot.querySelector('.connect').textContent =
        state === 'disconnected' ? 'Connect' : 'Disconnect';
      this._light.setAttribute('aria-label', {
        disconnected: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
      }[state]);
      // A page request can only be Accepted while connected.
      if (this._detailEl) this._renderDetail();
    }

    _subscribeAs(name) {
      this._subscribedAs = name;
      if (!name) return;
      this._rpc.subscribeTopic(`scripts/${name}`);
      this._rpc.subscribeTopic(`assistant/${name}/request`);
    }

    _unsubscribeAs(name) {
      if (!name) return;
      this._rpc.unsubscribeTopic(`scripts/${name}`);
      this._rpc.unsubscribeTopic(`assistant/${name}/request`);
    }

    async _toggleConnect() {
      if (this._state === 'connected' || this._state === 'connecting') {
        this._teardown();
        return;
      }
      const url = this._broker.value.trim();
      const me = this._me.value.trim();
      if (!url || !me) return;
      if (!window.mqtt || !window.MqttRpc) return;
      this._setState('connecting');
      const rpc = new window.MqttRpc(url,
        `${window.CommsShim?.clientId || 'web'}-inbox`);
      this._rpc = rpc;
      this._unsubscribe.push(rpc.onStateChange((state) => {
        if (this._rpc !== rpc) return;
        if (state === 'connected') this._setState('connected');
        else if (state === 'disconnected' && this._state === 'connected') {
          this._setState('disconnected');
        }
      }));
      this._unsubscribe.push(rpc.onNotification('script.deliver', (p) => {
        this._addScript(p);
      }));
      this._unsubscribe.push(rpc.onNotification('assistant.snapshot', (p) => {
        this._addPageRequest(p);
      }));
      try {
        await rpc.connect();
        this._subscribeAs(me);
        this._setState('connected');
        this._showBadge();
      } catch {
        this._teardown();
      }
    }

    _showBadge() {
      this._removeBadge();
      const badge = document.createElement('div');
      badge.textContent = 'Inbox: live — click to stop';
      badge.style.cssText = 'position:fixed; left:12px; bottom:12px; ' +
        'z-index:2147482998; background:#222; color:#eee; ' +
        'font:12px system-ui, sans-serif; padding:4px 10px; ' +
        'border-radius:999px; opacity:0.85; cursor:pointer;';
      badge.addEventListener('click', () => this._toggleConnect());
      document.body.appendChild(badge);
      this._badge = badge;
    }

    _removeBadge() {
      this._badge?.remove();
      this._badge = null;
    }

    // --- items -------------------------------------------------

    _addScript(p) {
      this._items.unshift({
        id: this._nextId++,
        kind: 'script',
        from: typeof p?.from === 'string' ? p.from : 'unknown',
        name: typeof p?.name === 'string' && p.name ? p.name : '(unnamed script)',
        description: typeof p?.description === 'string' ? p.description : '',
        script: typeof p?.script === 'string' ? p.script : '',
        state: 'unread',
      });
      this._renderList();
    }

    _addPageRequest(p) {
      this._items.unshift({
        id: this._nextId++,
        kind: 'page',
        from: typeof p?.from === 'string' && p.from ? p.from : 'unknown',
        reqId: p?.id || 'snap-' + Date.now().toString(36),
        state: 'new',
      });
      this._renderList();
    }

    _selected() {
      return this._items.find((e) => e.id === this._selectedId) ?? null;
    }

    _select(id) {
      const item = this._items.find((e) => e.id === id);
      if (!item) return;
      this._selectedId = id;
      if (item.kind === 'script' && item.state === 'unread') {
        item.state = 'read';
      }
      this._renderList();
      this._renderDetail();
    }

    _accept() {
      const item = this._selected();
      if (!item) return;
      if (item.kind === 'script') {
        if (item.state === 'run' || item.state === 'denied') return;
        // Execute on the page, in page scope — the script element
        // runs as it is appended; removing it afterwards does not
        // undo the execution.
        const el = document.createElement('script');
        el.textContent = item.script;
        document.documentElement.appendChild(el);
        el.remove();
        item.state = 'run';
      } else {
        if (item.state !== 'new' || this._state !== 'connected') return;
        this._sendSnapshot(item.reqId);
        item.state = 'sent';
      }
      this._renderList();
      this._renderDetail();
    }

    _deny() {
      const item = this._selected();
      if (!item) return;
      if (item.kind === 'script') {
        if (item.state === 'run' || item.state === 'denied') return;
      } else {
        if (item.state !== 'new') return;
        // Tell the requester it was refused, when we can.
        const me = this._me.value.trim();
        if (this._rpc && me) {
          this._rpc.publishTopic(`assistant/${me}/snapshot`,
            { id: item.reqId, kind: 'denied' });
        }
      }
      item.state = 'denied';
      this._renderList();
      this._renderDetail();
    }

    _renderList() {
      this._listEl.innerHTML = this._items.length
        ? this._items.map((e) => `
            <button type="button" class="item" data-entry-id="${e.id}"
                    data-kind="${e.kind}" data-state="${e.state}"
                    aria-selected="${String(this._selectedId === e.id)}">
              <span class="nm"></span>
              <span class="meta"></span>
            </button>`).join('')
        : '<div class="empty">Nothing yet — scripts and page requests land here</div>';
      // Names and senders are data, never markup: fill via textContent.
      this._listEl.querySelectorAll('.item').forEach((btn, i) => {
        const e = this._items[i];
        btn.querySelector('.nm').textContent =
          e.kind === 'page' ? 'Read Page' : e.name;
        btn.querySelector('.meta').textContent = e.kind === 'page'
          ? `page request from ${e.from}`
          : `script from ${e.from}`;
      });
    }

    _renderDetail() {
      const item = this._selected();
      if (!item) {
        this._detailEl.innerHTML =
          '<div class="hint">Select an item to review it. Nothing runs and nothing is sent until you Accept it.</div>';
        return;
      }
      if (item.kind === 'page') this._renderPageDetail(item);
      else this._renderScriptDetail(item);
    }

    _renderScriptDetail(item) {
      const decided = item.state === 'run' || item.state === 'denied';
      this._detailEl.innerHTML = `
        <div class="d-name"></div>
        <div class="d-from"></div>
        <div class="d-desc"></div>
        <textarea class="d-script" readonly spellcheck="false"></textarea>
        <div class="actions">
          <button type="button" data-action="accept" ${decided ? 'disabled' : ''}>Accept</button>
          <button type="button" data-action="deny" ${decided ? 'disabled' : ''}>Deny</button>
          <span class="status">${
            item.state === 'run' ? 'Ran on this page'
            : item.state === 'denied' ? 'Denied — not run'
            : 'Review the script, then Accept to run it'}</span>
        </div>`;
      this._detailEl.querySelector('.d-name').textContent = item.name;
      this._detailEl.querySelector('.d-from').textContent = `from ${item.from}`;
      this._detailEl.querySelector('.d-desc').textContent = item.description;
      this._detailEl.querySelector('.d-script').value = item.script;
    }

    _renderPageDetail(item) {
      const decided = item.state !== 'new';
      const canSend = this._state === 'connected';
      this._detailEl.innerHTML = `
        <div class="d-name">Read Page</div>
        <div class="d-from"></div>
        <div class="d-desc">Accept sends this page — URL, title, the
          full DOM, and the console buffer — to the requester. The
          page is captured when you Accept, not when the request
          arrived.</div>
        <div class="d-page">
          <div class="title"></div>
          <div class="url"></div>
        </div>
        <div class="actions">
          <button type="button" data-action="accept" ${decided || !canSend ? 'disabled' : ''}>Accept</button>
          <button type="button" data-action="deny" ${decided ? 'disabled' : ''}>Deny</button>
          <span class="status">${
            item.state === 'sent' ? 'Page sent'
            : item.state === 'denied' ? 'Denied — nothing sent'
            : canSend ? 'Review, then Accept to send this page'
            : 'Connect to send this page'}</span>
        </div>`;
      this._detailEl.querySelector('.d-from').textContent =
        `requested by ${item.from}`;
      this._detailEl.querySelector('.d-page .title').textContent =
        document.title;
      this._detailEl.querySelector('.d-page .url').textContent =
        location.href;
    }

    // --- console capture ---------------------------------------

    _installHooks() {
      if (this._hooks) return;
      const orig = {};
      for (const level of ['log', 'info', 'warn', 'error']) {
        orig[level] = console[level];
        console[level] = (...args) => {
          try {
            this._addEntry(level, args.map(serializeArg).join(' '), '');
          } catch { /* capture must never break the page */ }
          orig[level].apply(console, args);
        };
      }
      this._onError = (e) => {
        if (!e.message) return; // resource-load errors carry no message
        const source = e.filename
          ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
        this._addEntry('error', e.message, source);
      };
      this._onRejection = (e) => {
        this._addEntry('error',
          'unhandledrejection: ' + serializeArg(e.reason), '');
      };
      window.addEventListener('error', this._onError);
      window.addEventListener('unhandledrejection', this._onRejection);
      this._hooks = orig;
    }

    _removeHooks() {
      if (!this._hooks) return;
      for (const level of ['log', 'info', 'warn', 'error']) {
        console[level] = this._hooks[level];
      }
      window.removeEventListener('error', this._onError);
      window.removeEventListener('unhandledrejection', this._onRejection);
      this._hooks = null;
    }

    _addEntry(level, text, source) {
      text = String(text).slice(0, MAX_TEXT);
      this._total++;
      const key = `${level}|${source}|${text}`;
      const now = Date.now();
      let entry = this._entries.get(key);
      if (entry) {
        entry.count++;
        entry.last = now;
      } else {
        entry = { level, text, source, count: 1, first: now, last: now };
        this._entries.set(key, entry);
        if (this._entries.size > MAX_ENTRIES) {
          this._entries.delete(this._entries.keys().next().value);
          this._dropped++;
        }
        if (this._streamBox?.checked && this._state === 'connected') {
          this._publishEntry(entry);
        }
      }
      this._scheduleRender();
    }

    _publishEntry(entry) {
      const me = this._me.value.trim();
      if (this._rpc && me) {
        this._rpc.publishTopic(`assistant/${me}/console`, entry);
      }
    }

    _scheduleRender() {
      if (this._renderTimer) return;
      this._renderTimer = setTimeout(() => {
        this._renderTimer = null;
        this._renderLog();
      }, 250);
    }

    _renderLog() {
      if (!this._logEl) return;
      this._summary.textContent =
        `${this._entries.size} distinct · ${this._total} total` +
        (this._dropped ? ` · ${this._dropped} dropped` : '');
      const rows = [...this._entries.values()].slice(-RECENT_SHOWN);
      this._logEl.replaceChildren(...rows.map((e) => {
        const row = document.createElement('div');
        row.className = 'row';
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = `×${e.count} `;
        const lvl = document.createElement('span');
        lvl.className = 'lvl-' + e.level;
        lvl.textContent = `[${e.level}] `;
        row.append(count, lvl, document.createTextNode(
          e.text + (e.source ? ` (${e.source})` : '')));
        return row;
      }));
    }

    // --- snapshots -----------------------------------------------

    _sendSnapshot(id) {
      if (!this._rpc || this._state !== 'connected') return;
      const me = this._me.value.trim();
      if (!me) return;
      id = id || 'snap-' + Date.now().toString(36);
      const topic = `assistant/${me}/snapshot`;
      const meta = {
        url: location.href,
        title: document.title,
        screen: {
          width: screen.width, height: screen.height,
          availWidth: screen.availWidth, availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
        },
        viewport: {
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
        scroll: { x: window.scrollX, y: window.scrollY },
      };
      const dom = document.documentElement.outerHTML;
      const total = Math.max(1, Math.ceil(dom.length / DOM_CHUNK));
      this._rpc.publishTopic(topic, { id, kind: 'begin', meta });
      for (let seq = 0; seq < total; seq++) {
        this._rpc.publishTopic(topic, {
          id, kind: 'dom', seq, total,
          text: dom.slice(seq * DOM_CHUNK, (seq + 1) * DOM_CHUNK),
        });
      }
      this._rpc.publishTopic(topic, {
        id, kind: 'console', entries: [...this._entries.values()],
      });
      this._rpc.publishTopic(topic, { id, kind: 'end' });
    }
  }

  window.RelayTool?.registerFunction({
    id: 'inbox',
    version: VERSION,
    define() {
      if (!customElements.get(TAG)) {
        customElements.define(TAG, RelayInboxPanel);
      }
      return TAG;
    },
  });
})();
