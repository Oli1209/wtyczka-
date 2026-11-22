'use strict';

const $ = (sel) => document.querySelector(sel);

const TYPE_LABEL = {
  single: 'Jedna odpowiedź',
  multi: 'Wielokrotny wybór',
  truefalse: 'Prawda / Fałsz',
  numeric: 'Wynik liczbowy',
  open: 'Pytanie otwarte',
  match: 'Połącz w pary',
  unknown: 'Brak pytania'
};

const PROVIDER_LABEL = { gemini: 'Gemini', openrouter: 'OpenRouter', groq: 'Groq' };

const ui = {
  settings: null,
  hasKey: { gemini: false, openrouter: false, groq: false },
  keyHints: { gemini: '', openrouter: '', groq: '' },
  models: []
};

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function provider() {
  const p = ui.settings && ui.settings.provider;
  return PROVIDER_LABEL[p] ? p : 'gemini';
}

function mode() {
  return ui.settings && ui.settings.mode === 'manual' ? 'manual' : 'auto';
}

/* ---------- motyw ---------- */

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const btn = $('#btnTheme');
  if (!btn) return;
  btn.textContent = light ? '☾' : '☀';
  btn.title = light ? 'Motyw ciemny' : 'Motyw jasny';
  btn.setAttribute('aria-label', btn.title);
}

/* ---------- widoki ---------- */

function syncChoices() {
  const p = provider();
  document.querySelectorAll('#providerSeg button').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.provider === p));
  });
  document.querySelectorAll('#modeSeg button').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode()));
  });
  $('#keyLabel').textContent = 'Klucz ' + PROVIDER_LABEL[p];
  $('#keyHint').textContent = ui.keyHints[p] ? 'Zapisany klucz: ••••' + ui.keyHints[p] : 'Brak zapisanego klucza';
  $('#stateLine').textContent = 'Tryb ' + mode() + ' · ' + PROVIDER_LABEL[p] + ' · ' + (ui.hasKey[p] ? 'klucz OK' : 'brak klucza');
  $('#btnDelKey').disabled = !ui.hasKey[p];
  $('#btnDelKey').style.opacity = ui.hasKey[p] ? '1' : '.5';
}

function syncFields() {
  $('#chkStatus').checked = ui.settings.showStatus !== false;
  $('#chkOptions').checked = ui.settings.showOptions === true;
  $('#chkBadge').checked = ui.settings.badge === true;
  $('#numWarn').value = String(ui.settings.thresholdWarn == null ? 60 : ui.settings.thresholdWarn);
  $('#numHide').value = String(ui.settings.thresholdHide == null ? 40 : ui.settings.thresholdHide);
  const seconds = (Number(ui.settings.hideDelay) || 0) / 1000;
  $('#numDelay').value = String(Math.round(seconds * 10) / 10);
}

function fillModels(models, selected) {
  const select = $('#selModel');
  const current = selected || 'auto';
  const list = Array.isArray(models) ? models.slice() : [];

  select.replaceChildren();
  select.add(new Option('Automatyczny', 'auto'));
  list.forEach((id) => select.add(new Option(id, id)));

  if (current !== 'auto' && list.indexOf(current) === -1) {
    const option = new Option(current + ' (niedostępny)', current);
    option.disabled = true;
    select.add(option);
    // Nie zapisujemy niedostępnego modelu jako wybranego.
    select.value = 'auto';
    return;
  }
  select.value = current;
}

function renderLast(last) {
  const box = $('#lastBox');
  if (!last || !last.text) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#lastType').textContent = TYPE_LABEL[last.type] || 'Odpowiedź';
  $('#lastConf').textContent = last.confidence ? last.confidence + '%' : '';
  $('#lastText').textContent = last.text;
}

function renderError(error) {
  const box = $('#opError');
  if (!error || !error.message) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#errText').textContent = error.message;
}

function renderCache(size) {
  const el = $('#cacheInfo');
  if (!el) return;
  el.textContent = 'W cache: ' + (Number(size) || 0);
}

function showFatal(message) {
  renderError({ message: message });
  $('#stateLine').textContent = message;
  $('#lastBox').hidden = true;
}

