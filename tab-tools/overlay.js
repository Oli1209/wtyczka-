'use strict';

(() => {
  const W = window;
  // Po przeładowaniu rozszerzenia stary kontekst jest martwy, choć panel został na stronie.
  if (W.__ttHost && W.__ttHost.isConnected) {
    if (typeof W.__ttBind === 'function') {
      try { W.__ttBind(); } catch (err) { /* stary kontekst */ }
    }
    return;
  }

  const CSS = `
    :host {
      all: initial;
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483647;
      pointer-events: none;
    }
    .card {
      pointer-events: auto;
      width: 292px;
      max-width: calc(100vw - 24px);
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
      font: 400 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      opacity: 0;
      visibility: hidden;
      transform: translateY(6px);
      transition: opacity 0.14s ease, transform 0.14s ease;
    }
    .card.theme-dark {
      --bg: #121418;
      --soft: #181b20;
      --line: #272b32;
      --line-strong: #363c45;
      --fg: #e9ecf1;
      --muted: #959daa;
    }
    .card.theme-light {
      --bg: #ffffff;
      --soft: #f4f5f7;
      --line: #dfe2e7;
      --line-strong: #c6cbd3;
      --fg: #12151a;
      --muted: #5c646f;
    }
    .card.open {
      opacity: 1;
      visibility: visible;
      transform: none;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 7px;
      height: 27px;
      padding: 0 6px 0 9px;
      background: var(--soft);
      border-bottom: 1px solid var(--line);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .bar:active { cursor: grabbing; }
    .mark {
      width: 5px;
      height: 5px;
      flex: none;
      border: 1px solid var(--muted);
      border-radius: 50%;
    }
    .title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .chip {
      margin-left: auto;
      font-size: 9.5px;
      color: var(--muted);
      border: 1px solid var(--line-strong);
      border-radius: 3px;
      padding: 1px 5px;
      white-space: nowrap;
    }
    .x {
      width: 19px;
      height: 19px;
      flex: none;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: var(--muted);
      font: 500 14px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .x:hover { background: var(--line); color: var(--fg); }
    .body { padding: 9px; display: flex; flex-direction: column; gap: 6px; }
    .q {
      margin: 0;
      font-size: 10.5px;
      line-height: 1.4;
      color: var(--muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .list { display: flex; flex-direction: column; gap: 4px; }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      padding: 5px 7px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--soft);
    }
    .badge {
      flex: none;
      min-width: 16px;
      height: 16px;
      padding: 0 3px;
      border: 1px solid var(--line-strong);
      border-radius: 3px;
      color: var(--muted);
      font: 600 9.5px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-align: center;
    }
    .txt {
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1.35;
      word-break: break-word;
    }
    .open {
      margin: 0;
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1.4;
      word-break: break-word;
    }
    .pairs { display: flex; flex-direction: column; gap: 4px; }
    .pair {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 10px minmax(0, 1fr);
      align-items: baseline;
      gap: 4px;
      padding: 4px 7px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--soft);
      font-size: 11.5px;
      line-height: 1.35;
    }
    .pair .col { word-break: break-word; }
    .pair .dash { color: var(--muted); text-align: center; }
    .opts { display: flex; flex-direction: column; gap: 2px; padding-top: 2px; border-top: 1px solid var(--line); }
    .opt {
      margin: 0;
      font-size: 10.5px;
      line-height: 1.35;
      color: var(--muted);
      word-break: break-word;
    }
    .notes {
      margin: 0;
      font-size: 10px;
      line-height: 1.35;
      color: var(--muted);
    }
    .warnbar {
      margin: 0;
      padding: 4px 7px;
      border: 1px solid var(--line-strong);
      border-left-width: 3px;
      border-radius: 3px;
      font-size: 10.5px;
      color: var(--fg);
    }
    .low {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--fg);
    }
    .state {
      margin: 0;
      font-size: 11.5px;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .state.busy::before {
      content: "";
      width: 10px;
      height: 10px;
      flex: none;
      border: 1.5px solid var(--line-strong);
      border-top-color: var(--fg);
      border-radius: 50%;
      animation: tt-spin 0.7s linear infinite;
    }
    .state.error::before {
      content: "!";
      flex: none;
      width: 12px;
      height: 12px;
      border: 1px solid var(--muted);
      border-radius: 50%;
      color: var(--muted);
      font: 700 8px/10px ui-monospace, monospace;
      text-align: center;
    }
    @keyframes tt-spin { to { transform: rotate(360deg); } }
    .foot {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 9px;
      border-top: 1px solid var(--line);
      font-size: 9.5px;
      color: var(--muted);
    }
    .conf { font-variant-numeric: tabular-nums; }
    .empty { margin: 0; font-size: 11px; color: var(--muted); }
  `;

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  try { shadow.adoptedStyleSheets = [sheet]; } catch (err) {
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
  }

  const card = document.createElement('div');
  card.className = 'card theme-dark';
  card.innerHTML = `
    <div class="bar">
      <span class="mark"></span>
      <span class="title">Tab Tools</span>
      <span class="chip"></span>
      <button class="x" type="button" title="Zamknij (Esc)">×</button>
    </div>
    <div class="body"></div>
    <div class="foot"><span class="conf"></span><span>Alt+Shift+2</span></div>
  `;
  shadow.appendChild(card);

  const body = card.querySelector('.body');
  const bar = card.querySelector('.bar');
  const chip = card.querySelector('.chip');
  const confLine = card.querySelector('.conf');
  const closeBtn = card.querySelector('.x');
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Brak odpowiedzi — Alt+Shift+1 (zrzut) lub Alt+Shift+4 (zaznaczenie).';

  const state = {
    hideDelay: 6000,
    thresholdWarn: 60,
    thresholdHide: 40,
    showOptions: false,
    data: null,
    visible: false,
    busy: false
  };

  let hideTimer = null;
  let drag = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  function ensureAttached() {
    if (host.isConnected) return;
    const parent = document.body || document.documentElement;
    if (parent) parent.appendChild(host);
  }

  function typeLabel(type) {
    if (type === 'single') return 'Jedna odpowiedź';
    if (type === 'multi') return 'Wielokrotny wybór';
    if (type === 'truefalse') return 'Prawda / Fałsz';
    if (type === 'numeric') return 'Wynik liczbowy';
    if (type === 'open') return 'Pytanie otwarte';
    if (type === 'match') return 'Połącz w pary';
    return 'Brak pytania';
  }

  function place(x, y) {
    const pad = 8;
    const rect = card.getBoundingClientRect();
    const w = rect.width || 292;
    const h = rect.height || 120;
    const maxX = Math.max(pad, window.innerWidth - w - pad);
    const maxY = Math.max(pad, window.innerHeight - h - pad);
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = Math.round(Math.min(Math.max(pad, x), maxX)) + 'px';
    host.style.top = Math.round(Math.min(Math.max(pad, y), maxY)) + 'px';
  }

  function open() {
    ensureAttached();
    state.visible = true;
    card.classList.add('open');
  }

  function close() {
    clearTimeout(hideTimer);
    state.visible = false;
    card.classList.remove('open');
  }

  function scheduleAutoHide() {
    clearTimeout(hideTimer);
    if (!state.hideDelay || state.hideDelay <= 0) return;
    hideTimer = setTimeout(() => close(), state.hideDelay);
  }

  function renderContent(data) {
    const warnAt = Number(state.thresholdWarn) || 60;
    const hideAt = Number(state.thresholdHide) || 40;

    if (data.question) body.appendChild(el('p', 'q', data.question));

    const score = Number(data.confidence) || 0;
    if (score > 0 && score < hideAt) {
      body.appendChild(el('p', 'low', 'Pewność ' + score + '% — niepewne, sprawdź sam.'));
      return;
    }
    if (score > 0 && score < warnAt) {
      body.appendChild(el('p', 'warnbar', 'Poniżej ' + warnAt + '% pewności — sprawdź odpowiedź.'));
    }

    if (data.taskType === 'match' && Array.isArray(data.pairs) && data.pairs.length) {
      const grid = el('div', 'pairs');
      data.pairs.forEach((pair) => {
        const row = el('div', 'pair');
        row.appendChild(el('span', 'col', pair.left));
        row.appendChild(el('span', 'dash', '-'));
        row.appendChild(el('span', 'col', pair.right));
        grid.appendChild(row);
      });
      body.appendChild(grid);
    } else if (data.taskType === 'open' || data.taskType === 'numeric' || data.taskType === 'truefalse') {
      const list = Array.isArray(data.answers) && data.answers.length
        ? data.answers.map((item) => (item.label ? item.label + '. ' : '') + item.text).join('; ')
        : '';
      body.appendChild(el('p', 'open', data.openAnswer || list || 'Model nie zwrócił treści odpowiedzi.'));
    } else if (Array.isArray(data.answers) && data.answers.length) {
      const list = el('div', 'list');
      data.answers.forEach((item, index) => {
        const row = el('div', 'row');
        row.appendChild(el('span', 'badge', (item.label || '').trim() || String.fromCharCode(65 + index)));
        row.appendChild(el('span', 'txt', item.text));
        list.appendChild(row);
      });
      body.appendChild(list);
    } else if (data.openAnswer) {
      body.appendChild(el('p', 'open', data.openAnswer));
    } else {
      body.appendChild(el('p', 'empty', 'Model nie zwrócił treści odpowiedzi.'));
    }

    if (state.showOptions && Array.isArray(data.options) && data.options.length) {
      const box = el('div', 'opts');
      data.options.forEach((option, index) => {
        const label = (option.label || '').trim() || String.fromCharCode(65 + index);
        box.appendChild(el('p', 'opt', label + '. ' + option.text));
      });
      body.appendChild(box);
    }

    if (data.notes) body.appendChild(el('p', 'notes', data.notes));
  }

  function render() {
    ensureAttached();
    body.replaceChildren();
    const data = state.data;
    chip.textContent = data ? typeLabel(data.taskType) : '';
    confLine.textContent = '';

    if (!data) {
      body.appendChild(empty);
      return;
    }
    renderContent(data);
    if (typeof data.confidence === 'number' && data.confidence > 0) {
      confLine.textContent = 'Pewność ' + data.confidence + '%';
    }
  }

  function showAnswer(data, options) {
    const opts = options || {};
    if (typeof opts.thresholdWarn === 'number') state.thresholdWarn = opts.thresholdWarn;
    if (typeof opts.thresholdHide === 'number') state.thresholdHide = opts.thresholdHide;
    if (typeof opts.showOptions === 'boolean') state.showOptions = opts.showOptions;

    state.data = data;
    state.busy = false;
    render();
    if (opts.silent) {
      clearTimeout(hideTimer);
      return;
    }
    open();
    if (opts.auto !== false) scheduleAutoHide();
  }

  function showState(text, options) {
    const opts = options || {};
    ensureAttached();
    state.busy = Boolean(opts.busy);
    chip.textContent = '';
    confLine.textContent = '';
    body.replaceChildren();
    body.appendChild(el('p', 'state' + (opts.error ? ' error' : '') + (opts.busy ? ' busy' : ''), text));
    open();
    clearTimeout(hideTimer);
    if (opts.error) hideTimer = setTimeout(() => close(), 10000);
    else if (!opts.busy) scheduleAutoHide();
  }

  function toggle() {
    clearTimeout(hideTimer);
    if (state.visible) {
      close();
      return;
    }
    if (!state.data && !state.busy) {
      showState('Brak odpowiedzi — Alt+Shift+1 (zrzut) lub Alt+Shift+4 (zaznaczenie)');
      return;
    }
    if (state.data) render();
    open();
    scheduleAutoHide();
  }

  function openNow(data) {
    if (data) state.data = data;
    state.busy = false;
    render();
    open();
    scheduleAutoHide();
  }

  function applySettings(settings) {
    if (!settings) return;
    if (settings.theme === 'light') card.classList.add('theme-light');
    else if (settings.theme === 'dark') card.classList.remove('theme-light');
    if (typeof settings.hideDelay === 'number') state.hideDelay = settings.hideDelay;
    if (typeof settings.thresholdWarn === 'number') state.thresholdWarn = settings.thresholdWarn;
    if (typeof settings.thresholdHide === 'number') state.thresholdHide = settings.thresholdHide;
    if (typeof settings.showOptions === 'boolean') state.showOptions = settings.showOptions;
    if (settings.pos && !drag) place(settings.pos.x, settings.pos.y);
    if (state.data && state.visible) render();
  }

  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });

  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', () => {
    if (state.visible && !state.busy) scheduleAutoHide();
  });

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target === closeBtn) return;
    const rect = card.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    try { bar.setPointerCapture(event.pointerId); } catch (err) { /* pomijamy */ }
    event.preventDefault();
  });

  bar.addEventListener('pointermove', (event) => {
    if (!drag) return;
    place(event.clientX - drag.dx, event.clientY - drag.dy);
  });

  bar.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    const rect = card.getBoundingClientRect();
    try {
      chrome.runtime.sendMessage({
        type: 'tt:savePos',
        pos: { x: Math.round(rect.left), y: Math.round(rect.top) }
      }, () => { void chrome.runtime.lastError; });
    } catch (err) { /* pomijamy */ }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.visible) {
      event.stopPropagation();
      close();
    }
  }, true);

  render();

  /* Port trzyma service worker przy życiu w trakcie łańcucha modeli. */
  function keepAlive() {
    try {
      const port = chrome.runtime.connect({ name: 'tt-ka' });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!chrome.runtime || !chrome.runtime.id) return;
        setTimeout(() => { if (chrome.runtime && chrome.runtime.id) keepAlive(); }, 2000);
      });
    } catch (err) { /* kontekst rozszerzenia wygasł */ }
  }
  keepAlive();

  function bindMessages() {
    if (W.__ttListener) {
      try { chrome.runtime.onMessage.removeListener(W.__ttListener); } catch (err) { /* pomijamy */ }
    }
    W.__ttListener = (msg, sender, sendResponse) => {
      const api = W.__ttApi;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'tt:ping') {
        sendResponse({ ok: true });
        return;
      }
      if (!api) return;

      if (msg.type === 'tt:settings') api.applySettings(msg.settings);
      else if (msg.type === 'tt:answer') {
        api.showAnswer(msg.data, {
          silent: msg.silent,
          thresholdWarn: msg.thresholdWarn,
          thresholdHide: msg.thresholdHide,
          showOptions: msg.showOptions
        });
      } else if (msg.type === 'tt:state') api.setState(msg.text, { error: msg.error, busy: msg.busy });
      else if (msg.type === 'tt:toggle') api.toggleVisible();
      else if (msg.type === 'tt:show') {
        api.showAnswer(msg.data, { thresholdWarn: msg.thresholdWarn, thresholdHide: msg.thresholdHide, showOptions: msg.showOptions });
      } else if (msg.type === 'tt:hide') api.hideForCapture();
      else if (msg.type === 'tt:restore') api.restoreAfterCapture();
      else if (msg.type === 'tt:close') api.close();
    };
    chrome.runtime.onMessage.addListener(W.__ttListener);
  }

  W.__ttHost = host;
  W.__ttApi = {
    setState: showState,
    showAnswer: showAnswer,
    toggleVisible: toggle,
    openNow: openNow,
    close: close,
    applySettings: applySettings,
    hideForCapture: () => { host.style.visibility = 'hidden'; },
    restoreAfterCapture: () => { host.style.visibility = ''; }
  };
  W.__ttBind = bindMessages;
  bindMessages();

  (document.documentElement || document.body).appendChild(host);
})();