function timeLabel(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const time = date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return date.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

function renderHistory(list) {
  const box = $('#histList');
  box.replaceChildren();
  $('#histCount').textContent = String(list.length);

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Brak historii.';
    box.appendChild(empty);
    return;
  }

  list.slice(0, 30).forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'hist-item';
    item.title = 'Pokaż w panelu';
    item.addEventListener('click', async () => {
      await send({ type: 'tt:show', entry: entry });
      window.close();
    });

    const answer = document.createElement('div');
    answer.className = 'a';
    answer.textContent = entry.text || '(brak treści)';
    item.appendChild(answer);

    if (entry.question) {
      const question = document.createElement('div');
      question.className = 'q';
      question.textContent = entry.question;
      item.appendChild(question);
    }

    const meta = document.createElement('div');
    meta.className = 'm';
    const type = document.createElement('span');
    type.textContent = TYPE_LABEL[entry.type] || TYPE_LABEL.unknown;
    const confidence = document.createElement('span');
    confidence.textContent = entry.confidence ? entry.confidence + '%' : '';
    const time = document.createElement('span');
    time.textContent = timeLabel(entry.at);
    const source = document.createElement('span');
    source.textContent = entry.source === 'selection' ? 'zaznaczenie' : 'zrzut';
    meta.append(type, confidence, time, source);
    item.appendChild(meta);

    box.appendChild(item);
  });
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  });
  ['actions', 'settings', 'history'].forEach((key) => {
    $('#panel-' + key).hidden = key !== name;
  });
  if (name === 'settings' && !ui.models.length) loadModels();
}

/* ---------- dane ---------- */

async function loadModels() {
  if (!ui.settings) return;
  const res = await send({ type: 'tt:listModels', provider: provider(), key: null });
  if (!res || !res.ok) return;
  ui.models = res.models || [];
  fillModels(ui.models, ui.settings.models[provider()]);
}

async function init() {
  const state = await send({ type: 'tt:getState' });
  if (!state) {
    showFatal('Brak połączenia z tłem rozszerzenia');
    return;
  }
  if (state.ok === false) {
    showFatal(state.error || 'Tło rozszerzenia zwróciło błąd');
    return;
  }
  if (!state.settings) {
    showFatal('Brak ustawień — otwórz rozszerzenie ponownie');
    return;
  }

  ui.settings = state.settings;
  ui.hasKey = state.hasKey || ui.hasKey;
  ui.keyHints = state.keyHints || ui.keyHints;

  applyTheme(ui.settings.theme);
  syncChoices();
  syncFields();
  fillModels([], ui.settings.models[provider()]);
  renderLast(state.lastAnswer);
  renderError(state.lastError);
  renderHistory(state.history || []);
  renderCache(state.cacheSize);
  loadModels();
}

async function patchNow(patch) {
  const res = await send({ type: 'tt:save', patch: patch });
  if (!res || !res.ok) {
    renderError({ message: (res && res.error) || 'Nie udało się zapisać' });
    return false;
  }
  ui.settings = res.settings;
  ui.hasKey = res.hasKey || ui.hasKey;
  ui.keyHints = res.keyHints || ui.keyHints;
  syncChoices();
  return true;
}

/* ---------- obsługa ---------- */

let clearArmed = false;
let clearTimer = null;

function disarmClear() {
  clearArmed = false;
  clearTimeout(clearTimer);
  $('#btnClear').textContent = 'Wyczyść historię';
}

function flashSave(ok, message) {
  const info = $('#saveInfo');
  info.textContent = message;
  info.dataset.state = ok ? 'ok' : 'bad';
  setTimeout(() => {
    if (info.textContent === message) {
      info.textContent = '';
      delete info.dataset.state;
    }
  }, 4000);
}

async function saveTypedKey() {
  const input = $('#txtKey');
  const value = input.value.trim();
  if (!value) return false;

  const p = provider();
  const res = await send({ type: 'tt:save', patch: {}, keys: { [p]: value } });
  if (!res || !res.ok) {
    flashSave(false, (res && res.error) || 'Nie udało się zapisać klucza');
    return false;
  }

  ui.settings = res.settings;
  ui.hasKey = res.hasKey || ui.hasKey;
  ui.keyHints = res.keyHints || ui.keyHints;
  input.value = '';
  syncChoices();
  flashSave(true, 'Klucz zapisany');
  return true;
}

$('#btnTheme').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await patchNow({ theme: next });
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

$('#stateLine').addEventListener('click', () => selectTab('settings'));

$('#btnErrClose').addEventListener('click', async () => {
  renderError(null);
  await send({ type: 'tt:clearError' });
});

$('#lastBox').addEventListener('click', async () => {
  await send({ type: 'tt:show' });
  window.close();
});

$('#btnCap').addEventListener('click', async () => {
  await send({ type: 'tt:capture' });
  window.close();
});

$('#btnRep').addEventListener('click', async () => {
  await send({ type: 'tt:repeat' });
  window.close();
});

$('#btnSel').addEventListener('click', async () => {
  await send({ type: 'tt:select' });
  window.close();
});

document.querySelectorAll('#providerSeg button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.provider === provider()) return;
    $('#txtKey').value = '';
    $('#testOut').textContent = '';
    delete $('#testOut').dataset.state;
    ui.models = [];
    if (!(await patchNow({ provider: btn.dataset.provider }))) return;
    fillModels([], ui.settings.models[provider()]);
    loadModels();
  });
});

document.querySelectorAll('#modeSeg button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.mode === mode()) return;
    await patchNow({ mode: btn.dataset.mode });
  });
});

$('#btnPeek').addEventListener('click', () => {
  const input = $('#txtKey');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  $('#btnPeek').textContent = reveal ? 'Ukryj' : 'Pokaż';
});

// Klucz zapisuje się też bez przycisku Zapisz: po opuszczeniu pola i po zmianie wartości.
$('#txtKey').addEventListener('change', () => { saveTypedKey(); });
$('#txtKey').addEventListener('blur', () => { saveTypedKey(); });

$('#btnDelKey').addEventListener('click', async () => {
  const p = provider();
  const res = await send({ type: 'tt:save', patch: {}, clearKeys: { [p]: true } });
  if (!res || !res.ok) {
    flashSave(false, (res && res.error) || 'Nie udało się usunąć klucza');
    return;
  }
  ui.settings = res.settings;
  ui.hasKey = res.hasKey || { gemini: false, openrouter: false, groq: false };
  ui.keyHints = res.keyHints || { gemini: '', openrouter: '', groq: '' };
  syncChoices();
  $('#testOut').textContent = 'Klucz usunięty';
  $('#testOut').dataset.state = 'bad';
  flashSave(true, 'Klucz usunięty');
});

$('#btnTest').addEventListener('click', async () => {
  const out = $('#testOut');
  out.textContent = 'Sprawdzam…';
  delete out.dataset.state;

  const res = await send({ type: 'tt:testKey', provider: provider(), key: $('#txtKey').value.trim() || null });
  if (!res) {
    out.textContent = 'Brak odpowiedzi z tła';
    out.dataset.state = 'bad';
    return;
  }
  if (res.ok) {
    out.textContent = res.message;
    out.dataset.state = 'ok';
    if (Array.isArray(res.models) && res.models.length) {
      ui.models = res.models;
      fillModels(ui.models, ui.settings.models[provider()]);
    }
  } else {
    out.textContent = res.error || 'Test nieudany';
    out.dataset.state = 'bad';
  }
});

$('#btnSave').addEventListener('click', async () => {
  const seconds = Math.min(30, Math.max(0, parseFloat($('#numDelay').value || '0')));
  const p = provider();

  const warn = Math.min(100, Math.max(0, parseInt($('#numWarn').value || '60', 10)));
  let hide = Math.min(100, Math.max(0, parseInt($('#numHide').value || '40', 10)));
  if (hide > warn) hide = warn;

  const patch = {
    showStatus: $('#chkStatus').checked,
    showOptions: $('#chkOptions').checked,
    badge: $('#chkBadge').checked,
    thresholdWarn: warn,
    thresholdHide: hide,
    hideDelay: Math.round(seconds * 1000),
    models: Object.assign({}, ui.settings.models, { [p]: $('#selModel').value || 'auto' })
  };

  const typed = $('#txtKey').value.trim();
  const keys = typed ? { [p]: typed } : {};

  const res = await send({ type: 'tt:save', patch: patch, keys: keys });
  if (!res || !res.ok) {
    flashSave(false, (res && res.error) || 'Nie udało się zapisać');
    return;
  }

  ui.settings = res.settings;
  ui.hasKey = res.hasKey || ui.hasKey;
  ui.keyHints = res.keyHints || ui.keyHints;

  $('#txtKey').value = '';
  $('#numHide').value = String(res.settings.thresholdHide);
  syncChoices();
  flashSave(true, 'Zapisano');
});

$('#btnClear').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    $('#btnClear').textContent = 'Kliknij ponownie';
    clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  await send({ type: 'tt:clearHistory' });
  renderHistory([]);
});

window.addEventListener('keydown', (event) => {
  if (event.altKey && event.shiftKey) {
    if (event.code === 'Digit3') {
      event.preventDefault();
      send({ type: 'tt:toggleMode' });
      return;
    }
    const action = { Digit1: 'tt:capture', Digit2: 'tt:repeat', Digit4: 'tt:select' }[event.code];
    if (action) {
      event.preventDefault();
      send({ type: action });
      window.close();
      return;
    }
  }
  if (event.key === 'Escape') window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !ui.settings) return;
  if (changes.settings) {
    const next = changes.settings.newValue || {};
    ui.settings = Object.assign({}, ui.settings, next, {
      models: Object.assign({}, ui.settings.models, next.models || {})
    });
    applyTheme(ui.settings.theme);
    syncChoices();
    if (next.mode) syncChoices();
  }
});

init();
