'use strict';

/* Tab Tools — service worker (MV3) */

const DEFAULTS = {
  provider: 'gemini',                       // 'gemini' | 'openrouter' | 'groq'
  theme: 'dark',
  mode: 'auto',                             // 'auto' | 'manual'
  showStatus: true,                         // komunikaty pośrednie
  showOptions: false,                       // pełna lista opcji w panelu
  badge: false,                             // mignięcie ikony przy błędzie
  hideDelay: 6000,                          // 0 = panel zostaje do zamknięcia
  thresholdWarn: 60,                        // poniżej: pasek ostrzeżenia
  thresholdHide: 40,                        // poniżej: bez treści odpowiedzi
  models: { gemini: 'auto', openrouter: 'auto', groq: 'auto' },
  pos: null,
  timeoutMs: 20000,
  maxImageWidth: 1600
};

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/';
const OPENROUTER_ROOT = 'https://openrouter.ai/api/v1/';
const GROQ_ROOT = 'https://api.groq.com/openai/v1/';

const KEY_FIELD = { gemini: 'tt_api_key', openrouter: 'tt_or_key', groq: 'tt_groq_key' };
const PROVIDER_LABEL = { gemini: 'Gemini', openrouter: 'OpenRouter', groq: 'Groq' };
const PROVIDERS = Object.keys(KEY_FIELD);

const GEMINI_HINTS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const OPENROUTER_HINTS = ['google/gemini-2.5-flash', 'google/gemma-4-31b-it:free', 'openrouter/free'];
// Groq: tylko modele z wizją nadają się na zrzut ekranu (llama-4 wycofane).
const GROQ_HINTS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const GROQ_IMAGE_HINTS = ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'];
const GROQ_VISION = ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'meta-models/muse-spark-open'];
// qwen3.8 domyślnie myśli i zjada tym cały budżet odpowiedzi — na zrzut chcemy tryb instruct.
const GROQ_BUDGET = 4096;

const ITEM = {
  type: 'OBJECT',
  properties: {
    label: { type: 'STRING' },
    text: { type: 'STRING' },
    confidence: { type: 'NUMBER' }
  },
  required: ['text']
};

const SCHEMA_ANSWER = {
  type: 'OBJECT',
  properties: {
    taskType: { type: 'STRING', enum: ['single', 'multi', 'truefalse', 'numeric', 'open', 'match', 'unknown'] },
    question: { type: 'STRING' },
    options: { type: 'ARRAY', items: ITEM },
    answers: { type: 'ARRAY', items: ITEM },
    pairs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { left: { type: 'STRING' }, right: { type: 'STRING' } },
        required: ['left', 'right']
      }
    },
    openAnswer: { type: 'STRING' },
    notes: { type: 'STRING' },
    confidence: { type: 'NUMBER' }
  },
  required: ['taskType', 'question', 'answers', 'confidence']
};

const RULES = [
  'Odpowiadaj w języku pytania.',
  'question: przepisz pytanie dokładnie tak, jak brzmi w materiale.',
  'options: wszystkie widoczne warianty odpowiedzi (label to litera lub numer, text to pełna treść).',
  'answers: wyłącznie warianty, które są poprawne. Nic więcej.',
  'single — dokładnie jeden element w answers, pozostałe warianty wyłącznie w options.',
  'multi — wszystkie poprawne warianty w answers.',
  'truefalse — taskType "truefalse", openAnswer dokładnie "Prawda" albo "Fałsz", answers puste.',
  'numeric — taskType "numeric", openAnswer tylko wynik z jednostką, bez obliczeń, answers puste.',
  'open — taskType "open", openAnswer 1-2 zdania, bez liter opcji, answers puste.',
  'match — taskType "match", pary w pairs jako {left, right}, answers puste.',
  'Przy open, numeric, truefalse i match answers MUSI być pustą tablicą.',
  'Przed odpowiedzią sprawdź, czy wybrany wariant naprawdę rozwiązuje pytanie. Nie zgaduj: przy niepewności obniż confidence.',
  'notes — najwyżej 200 znaków, tylko uwagi (np. numery pominiętych pytań), inaczej "".',
  'Pytanie nieczytelne albo przycięte: taskType "unknown", answers [], openAnswer "", confidence 0.',
  'Bez długiego myślnika i bez półpauzy. Zwykły dywiz tylko przy wyliczeniu.',
  'confidence to szczera pewność 0-100.'
].join('\n');

const IMAGE_EXTRA = 'Rozwiąż tylko pytanie w całości widoczne na obrazie. Pytania przycięte u góry albo u dołu pomiń i wypisz ich numery w notes. Jeśli dołączono tekst strony, użyj go do sprawdzenia brzmienia pytania i wariantów.';

const SYS_IMAGE = 'Rozwiązujesz zadanie widoczne na zrzucie ekranu. Patrz tylko na treść zadania, pomiń interfejs przeglądarki. Zwróć wyłącznie JSON zgodny ze schematem.\n' + IMAGE_EXTRA + '\n' + RULES;
const SYS_TEXT = 'Rozwiązujesz zadanie z tekstu przekazanego przez użytkownika. Zwróć wyłącznie JSON zgodny ze schematem.\n' + RULES;
const USER_IMAGE = 'Odczytaj pytanie ze zrzutu i podaj poprawną odpowiedź.';
const RETRY_EMPTY = '\n\nPoprzednia odpowiedź była pusta. Odczytaj pytanie i wypełnij question oraz answers albo openAnswer.';

const PDF_VIEWER = /mhjfbmdgcfjbbpaeojofohoefgiehjai/i;

let lastAnswer = null;
let lastAnswerLoaded = false;
let lastCaptureAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (err) => (err && err.message ? err.message : String(err || 'Nieznany błąd'));

/* ---------- ustawienia ---------- */

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function sanitize(s) {
  s.mode = s.mode === 'manual' ? 'manual' : 'auto';
  s.provider = PROVIDERS.indexOf(s.provider) !== -1 ? s.provider : 'gemini';
  s.theme = s.theme === 'light' ? 'light' : 'dark';
  s.showStatus = s.showStatus !== false;
  s.showOptions = s.showOptions === true;
  s.badge = s.badge === true;
  s.hideDelay = clampNum(s.hideDelay, 0, 30000, DEFAULTS.hideDelay);
  s.thresholdWarn = clampNum(s.thresholdWarn, 0, 100, DEFAULTS.thresholdWarn);
  s.thresholdHide = clampNum(s.thresholdHide, 0, 100, DEFAULTS.thresholdHide);
  s.maxImageWidth = clampNum(s.maxImageWidth, 480, 2400, DEFAULTS.maxImageWidth);
  s.timeoutMs = clampNum(s.timeoutMs, 6000, 60000, DEFAULTS.timeoutMs);
  return s;
}

async function getSettings() {
  const box = await chrome.storage.local.get('settings');
  const raw = box.settings || {};
  const s = sanitize(Object.assign({}, DEFAULTS, raw));
  s.models = Object.assign({}, DEFAULTS.models, raw.models || {});

  if (!raw.models && typeof raw.model === 'string') s.models.gemini = raw.model;
  if (!raw.mode && typeof raw.autoShow === 'boolean') s.mode = raw.autoShow ? 'auto' : 'manual';
  return s;
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch || {});
  if (patch && patch.models) next.models = Object.assign({}, current.models, patch.models);
  sanitize(next);
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getKey(provider) {
  const name = KEY_FIELD[provider] ? provider : 'gemini';
  const box = await chrome.storage.local.get([KEY_FIELD[name], 'settings']);
  const direct = String(box[KEY_FIELD[name]] || '').trim();
  if (direct) return direct;
  if (name === 'gemini' && box.settings && box.settings.geminiKey) {
    return String(box.settings.geminiKey || '').trim();
  }
  return '';
}

async function keyState() {
  const keys = {};
  await Promise.all(PROVIDERS.map(async (p) => { keys[p] = await getKey(p); }));

  const hasKey = {};
  const keyHints = {};
  PROVIDERS.forEach((p) => {
    hasKey[p] = Boolean(keys[p]);
    keyHints[p] = keys[p] ? keys[p].slice(-4) : '';
  });
  return { hasKey: hasKey, keyHints: keyHints };
}

/* ---------- błędy ---------- */

function httpError(provider, status, detail) {
  const extra = detail ? ' — ' + String(detail).slice(0, 150) : '';
  if (provider === 'groq') {
    if (status === 401 || status === 403) return 'Klucz Groq odrzucony' + extra;
    if (status === 404) return 'Model niedostępny w Groq (404)' + extra;
    if (status === 413) return 'Obraz za duży dla Groq' + extra;
    if (status === 429) return 'Limit zapytań Groq (429) — darmowy plan ma niski limit na minutę' + extra;
    if (status >= 500) return 'Błąd serwera Groq (HTTP ' + status + ')' + extra;
    return 'Groq: błąd HTTP ' + status + extra;
  }
  if (provider === 'openrouter') {
    if (status === 401 || status === 403) return 'Klucz OpenRouter odrzucony' + extra;
    if (status === 402) return 'Brak środków na koncie OpenRouter' + extra;
    if (status === 404) return 'Model niedostępny w OpenRouter (404)' + extra;
    if (status === 429) return 'Limit zapytań OpenRouter (429)' + extra;
    if (status >= 500) return 'Błąd serwera OpenRouter (HTTP ' + status + ')' + extra;
    return 'OpenRouter: błąd HTTP ' + status + extra;
  }
  if (status === 400 || status === 401 || status === 403) return 'Klucz Gemini odrzucony' + extra;
  if (status === 404) return 'Model niedostępny w Gemini (404)' + extra;
  if (status === 429) return 'Limit zapytań Gemini (429) — darmowy plan ma ograniczenie na minutę' + extra;
  if (status >= 500) return 'Błąd serwera Gemini (HTTP ' + status + ')' + extra;
  return 'Gemini: błąd HTTP ' + status + extra;
}

async function requestJson(url, options) {
  const opts = options || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULTS.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Serwer nie odpowiedział w czasie');
    const text = msgOf(err);
    if (err && err.name === 'TypeError') throw new Error('Brak połączenia — sprawdź internet lub blokadę CORS');
    if (/network|failed to fetch|load failed|aborted/i.test(text)) {
      throw new Error('Połączenie przerwane — sprawdź internet');
    }
    throw new Error('Błąd połączenia: ' + text.slice(0, 120));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- styl ---------- */

const STYLE_WORDS = [
  ['warto zauważyć', 'zwróć uwagę'],
  ['podsumowując', 'krótko'],
  ['ponadto', 'do tego'],
  ['kluczowy', 'główny'],
  ['kluczowa', 'główna'],
  ['kluczowe', 'główne'],
  ['istotny', 'ważny'],
  ['istotna', 'ważna'],
  ['istotne', 'ważne'],
  ['kompleksowy', 'pełny'],
  ['kompleksowa', 'pełna'],
  ['kompleksowe', 'pełne'],
  ['umożliwia', 'pozwala'],
  ['niemniej', 'ale'],
  ['jednakże', 'ale'],
  ['dodatkowo', 'też'],
  ['stanowi', 'to']
];

function keepCase(replacement, sample) {
  if (!sample) return replacement;
  const upper = sample[0] === sample[0].toUpperCase();
  return upper ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

/* \b nie działa po polskich znakach, bo ć i ą nie są znakami słowa w JS. */
const WORD_EDGE = 'a-ząćęłńóśźż';

function styleRegex(phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^' + WORD_EDGE + '])' + escaped + '(?![' + WORD_EDGE + '])', 'gi');
}

function enforceStyle(text) {
  let t = String(text == null ? '' : text);
  if (!t) return '';
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/,\s*([,.!?;:])/g, '$1');
  t = t.replace(/[—–]/g, '-');
  STYLE_WORDS.forEach((pair) => {
    t = t.replace(styleRegex(pair[0]), (m, before) => {
      const prefix = before || '';
      return prefix + keepCase(pair[1], m.slice(prefix.length));
    });
  });
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
  return t;
}

/* ---------- Gemini ---------- */

let geminiCache = { key: '', at: 0, ids: [] };

async function geminiModels(key) {
  if (geminiCache.key === key && Date.now() - geminiCache.at < 5 * 60 * 1000) return geminiCache.ids;

  // Service worker bywa usypiany, więc lista modeli leży też w pamięci sesji.
  const stamp = hashStr(key).slice(0, 12);
  try {
    const box = await chrome.storage.session.get('gemini_models');
    const saved = box && box.gemini_models;
    if (saved && saved.stamp === stamp && Array.isArray(saved.ids) && saved.ids.length
      && Date.now() - saved.at < 60 * 60 * 1000) {
      geminiCache = { key: key, at: saved.at, ids: saved.ids };
      return saved.ids;
    }
  } catch (err) { /* brak session storage — pomijamy */ }

  const ids = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const path = 'models?pageSize=200' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = await requestJson(GEMINI_ROOT + path, {
      headers: { 'x-goog-api-key': key },
      timeoutMs: 12000
    });
    if (!r.ok) {
      const detail = r.json && r.json.error && r.json.error.message;
      throw new Error(httpError('gemini', r.status, detail));
    }
    const models = (r.json && r.json.models) || [];
    for (const m of models) {
      const name = String(m.name || '').replace(/^models\//, '');
      const methods = m.supportedGenerationMethods || [];
      if (name && methods.indexOf('generateContent') !== -1) ids.push(name);
    }
    pageToken = (r.json && r.json.nextPageToken) || '';
    if (!pageToken) break;
  }
  geminiCache = { key, at: Date.now(), ids };
  try {
    await chrome.storage.session.set({ gemini_models: { stamp: stamp, at: geminiCache.at, ids: ids } });
  } catch (err) { /* pomijamy */ }
  return ids;
}

function scoreGemini(id) {
  let score = 0;
  if (/flash/i.test(id)) score += 40;
  if (/3\.8|3\.6/.test(id)) score += 24;
  else if (/2\.5/.test(id)) score += 18;
  else if (/2\.0/.test(id)) score += 10;
  if (/lite/i.test(id)) score -= 10;
  if (/preview|experimental/i.test(id)) score -= 8;
  const hint = GEMINI_HINTS.indexOf(id);
  if (hint >= 0) score += 60 - hint * 5;
  return score;
}

const UNSUITABLE_MODEL = /(image|tts|audio|embedding|aqa|live|veo|imagen|robotics|computer-use)/i;

function rankGemini(ids) {
  return ids
    .filter((id) => !UNSUITABLE_MODEL.test(id))
    .sort((a, b) => scoreGemini(b) - scoreGemini(a));
}

function geminiBody(system, userText, img, schema, maxTokens, thinkingOff) {
  const parts = [];
  if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
  parts.push({ text: userText });

  const generationConfig = {
    temperature: 0,
    maxOutputTokens: maxTokens || 4096,
    responseMimeType: 'application/json'
  };
  if (schema) generationConfig.responseSchema = schema;
  if (thinkingOff) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: generationConfig
  };
}

/* Myślenie wyłączamy tylko tam, gdzie model to przyjmuje: pro odrzuca 0. */
function geminiQuickModel(model) {
  return /flash/i.test(model) && !/pro/i.test(model);
}

/* Jedno zapytanie do Gemini. Powtórka tylko wtedy, gdy model odrzuci parametr
   albo utnie JSON na limicie tokenów — bez kaskady wariantów. */
async function geminiOnce(key, model, settings, system, userText, img, schema) {
  let thinkingOff = geminiQuickModel(model);
  let useSchema = Boolean(schema);
  let budget = 4096;
  let lastErr = null;

  for (let round = 0; round < 3; round++) {
    const r = await requestJson(GEMINI_ROOT + 'models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: geminiBody(system, userText, img, useSchema ? schema : null, budget, thinkingOff),
      timeoutMs: imageTimeout(img, settings)
    });

    if (!r.ok) {
      const detail = String((r.json && r.json.error && r.json.error.message) || '');
      const err = new Error(httpError('gemini', r.status, detail));
      err.status = r.status;
      if (r.status === 429) err.kind = 'quota';
      else if (r.status === 404) err.kind = 'model';
      else if (r.status === 413) err.kind = 'image';
      else if (r.status >= 500) err.kind = 'server';
      else if (r.status === 401 || r.status === 403) err.kind = 'key';
      else if (/api[ _-]?key.*(invalid|not valid)|invalid argument/i.test(detail)) err.kind = 'key';

      if (r.status === 400 && thinkingOff && /think/i.test(detail)) {
        thinkingOff = false;
        lastErr = err;
        continue;
      }
      if (r.status === 400 && useSchema && /schema|response_?mime|response format/i.test(detail)) {
        useSchema = false;
        lastErr = err;
        continue;
      }
      if (r.status >= 500 && round === 0) {
        lastErr = err;
        await sleep(250);
        continue;
      }
      throw err;
    }

    const candidate = ((r.json && r.json.candidates) || [])[0] || {};
    const finish = String(candidate.finishReason || '');
    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts
      .filter((p) => p && p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    if (text) return text;

    const blockReason = r.json && r.json.promptFeedback && r.json.promptFeedback.blockReason;
    if (blockReason) throw blockedError(String(blockReason));
    if (/^(SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKED)$/.test(finish)) throw blockedError(finish);

    if (finish === 'MAX_TOKENS') {
      // JSON nie zmieścił się w limicie: ten sam model dostaje większy budżet.
      budget = 8192;
      lastErr = new Error('Odpowiedź ucięta na limicie tokenów');
      continue;
    }

    const empty = new Error(finish ? 'Model nie zwrócił treści (' + finish + ')' : 'Model nie zwrócił odpowiedzi');
    empty.kind = 'empty';
    throw empty;
  }

  throw lastErr || new Error('Gemini nie zwrócił odpowiedzi');
}
/* ---------- OpenRouter ---------- */

let openrouterCache = { at: 0, models: [] };

async function openrouterModels() {
  if (openrouterCache.models.length && Date.now() - openrouterCache.at < 10 * 60 * 1000) {
    return openrouterCache.models;
  }
  const r = await requestJson(OPENROUTER_ROOT + 'models', {
    headers: { accept: 'application/json' },
    timeoutMs: 15000
  });
  if (!r.ok) throw new Error('Lista modeli OpenRouter: HTTP ' + r.status);

  const list = (r.json && r.json.data) || [];
  openrouterCache = {
    at: Date.now(),
    models: list
      .map((m) => ({
        id: String(m.id || ''),
        vision: (((m.architecture || {}).input_modalities) || []).indexOf('image') !== -1
      }))
      .filter((m) => m.id)
  };
  return openrouterCache.models;
}

async function openrouterOnce(key, model, settings, system, userText, img, withJsonMode) {
  const content = [];
  if (img) content.push({ type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.b64 } });
  content.push({ type: 'text', text: userText });

  const body = {
    model: model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: img ? content : userText }
    ],
    temperature: 0,
    max_tokens: 4096
  };
  if (withJsonMode) body.response_format = { type: 'json_object' };

  const r = await requestJson(OPENROUTER_ROOT + 'chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'x-title': 'Tab Tools'
    },
    body: body,
    timeoutMs: imageTimeout(img, settings)
  });

  if (!r.ok) {
    const detail = String((r.json && r.json.error && r.json.error.message) || '');
    const err = new Error(httpError('openrouter', r.status, detail));
    err.status = r.status;
    if (r.status === 401 || r.status === 403 || r.status === 402) err.kind = 'key';
    else if (r.status === 429) err.kind = 'quota';
    else if (r.status === 404) err.kind = 'model';
    else if (r.status === 413) err.kind = 'image';
    else if (r.status >= 500) err.kind = 'server';
    err.retryWithoutJson = r.status === 400 && /response_format|json/i.test(detail);
    throw err;
  }

  const choice = ((r.json && r.json.choices) || [])[0] || {};
  const message = choice.message || {};
  const raw = message.content;
  let text = '';
  if (typeof raw === 'string') text = raw.trim();
  else if (Array.isArray(raw)) {
    text = raw.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
  }
  if (!text) {
    const finish = String(choice.finish_reason || '');
    if (finish === 'content_filter') throw blockedError('content_filter');
    const err = new Error(finish ? 'Model nie zwrócił treści (' + finish + ')' : 'Model nie zwrócił odpowiedzi');
    err.kind = 'empty';
    throw err;
  }
  return text;
}
/* ---------- Groq ---------- */

let groqCache = { at: 0, models: [] };

async function groqModels(key) {
  if (groqCache.models.length && Date.now() - groqCache.at < 10 * 60 * 1000) return groqCache.models;

  try {
    const box = await chrome.storage.session.get('groq_models');
    const saved = box && box.groq_models;
    if (saved && Array.isArray(saved.ids) && saved.ids.length && Date.now() - saved.at < 60 * 60 * 1000) {
      groqCache = { at: saved.at, models: saved.ids };
      return saved.ids;
    }
  } catch (err) { /* brak session storage — pomijamy */ }

  const r = await requestJson(GROQ_ROOT + 'models', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    timeoutMs: 12000
  });
  if (!r.ok) throw new Error(httpError('groq', r.status, r.json && r.json.error && r.json.error.message));

  const ids = ((r.json && r.json.data) || []).map((m) => String(m.id || '')).filter(Boolean);
  groqCache = { at: Date.now(), models: ids };
  try {
    await chrome.storage.session.set({ groq_models: { at: groqCache.at, ids: ids } });
  } catch (err) { /* pomijamy */ }
  return ids;
}

async function groqOnce(key, model, settings, system, userText, img, opt) {
  const opts = opt || {};
  const content = [];
  if (img) content.push({ type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.b64 } });
  content.push({ type: 'text', text: userText });

  const body = {
    model: model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: content }
    ],
    temperature: 0.1,
    max_completion_tokens: opts.budget || GROQ_BUDGET
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // Tryb instruct: bez tego model myśli i ucina JSON na limicie tokenów.
  if (opts.effort) body.reasoning_effort = opts.effort;

  const r = await requestJson(GROQ_ROOT + 'chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'x-title': 'Tab Tools'
    },
    body: body,
    timeoutMs: imageTimeout(img, settings)
  });

  if (!r.ok) {
    const detail = String((r.json && r.json.error && r.json.error.message) || '');
    const err = new Error(httpError('groq', r.status, detail));
    err.status = r.status;
    if (r.status === 401 || r.status === 403) err.kind = 'key';
    else if (r.status === 429) err.kind = 'quota';
    else if (r.status === 404) err.kind = 'model';
    else if (r.status === 413) err.kind = 'image';
    else if (r.status >= 500) err.kind = 'server';
    // Parametr nieznany dla tego modelu: kolejna próba bez niego.
    if (r.status === 400 && /reasoning/i.test(detail)) err.badParam = 'effort';
    else if (r.status === 400 && /response_format|json/i.test(detail)) err.badParam = 'json';
    throw err;
  }

  const choice = ((r.json && r.json.choices) || [])[0] || {};
  const message = choice.message || {};
  const raw = message.content;
  let text = '';
  if (typeof raw === 'string') text = raw.trim();
  else if (Array.isArray(raw)) {
    text = raw.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
  }
  if (!text) {
    const finish = String(choice.finish_reason || '');
    if (finish === 'content_filter') throw blockedError('content_filter');
    const err = new Error(finish ? 'Model nie zwrócił treści (' + finish + ')' : 'Model nie zwrócił odpowiedzi');
    // Ucięte na limicie: warto spróbować z większym budżetem.
    if (finish === 'length' || !finish) err.lengthCut = true;
    throw err;
  }
  return text;
}

/* ---------- wspólne ---------- */

// Ostatnio działający model, żeby kolejne zrzuty nie traciły round tripów na modele, których nie ma.
const workedModel = { gemini: '', openrouter: '', groq: '' };
let workedLoaded = false;

async function loadWorked() {
  if (workedLoaded) return;
  workedLoaded = true;
  try {
    const box = await chrome.storage.session.get('worked_models');
    const saved = box && box.worked_models;
    if (!saved) return;
    Object.keys(workedModel).forEach((p) => {
      const item = saved[p];
      if (item && item.id && Date.now() - item.at < 30 * 60 * 1000) workedModel[p] = item.id;
    });
  } catch (err) { /* pomijamy */ }
}

async function rememberedModel(provider) {
  await loadWorked();
  return workedModel[provider] || '';
}

function rememberModel(provider, id) {
  if (!id || workedModel[provider] === id) return;
  workedModel[provider] = id;
  const payload = {};
  Object.keys(workedModel).forEach((p) => {
    if (workedModel[p]) payload[p] = { id: workedModel[p], at: Date.now() };
  });
  try {
    const task = chrome.storage.session.set({ worked_models: payload });
    if (task && task.catch) task.catch(() => {});
  } catch (err) { /* pomijamy */ }
}

/* ---------- wywołanie modelu ---------- */

/* Obraz potrzebuje więcej czasu niż tekst: to 2000+ tokenów wejścia i dłuższa odpowiedź. */
function imageTimeout(img, settings) {
  const base = settings && settings.timeoutMs ? settings.timeoutMs : DEFAULTS.timeoutMs;
  return img ? Math.max(base, 25000) : base;
}

/* Kolejność modeli: wybór użytkownika, ostatnio działający, znane nazwy.
   Dwa modele to maksimum, żeby nie mnożyć zapytań i nie wpadać w limity. */
async function providerModels(provider, settings, img) {
  const chosen = settings.models && settings.models[provider];
  const hints = provider === 'gemini' ? GEMINI_HINTS
    : provider === 'openrouter' ? OPENROUTER_HINTS
      : (img ? GROQ_IMAGE_HINTS : GROQ_HINTS);
  const remembered = await rememberedModel(provider);
  const list = [chosen !== 'auto' ? chosen : '', remembered].concat(hints).filter(Boolean);
  return Array.from(new Set(list)).slice(0, 2);
}

async function callProvider(provider, key, model, settings, system, userText, img, schema) {
  if (provider === 'openrouter') {
    try {
      return await openrouterOnce(key, model, settings, system, userText, img, true);
    } catch (err) {
      if (err && err.retryWithoutJson) return openrouterOnce(key, model, settings, system, userText, img, false);
      throw err;
    }
  }

  if (provider === 'groq') {
    // Każdy z trzech powodów powtórki może wystąpić najwyżej raz.
    const opts = { json: true, effort: 'none', budget: GROQ_BUDGET };
    for (let round = 0; round < 3; round++) {
      try {
        return await groqOnce(key, model, settings, system, userText, img, opts);
      } catch (err) {
        if (err && err.badParam === 'effort' && opts.effort) opts.effort = null;
        else if (err && err.badParam === 'json' && opts.json) opts.json = false;
        else if (err && err.lengthCut && opts.budget < 8192) opts.budget = 8192;
        else throw err;
      }
    }
    throw new Error('Groq nie zwrócił odpowiedzi');
  }

  return geminiOnce(key, model, settings, system, userText, img, schema);
}

/* Jedna odpowiedź: model główny, przy błędzie modelu drugi model, a przy
   limicie albo awarii drugi provider, jeśli ma klucz. */
async function askModel(system, userText, img, schema, opt) {
  const settings = (opt && opt.settings) || await getSettings();
  const primary = PROVIDERS.indexOf(settings.provider) !== -1 ? settings.provider : 'gemini';

  const keys = {};
  await Promise.all(PROVIDERS.map(async (p) => { keys[p] = await getKey(p); }));
  if (!keys[primary]) throw new Error('Brak klucza ' + PROVIDER_LABEL[primary] + ' — dodaj go w ustawieniach');

  const deadline = Date.now() + Math.min(45000, Math.max(15000, settings.timeoutMs * 2));
  const reasons = [];

  for (const provider of [primary].concat(PROVIDERS.filter((p) => p !== primary && keys[p]))) {
    for (const model of await providerModels(provider, settings, img)) {
      if (Date.now() > deadline) break;
      try {
        const text = await callProvider(provider, keys[provider], model, settings, system, userText, img, schema);
        if (text) {
          rememberModel(provider, model);
          return text;
        }
      } catch (err) {
        reasons.push(PROVIDER_LABEL[provider] + ': ' + msgOf(err));
        // Drugi model tego samego providera pomaga tylko przy błędzie modelu,
        // odrzuconym obrazie albo pustej odpowiedzi. Limit, klucz, blokada treści
        // i sieć dotyczą całego providera, więc od razu przechodzimy dalej.
        const kind = err && err.kind;
        if (kind !== 'model' && kind !== 'image' && kind !== 'empty') break;
      }
    }
  }

  throw new Error(reasons.length ? reasons.join(' | ').slice(0, 220) : 'Model nie zwrócił odpowiedzi');
}

/* Model bywa ucina JSON na limicie tokenów — dokładamy brakujące domknięcia. */
function closeJson(chunk) {
  let inString = false;
  let escaped = false;
  const stack = [];

  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let out = chunk;
  if (inString) out += '"';
  out = out.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

function parsePayload(chunk) {
  try {
    return JSON.parse(chunk);
  } catch (err) {
    const fixed = closeJson(chunk);
    if (fixed === chunk) return null;
    try {
      return JSON.parse(fixed);
    } catch (err2) {
      return null;
    }
  }
}

function pickAnswer(parsed) {
  if (Array.isArray(parsed)) {
    const first = parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (!first) throw new Error('Model zwrócił tablicę bez obiektu odpowiedzi');
    return first;
  }
  return parsed;
}

function looksLikeAnswer(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return 'taskType' in o || 'answers' in o || 'openAnswer' in o || 'pairs' in o || 'question' in o;
}

function balancedFrom(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/* Model czasem komentuje przed JSON-em albo wstawia nawiasy w treści, więc
   bierzemy pierwszy fragment, który naprawdę wygląda na odpowiedź. */
function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let fallback = null;

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== '{' && ch !== '[') continue;
    const slice = balancedFrom(t, i);
    if (!slice) continue;
    const parsed = parsePayload(slice);
    if (!parsed) continue;
    if (looksLikeAnswer(parsed)) return parsed;
    if (Array.isArray(parsed)) {
      const hit = parsed.find(looksLikeAnswer);
      if (hit) return hit;
    }
    if (!fallback && typeof parsed === 'object') fallback = parsed;
    i += slice.length - 1;
  }

  if (fallback) return pickAnswer(fallback);

  // Ucięty JSON: domykamy go od pierwszego nawiasu i próbujemy jeszcze raz.
  const start = t.search(/[{[]/);
  if (start !== -1) {
    const repaired = parsePayload(closeJson(t.slice(start)));
    if (repaired) return pickAnswer(repaired);
  }

  throw new Error('Model nie zwrócił czytelnej odpowiedzi — spróbuj ponownie');
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
const TYPES = ['single', 'multi', 'truefalse', 'numeric', 'open', 'match', 'unknown'];

/* Model bywa niesforny: warianty przychodzą jako stringi albo pod inną nazwą
   pola. Każdy wariant z treścią ma trafić do panelu, a nie zniknąć. */
function cleanItem(o) {
  const src = o && typeof o === 'object' ? o : { text: o };
  const text = String(src.text || src.answer || src.value || src.content || '').trim();
  return {
    label: String(src.label || src.letter || '').trim().slice(0, 8),
    text: enforceStyle(text.slice(0, 400)),
    confidence: clamp(src.confidence, 0, 100)
  };
}

function normalizeAnswer(raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let type = TYPES.indexOf(a.taskType) !== -1 ? a.taskType : 'unknown';

  const options = Array.isArray(a.options) ? a.options.map(cleanItem).filter((o) => o.text).slice(0, 14) : [];
  const answers = Array.isArray(a.answers) ? a.answers.map(cleanItem).filter((o) => o.text).slice(0, 14) : [];
  const pairs = Array.isArray(a.pairs)
    ? a.pairs
        .map((p) => ({
          left: enforceStyle(String((p && p.left) || '').trim().slice(0, 160)),
          right: enforceStyle(String((p && p.right) || '').trim().slice(0, 160))
        }))
        .filter((p) => p.left && p.right)
        .slice(0, 14)
    : [];

  let openAnswer = enforceStyle(String(a.openAnswer || '').trim().slice(0, 2000));
  if (!openAnswer && answers.length && (type === 'open' || type === 'numeric' || type === 'truefalse')) {
    openAnswer = answers[0].text;
  }

  // Typ czasem nie pasuje do treści, którą model przysłał. Dopasowujemy go do
  // danych, żeby panel pokazał odpowiedź, a nie pusty komunikat.
  if (type === 'match' && !pairs.length) {
    if (answers.length) type = answers.length > 1 ? 'multi' : 'single';
    else if (openAnswer) type = 'open';
    else type = 'unknown';
  }
  if (type === 'unknown' && pairs.length && !answers.length && !openAnswer) type = 'match';

  const noList = type === 'open' || type === 'numeric' || type === 'truefalse' || type === 'match';

  return {
    taskType: type,
    question: String(a.question || '').trim().slice(0, 1200),
    options: options,
    answers: noList ? [] : answers,
    pairs: type === 'match' ? pairs : [],
    openAnswer: openAnswer,
    notes: enforceStyle(String(a.notes || '').trim().slice(0, 200)),
    confidence: clamp(a.confidence, 0, 100)
  };
}

/* Samo przepisane pytanie to jeszcze nie odpowiedź: panel pokazałby wtedy
   „Model nie zwrócił treści”. Lepiej ponowić pytanie do modelu. */
function isEmptyAnswer(a) {
  return !a || (!a.openAnswer && !a.answers.length && !a.pairs.length);
}

function plainText(a) {
  if (!a) return '';
  if (a.taskType === 'match' && a.pairs && a.pairs.length) {
    return a.pairs.map((p) => p.left + ' - ' + p.right).join('; ');
  }
  if (a.taskType === 'open' || a.taskType === 'numeric' || a.taskType === 'truefalse') {
    return a.openAnswer || (a.answers[0] ? a.answers[0].text : '');
  }
  if (!a.answers.length) return a.openAnswer || '';
  return a.answers.map((x) => (x.label ? x.label + '. ' : '') + x.text).join('; ');
}

/* ---------- cache ---------- */

const CACHE_KEY = 'answer_cache';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 60;

async function cacheRead(key) {
  const box = await chrome.storage.local.get(CACHE_KEY);
  const list = Array.isArray(box[CACHE_KEY]) ? box[CACHE_KEY] : [];
  const now = Date.now();
  const fresh = list.filter((e) => e && e.at && now - e.at < CACHE_TTL);
  if (fresh.length !== list.length) await chrome.storage.local.set({ [CACHE_KEY]: fresh });
  const hit = fresh.find((e) => e.k === key);
  return hit && hit.answer ? hit.answer : null;
}

async function cacheWrite(key, answer) {
  const box = await chrome.storage.local.get(CACHE_KEY);
  const now = Date.now();
  const list = (Array.isArray(box[CACHE_KEY]) ? box[CACHE_KEY] : [])
    .filter((e) => e && e.at && now - e.at < CACHE_TTL && e.k !== key);
  list.unshift({ k: key, at: now, answer: answer });
  await chrome.storage.local.set({ [CACHE_KEY]: list.slice(0, CACHE_LIMIT) });
}

async function cacheClear() {
  await chrome.storage.local.set({ [CACHE_KEY]: [] });
}

function hashStr(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ---------- ramki i wstrzykiwanie ---------- */

/* Panel może wylądować w innej ramce niż poprzednio, więc trzymamy cały zestaw. */
const panelFrames = new Map(); // tabId -> Set<frameId>

function injectReason(err) {
  const m = msgOf(err);
  if (/extensions gallery|cannot access|invalid url|chrome:\/\/|extension pages/i.test(m)) {
    return 'strona systemowa, brak dostępu';
  }
  if (/no frame|frame with id|cannot find frame/i.test(m)) return 'zablokowana ramka';
  if (/closed|removed|no longer exists|not found/i.test(m)) return 'utracono dostęp do karty, odśwież stronę';
  return m.slice(0, 120);
}

async function pickFrame(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: () => {
        const body = document.body;
        return { len: body ? String(body.innerText || '').length : 0, top: window === window.top };
      }
    });
    let best = null;
    (res || []).forEach((item) => {
      const value = item.result || { len: 0, top: false };
      if (!best || value.len > best.len || (value.len === best.len && value.top)) {
        best = { frameId: item.frameId || 0, len: value.len };
      }
    });
    return best ? best.frameId : 0;
  } catch (err) {
    return 0;
  }
}

function frameOf(tabId) {
  const set = panelFrames.get(tabId);
  if (!set || !set.size) return 0;
  return set.values().next().value;
}

async function closeStalePanels(tabId, keepFrameId) {
  const known = panelFrames.get(tabId);
  if (!known || !known.size) return;
  const stale = Array.from(known).filter((id) => id !== keepFrameId);
  stale.forEach((id) => known.delete(id));
  if (!known.size) panelFrames.delete(tabId);
  if (!stale.length) return;
  await Promise.all(stale.map((frameId) => sendMsgTo(tabId, frameId, { type: 'tt:close' })));
}

function sendMsgTo(tabId, frameId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId: frameId }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function sendMsg(tabId, msg) {
  return sendMsgTo(tabId, frameOf(tabId), msg);
}

async function ensureOverlay(tabId) {
  const frameId = await pickFrame(tabId);
  await closeStalePanels(tabId, frameId);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId, frameIds: [frameId] }, files: ['overlay.js'] });
  } catch (err) {
    return { ok: false, reason: injectReason(err) };
  }
  for (let i = 0; i < 6; i++) {
    const res = await sendMsgTo(tabId, frameId, { type: 'tt:ping' });
    if (res && res.ok) {
      panelFrames.set(tabId, new Set([frameId]));
      return { ok: true, frameId: frameId };
    }
    await sleep(60);
  }
  return { ok: false, reason: 'panel nie odpowiedział w tej ramce' };
}

async function pushSettings(tabId) {
  const settings = await getSettings();
  await sendMsg(tabId, {
    type: 'tt:settings',
    settings: {
      theme: settings.theme,
      hideDelay: settings.hideDelay,
      pos: settings.pos,
      thresholdWarn: settings.thresholdWarn,
      thresholdHide: settings.thresholdHide,
      showOptions: settings.showOptions
    }
  });
}

async function flashBadge(tabId, text, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#5b6472' });
    if (tabId != null) await chrome.action.setBadgeText({ tabId: tabId, text: text });
    else await chrome.action.setBadgeText({ text: text });
    if (tabId != null) await chrome.action.setTitle({ tabId: tabId, title: title });
    setTimeout(() => {
      const clear = tabId != null ? chrome.action.setBadgeText({ tabId: tabId, text: '' }) : chrome.action.setBadgeText({ text: '' });
      clear.catch(() => {});
      chrome.action.setTitle({ tabId: tabId, title: 'Tab Tools' }).catch(() => {});
    }, 6000);
  } catch (err) { /* brak karty */ }
}

const BLOCKED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|data):/i;

function isRestricted(url) {
  if (!url) return false;
  if (PDF_VIEWER.test(url)) return false;
  if (BLOCKED_URL.test(url)) return true;
  return /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

function isPdfViewer(url) {
  return PDF_VIEWER.test(String(url || ''));
}

async function activeTab() {
  const list = await chrome.tabs.query({ active: true, currentWindow: true });
  return list[0] || null;
}

async function resolveTab(tab) {
  if (tab && tab.id != null) return tab;
  return activeTab();
}

async function openPopup() {
  try {
    if (chrome.action && typeof chrome.action.openPopup === 'function') await chrome.action.openPopup();
  } catch (err) { /* brak gestu lub okna */ }
}

async function reportFailure(tabId, message) {
  try {
    if (tabId != null) await chrome.action.setTitle({ tabId: tabId, title: 'Tab Tools — ' + message });
  } catch (err) { /* pomijamy */ }
  const settings = await getSettings();
  if (settings.badge) await flashBadge(tabId, '!', message);
  await chrome.storage.local.set({ last_error: { message: message, at: Date.now() } });
  await openPopup();
}

async function fail(tabId, message) {
  await sendMsg(tabId, { type: 'tt:state', text: message, error: true });
  try {
    if (tabId != null) await chrome.action.setTitle({ tabId: tabId, title: 'Tab Tools — ' + message });
  } catch (err) { /* pomijamy */ }
  const settings = await getSettings();
  if (settings.badge) await flashBadge(tabId, '!', message);
  await chrome.storage.local.set({ last_error: { message: message, at: Date.now() } });
}

async function clearError() {
  await chrome.storage.local.remove('last_error');
  try { await chrome.action.setTitle({ title: 'Tab Tools' }); } catch (err) { /* pomijamy */ }
  return { ok: true };
}

/* ---------- zrzut i kadrowanie ---------- */

function cropAndOptimizeImage(dataUrl, maxWidth, box) {
  return (async () => {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const W = bmp.width;
    const H = bmp.height;

    let sx = 0;
    let sy = 0;
    let sw = W;
    let sh = H;

    if (box && box.w > 20 && box.h > 20) {
      const k = W / (box.vw || W);
      const margin = 12 * k;
      sx = Math.max(0, Math.round(box.x * k - margin));
      sy = Math.max(0, Math.round(box.y * k - margin));
      const ex = Math.min(W, Math.round((box.x + box.w) * k + margin));
      const ey = Math.min(H, Math.round((box.y + box.h) * k + margin));
      sw = Math.max(1, ex - sx);
      sh = Math.max(1, ey - sy);
    } else {
      // Kadr awaryjny: pełna szerokość, obcięty tylko pasek przeglądarki.
      sy = Math.round(H * 0.12);
      sh = Math.max(1, H - sy);
    }

    const scale = Math.min(1, (maxWidth || DEFAULTS.maxImageWidth) / sw);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);

    // 24x24 średnia jasność — stabilniejszy klucz cache niż 16x16.
    const tiny = new OffscreenCanvas(24, 24);
    const tctx = tiny.getContext('2d', { alpha: false });
    tctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, 24, 24);
    const data = tctx.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      gray.push(v);
      sum += v;
    }
    const avg = sum / gray.length;
    let hash = '';
    for (let i = 0; i < gray.length; i += 4) {
      let nibble = 0;
      for (let b = 0; b < 4; b++) nibble = (nibble << 1) | (gray[i + b] > avg ? 1 : 0);
      hash += nibble.toString(16);
    }
    bmp.close();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await out.arrayBuffer());

    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return { b64: btoa(bin), mime: 'image/jpeg', hash: hash, width: w, height: h, crop: { x: sx, y: sy, w: sw, h: sh } };
  })();
}

/* Chrome pozwala na 2 zrzuty na sekundę, odstęp pilnujemy tylko przy szybkim powtórzeniu. */
const CAPTURE_GAP_MS = 400;

async function captureShot(windowId) {
  const gap = Date.now() - lastCaptureAt;
  if (gap < CAPTURE_GAP_MS) await sleep(CAPTURE_GAP_MS - gap);
  lastCaptureAt = Date.now();
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 82 });
  } catch (err) {
    // Limit kwotowy Chrome liczy okno sekundowe — jedna ponowna próba po pełnym odstępie.
    await sleep(CAPTURE_GAP_MS);
    lastCaptureAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 82 });
  }
}

/* Ramka cross-origin nie ma dostępu do frameElement, więc mierzymy iframe z góry. */
function iframeProbe() {
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const frames = [];
  const all = document.querySelectorAll('iframe, frame');
  for (let i = 0; i < all.length && frames.length < 40; i++) {
    const r = all[i].getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    frames.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { vw: vw, vh: vh, frames: frames };
}

function frameSizeProbe() {
  return { w: window.innerWidth || 0, h: window.innerHeight || 0 };
}

function questionBoxProbe(args) {
  const opt = args || {};
  const vw = opt.vw || window.innerWidth || 0;
  const vh = opt.vh || window.innerHeight || 0;
  if (!vw || !vh) return null;

  // Prostokąt musi być w układzie zrzutu, czyli górnego dokumentu.
  const offsetX = Number(opt.x) || 0;
  const offsetY = Number(opt.y) || 0;
  const rootVw = vw;
  const rootVh = vh;

  const seen = new Set();
  const seeds = [];
  const add = (el) => {
    if (!el || seen.has(el) || seeds.length >= 90) return;
    seen.add(el);
    seeds.push(el);
  };

  const fields = [];
  const all = document.querySelectorAll('input,textarea,select');
  for (let i = 0; i < all.length && fields.length < 300; i++) {
    const el = all[i];
    const tag = el.tagName;
    const type = String(el.type || '').toLowerCase();
    const usable = tag === 'TEXTAREA' || tag === 'SELECT' || type === 'radio' || type === 'checkbox' || type === 'text' || type === 'number' || !el.type;
    if (!usable) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) fields.push(el);
  }
  fields.forEach((el) => add(el.closest('fieldset,li,tr,form,section,article,div')));

  const nodes = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,legend,strong,b,label,div,span');
  for (let i = 0; i < nodes.length && i < 1500; i++) {
    const el = nodes[i];
    const txt = String(el.innerText || '').trim();
    if (txt.length < 4 || txt.length > 3000) continue;
    if (!/^(pytanie|zadanie|question|zad)\b/i.test(txt)) continue;
    add(el);
  }

  let best = null;
  seeds.forEach((seed) => {
    let box = seed;
    for (let up = 0; up < 4; up++) {
      if (!box.parentElement) break;
      if (box.querySelector('input,textarea,select')) break;
      if (box.getBoundingClientRect().height > vh * 0.6) break;
      box = box.parentElement;
    }

    const local = box.getBoundingClientRect();
    if (local.width < 100 || local.height < 30) return;
    const text = String(box.innerText || '').trim();
    if (text.length < 20) return;

    const r = {
      left: local.left + offsetX,
      top: local.top + offsetY,
      width: local.width,
      height: local.height,
      right: local.right + offsetX,
      bottom: local.bottom + offsetY
    };

    let score = 0;
    const insideV = r.top >= -1 && r.bottom <= rootVh + 1;
    const insideH = r.left >= -1 && r.right <= rootVw + 1;
    if (insideV && insideH) score += 50;
    if (box.querySelector('input,textarea,select')) score += 30;

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const diag = Math.sqrt(Math.pow(rootVw / 2, 2) + Math.pow(rootVh / 2, 2));
    const dist = Math.sqrt(Math.pow(cx - rootVw / 2, 2) + Math.pow(cy - rootVh / 2, 2)) / Math.max(1, diag);
    score += Math.round(20 * (1 - Math.min(1, dist)));

    if (!insideV) score -= 40;
    if (r.height > rootVh * 0.55) score -= 20;

    if (!best || score > best.score) {
      best = { score: score, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, vw: rootVw };
    }
  });

  if (!best || best.score < 45) return null;
  return best;
}

async function frameOffset(tabId, frameId) {
  const sizeRes = await chrome.scripting.executeScript({
    target: { tabId: tabId, frameIds: [frameId] },
    func: frameSizeProbe
  });
  const size = sizeRes && sizeRes[0] ? sizeRes[0].result : null;
  if (!size || !size.w || !size.h) return null;

  const topRes = await chrome.scripting.executeScript({
    target: { tabId: tabId, frameIds: [0] },
    func: iframeProbe
  });
  const top = topRes && topRes[0] ? topRes[0].result : null;
  if (!top) return null;

  const hits = (top.frames || []).filter((f) => Math.abs(f.w - size.w) <= 2 && Math.abs(f.h - size.h) <= 2);
  if (hits.length !== 1) return null;
  return { x: hits[0].x, y: hits[0].y, vw: top.vw, vh: top.vh };
}

async function findQuestionBox(tabId, frameId) {
  try {
    let offset = { x: 0, y: 0, vw: 0, vh: 0 };
    if (frameId) {
      const found = await frameOffset(tabId, frameId);
      if (!found) return null;
      offset = found;
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [frameId] },
      func: questionBoxProbe,
      args: [offset]
    });
    const value = res && res[0] ? res[0].result : null;
    if (!value || !value.rect || !value.rect.w) return null;
    return value;
  } catch (err) {
    return null;
  }
}

/* ---------- tekst strony ---------- */

function pageTextProbe() {
  const body = document.body;
  // Duże strony nie mają po co przesyłać całego tekstu — do promptu idzie 4000 znaków.
  return body ? String(body.innerText || '').slice(0, 12000) : '';
}

async function readPageText(tabId, frameId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [frameId] },
      func: pageTextProbe
    });
    return String((res && res[0] && res[0].result) || '');
  } catch (err) {
    return '';
  }
}

/* Tekst strony jest dokładniejszy od OCR i nie kosztuje dodatkowego zapytania:
   model poprawia nim odczyt pytania z obrazu. */
function imageUserText(pageText) {
  const clean = String(pageText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!clean) return USER_IMAGE;
  return USER_IMAGE + '\n\nTekst widoczny na stronie (do sprawdzenia brzmienia pytania i wariantów; może zawierać elementy interfejsu):\n' + clean;
}

/* ---------- odpowiedź ---------- */

/* Typ single z kilkoma wariantami poprawiamy lokalnie, bez kolejnego zapytania. */
function finalizeSingle(answer) {
  if (answer.taskType !== 'single' || answer.answers.length <= 1) return answer;

  const best = answer.answers.reduce((pick, item) => (item.confidence > pick.confidence ? item : pick), answer.answers[0]);
  const rest = answer.answers.filter((item) => item !== best);
  return Object.assign({}, answer, {
    answers: [best],
    options: answer.options.length ? answer.options : rest,
    confidence: clamp(answer.confidence, 0, 90),
    notes: (answer.notes ? answer.notes + ' ' : '') + 'wybrano najpewniejszy wariant'
  });
}

/* Model czasem odpowiada prozą zamiast JSON-a. Taki tekst jest lepszy niż
   pusty panel, więc pokazujemy go jako odpowiedź otwartą. */
function parseAnswer(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return normalizeAnswer(extractJson(raw));
  } catch (err) {
    if (/^[[{]/.test(raw)) return null;
    return normalizeAnswer({ taskType: 'open', openAnswer: raw.slice(0, 2000), confidence: 50 });
  }
}

/* Jedno pytanie do modelu plus co najwyżej jedna powtórka, gdy odpowiedź
   wróciła pusta albo nieczytelna. */
async function solve(ctx, settings) {
  let answer = parseAnswer(await askModel(ctx.system, ctx.userText, ctx.img, ctx.schema, { settings: settings }));

  if (isEmptyAnswer(answer)) {
    answer = parseAnswer(await askModel(ctx.system, ctx.userText + RETRY_EMPTY, ctx.img, ctx.schema, { settings: settings }));
    if (isEmptyAnswer(answer)) throw new Error('Model nie odczytał pytania — spróbuj ponownie');
  }

  return finalizeSingle(answer);
}

async function pushHistory(entry) {
  const box = await chrome.storage.local.get('history');
  const list = Array.isArray(box.history) ? box.history : [];
  list.unshift(entry);
  if (list.length > 100) list.length = 100;
  await chrome.storage.local.set({ history: list });
}

async function loadLast() {
  if (lastAnswerLoaded) return lastAnswer;
  const box = await chrome.storage.local.get('last_answer');
  lastAnswer = box.last_answer || null;
  lastAnswerLoaded = true;
  return lastAnswer;
}

async function deliver(tabId, answer, settings, source, opts) {
  const options = opts || {};
  lastAnswer = answer;
  lastAnswerLoaded = true;

  const payload = {
    type: 'tt:answer',
    data: answer,
    silent: settings.mode === 'manual',
    thresholdWarn: settings.thresholdWarn,
    thresholdHide: settings.thresholdHide,
    showOptions: settings.showOptions
  };

  // Panel dostaje odpowiedź od razu, zapisy idą po niej.
  if (options.panel) await sendMsg(tabId, payload);
  try {
    await chrome.storage.local.set({ last_answer: answer });
    await pushHistory({
      id: Date.now(),
      at: Date.now(),
      source: source,
      type: answer.taskType,
      question: answer.question,
      text: plainText(answer),
      confidence: answer.confidence
    });
  } catch (err) { /* pełny storage nie może ukryć gotowej odpowiedzi */ }
  try { await chrome.action.setTitle({ tabId: tabId, title: 'Tab Tools — gotowe' }); } catch (err) { /* pomijamy */ }
  if (!options.panel) await openPopup();
}

/* ---------- akcje ---------- */

async function runCapture(target, frameId, hasPanel) {
  const settings = await getSettings();
  let box = null;
  let pageText = '';

  if (hasPanel) {
    // Niezależne wywołania idą równolegle: ustawienia panelu, pomiar pytania i tekst strony.
    // Probe nie widzi panelu w shadow DOM, więc mierzymy przed ukryciem.
    const prep = await Promise.all([
      pushSettings(target.id).catch(() => {}),
      findQuestionBox(target.id, frameId),
      readPageText(target.id, frameId)
    ]);
    box = prep[1];
    pageText = prep[2];
    await sendMsg(target.id, { type: 'tt:hide' });
    await sleep(80);
  }

  let shot;
  try {
    shot = await captureShot(target.windowId);
  } catch (err) {
    if (hasPanel) await sendMsg(target.id, { type: 'tt:restore' });
    const message = 'Nie udało się zrobić zrzutu ekranu';
    if (hasPanel) await fail(target.id, message);
    else await reportFailure(target.id, message);
    throw new Error(message);
  }

  if (hasPanel) await sendMsg(target.id, { type: 'tt:restore' });

  if (hasPanel && settings.showStatus) {
    await sendMsg(target.id, { type: 'tt:state', text: box ? 'Analizuję pytanie…' : 'Analizuję ekran…', busy: true });
  }

  let img;
  try {
    img = await cropAndOptimizeImage(shot, settings.maxImageWidth, box);
  } catch (err) {
    if (hasPanel) await fail(target.id, 'Nie udało się przetworzyć obrazu');
    else await reportFailure(target.id, 'Nie udało się przetworzyć obrazu');
    throw new Error('Nie udało się przetworzyć obrazu');
  }

  const userText = imageUserText(pageText);
  const cacheKey = 'img:' + img.hash + ':' + settings.provider + ':' + settings.maxImageWidth
    + ':' + hashStr(userText) + ':' + img.crop.x + ',' + img.crop.y + ',' + img.crop.w + ',' + img.crop.h;
  const cached = await cacheRead(cacheKey);
  if (cached) {
    const answer = Object.assign({}, cached, { confidence: clamp(cached.confidence + 3, 0, 100) });
    await deliver(target.id, answer, settings, 'screen', { panel: hasPanel });
    return { ok: true, answer: answer, cached: true };
  }

  try {
    const answer = await solve({ system: SYS_IMAGE, userText: userText, img: img, schema: SCHEMA_ANSWER }, settings);
    await cacheWrite(cacheKey, answer);
    await deliver(target.id, answer, settings, 'screen', { panel: hasPanel });
    return { ok: true, answer: answer };
  } catch (err) {
    if (hasPanel) await fail(target.id, msgOf(err));
    else await reportFailure(target.id, msgOf(err));
    throw err;
  }
}

async function handleCapture(tab) {
  const target = await resolveTab(tab);
  if (!target || target.id == null) throw new Error('Brak aktywnej karty');

  const pdf = isPdfViewer(target.url);
  if (!pdf && isRestricted(target.url)) {
    await reportFailure(target.id, 'Ta strona jest zablokowana dla rozszerzeń');
    throw new Error('Ta strona jest zablokowana dla rozszerzeń');
  }

  if (pdf) return runCapture(target, 0, false);

  const overlay = await ensureOverlay(target.id);
  if (!overlay.ok) {
    const message = 'Nie udało się dodać panelu: ' + overlay.reason;
    await reportFailure(target.id, message);
    throw new Error(message);
  }
  return runCapture(target, overlay.frameId, true);
}

function selectionProbe() {
  const el = document.activeElement;
  const tag = el && el.tagName;
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|url|email|number)$/i.test(el.type || ''))) {
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    if (end > start) return String(el.value).slice(start, end);
  }
  const sel = window.getSelection ? window.getSelection() : null;
  return sel ? String(sel.toString()) : '';
}

async function readSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: selectionProbe
    });
    let best = '';
    (results || []).forEach((item) => {
      const text = String(item.result || '');
      if (text.length > best.length) best = text;
    });
    return best;
  } catch (err) {
    return '';
  }
}

async function handleSelection(tab) {
  const target = await resolveTab(tab);
  if (!target || target.id == null) throw new Error('Brak aktywnej karty');
  if (isRestricted(target.url)) {
    await reportFailure(target.id, 'Ta strona jest zablokowana dla rozszerzeń');
    throw new Error('Ta strona jest zablokowana dla rozszerzeń');
  }

  if (isPdfViewer(target.url)) {
    await reportFailure(target.id, 'Podgląd PDF — zaznaczanie nie działa, użyj zrzutu');
    throw new Error('Podgląd PDF — użyj zrzutu ekranu');
  }

  const overlay = await ensureOverlay(target.id);
  if (!overlay.ok) {
    const message = 'Nie udało się dodać panelu: ' + overlay.reason;
    await reportFailure(target.id, message);
    throw new Error(message);
  }

  const settings = await getSettings();
  let text = await readSelection(target.id);
  text = text.replace(/\s+/g, ' ').trim().slice(0, 6000);

  if (!text) {
    if (settings.showStatus) {
      await sendMsg(target.id, { type: 'tt:state', text: 'Brak zaznaczenia, robię zrzut…', busy: true });
    }
    // Panel już jest w tej ramce, drugie wstrzyknięcie nie jest potrzebne.
    return runCapture(target, overlay.frameId, true);
  }

  await pushSettings(target.id);
  if (settings.showStatus) {
    await sendMsg(target.id, { type: 'tt:state', text: 'Czytam zaznaczenie…', busy: true });
  }

  const cacheKey = 'txt:' + hashStr(text) + ':' + settings.provider;
  const cached = await cacheRead(cacheKey);
  if (cached) {
    const answer = Object.assign({}, cached, { confidence: clamp(cached.confidence + 3, 0, 100) });
    await deliver(target.id, answer, settings, 'selection', { panel: true });
    return { ok: true, answer: answer, cached: true };
  }

  try {
    const answer = await solve({ system: SYS_TEXT, userText: 'Zadanie:\n' + text, img: null, schema: SCHEMA_ANSWER }, settings);
    await cacheWrite(cacheKey, answer);
    await deliver(target.id, answer, settings, 'selection', { panel: true });
    return { ok: true, answer: answer };
  } catch (err) {
    await fail(target.id, msgOf(err));
    throw err;
  }
}

const toggleAt = new Map();

async function togglePanel(tab) {
  const target = await resolveTab(tab);
  if (!target || target.id == null) throw new Error('Brak aktywnej karty');
  if (isRestricted(target.url)) {
    await reportFailure(target.id, 'Panel nie działa na tej stronie');
    throw new Error('Panel nie działa na tej stronie');
  }
  if (isPdfViewer(target.url)) {
    await reportFailure(target.id, 'Podgląd PDF — odpowiedź jest w popupie');
    throw new Error('Podgląd PDF — panel jest niedostępny');
  }

  const now = Date.now();
  if (now - (toggleAt.get(target.id) || 0) < 300) return { ok: true, skipped: true };
  toggleAt.set(target.id, now);

  const overlay = await ensureOverlay(target.id);
  if (!overlay.ok) {
    const message = 'Nie udało się dodać panelu: ' + overlay.reason;
    await reportFailure(target.id, message);
    throw new Error(message);
  }

  await pushSettings(target.id);
  await sendMsg(target.id, { type: 'tt:toggle' });
  return { ok: true };
}

function answerFromEntry(entry) {
  // Historia trzyma gotowy tekst bez etykiet, więc pokazujemy go jak odpowiedź otwartą.
  return {
    taskType: 'open',
    question: String((entry && entry.question) || '').slice(0, 1200),
    options: [],
    answers: [],
    pairs: [],
    openAnswer: String((entry && entry.text) || '').slice(0, 2000),
    notes: '',
    confidence: clamp(entry && entry.confidence, 0, 100)
  };
}

async function showLast(tab, entry) {
  const target = await resolveTab(tab);
  if (!target || target.id == null) throw new Error('Brak aktywnej karty');
  if (isRestricted(target.url)) {
    await reportFailure(target.id, 'Panel nie działa na tej stronie');
    throw new Error('Panel nie działa na tej stronie');
  }
  if (isPdfViewer(target.url)) {
    await reportFailure(target.id, 'Podgląd PDF — odpowiedź jest w popupie');
    throw new Error('Podgląd PDF — panel jest niedostępny');
  }

  const overlay = await ensureOverlay(target.id);
  if (!overlay.ok) {
    const message = 'Nie udało się dodać panelu: ' + overlay.reason;
    await reportFailure(target.id, message);
    throw new Error(message);
  }

  const settings = await getSettings();
  const answer = entry && entry.text ? answerFromEntry(entry) : await loadLast();
  await pushSettings(target.id);
  await sendMsg(target.id, {
    type: 'tt:show',
    data: answer,
    thresholdWarn: settings.thresholdWarn,
    thresholdHide: settings.thresholdHide,
    showOptions: settings.showOptions
  });
  return { ok: true };
}

async function toggleMode(tab) {
  const settings = await getSettings();
  const next = await saveSettings({ mode: settings.mode === 'auto' ? 'manual' : 'auto' });

  const target = await resolveTab(tab);
  if (target && target.id != null && !isRestricted(target.url)) {
    const overlay = await ensureOverlay(target.id);
    if (overlay.ok) {
      await pushSettings(target.id);
      await sendMsg(target.id, {
        type: 'tt:state',
        text: next.mode === 'auto' ? 'Tryb auto: panel pokaże się od razu' : 'Tryb manual: pokaż panel przez Alt+Shift+2'
      });
    }
  }
  return { ok: true, mode: next.mode };
}

/* ---------- wiadomości ---------- */

async function buildState() {
  const [settings, keys, box] = await Promise.all([
    getSettings(),
    keyState(),
    chrome.storage.local.get(['history', 'last_answer', 'last_error', 'answer_cache'])
  ]);
  const stored = lastAnswer || box.last_answer || null;

  return Object.assign({
    ok: true,
    settings: settings,
    history: Array.isArray(box.history) ? box.history : [],
    lastError: box.last_error && box.last_error.message ? box.last_error : null,
    cacheSize: Array.isArray(box.answer_cache) ? box.answer_cache.length : 0,
    lastAnswer: stored
      ? {
          text: plainText(stored),
          question: stored.question,
          type: stored.taskType,
          confidence: stored.confidence,
          notes: stored.notes,
          at: stored.at || null
        }
      : null
  }, keys);
}

async function saveAll(msg) {
  const before = await getSettings();
  const settings = await saveSettings(msg.patch || {});

  const writes = {};
  const keys = msg.keys || {};
  Object.keys(KEY_FIELD).forEach((provider) => {
    const value = keys[provider];
    if (typeof value === 'string' && value.trim()) writes[KEY_FIELD[provider]] = value.trim();
  });

  const clear = msg.clearKeys || {};
  Object.keys(KEY_FIELD).forEach((provider) => {
    if (clear[provider]) writes[KEY_FIELD[provider]] = '';
  });

  if (Object.keys(writes).length) {
    await chrome.storage.local.set(writes);
    geminiCache = { key: '', at: 0, ids: [] };
  }

  if (clear.gemini) {
    const box = await chrome.storage.local.get('settings');
    if (box.settings && box.settings.geminiKey) {
      const next = Object.assign({}, box.settings);
      delete next.geminiKey;
      await chrome.storage.local.set({ settings: next });
    }
  }

  const modelsChanged = JSON.stringify(before.models) !== JSON.stringify(settings.models);
  if (modelsChanged || before.provider !== settings.provider) await cacheClear();

  const tab = await activeTab();
  if (tab && tab.id != null && !isRestricted(tab.url)) await pushSettings(tab.id);

  return Object.assign({ ok: true, settings: settings }, await keyState());
}

async function testKey(msg) {
  const provider = KEY_FIELD[msg.provider] ? msg.provider : 'gemini';
  const typed = String((msg && msg.key) || '').trim();
  const key = typed || (await getKey(provider));

  if (!key) {
    if (provider === 'openrouter') {
      try {
        const models = await openrouterModels();
        return {
          ok: true,
          message: 'Lista modeli OpenRouter działa bez klucza (' + models.length + '). Wklej klucz, aby testować odpowiedzi.',
          models: models.filter((m) => m.vision).map((m) => m.id).slice(0, 25)
        };
      } catch (err) {
        return { ok: false, error: msgOf(err) };
      }
    }
    return { ok: false, error: 'Brak klucza ' + PROVIDER_LABEL[provider] + ' — dodaj go w ustawieniach' };
  }

  try {
    if (provider === 'groq') {
      const st = await getSettings();
      const model = GROQ_HINTS[0];
      try {
        await groqOnce(key, model, st, 'Odpowiedz jednym słowem.', 'Napisz: OK', null, { json: true, effort: 'none' });
      } catch (err) {
        if (!err || !err.badParam) throw err;
        await groqOnce(key, model, st, 'Odpowiedz jednym słowem.', 'Napisz: OK', null, { json: false, effort: null });
      }
      let ids = [];
      try { ids = await groqModels(key); } catch (err) { ids = []; }
      return { ok: true, message: 'Klucz działa. Model: ' + model, models: ids.slice(0, 25) };
    }

    if (provider === 'openrouter') {
      const models = await openrouterModels();
      const vision = models.filter((m) => m.vision).map((m) => m.id);
      const model = vision[0] || models[0].id;
      await openrouterOnce(key, model, await getSettings(), 'Odpowiedz jednym słowem.', 'Napisz: OK', null, true);
      return {
        ok: true,
        message: 'Klucz działa. Model: ' + model,
        models: vision.slice(0, 25)
      };
    }

    const ids = await geminiModels(key);
    if (!ids.length) return { ok: false, error: 'Klucz działa, ale nie widzi modeli generateContent' };
    const ranked = rankGemini(ids);
    const model = ranked[0] || ids[0];
    await geminiOnce(key, model, await getSettings(), 'Odpowiedz jednym słowem.', 'Napisz: OK', null, {
      type: 'OBJECT',
      properties: { ok: { type: 'STRING' } },
      required: ['ok']
    });
    return { ok: true, message: 'Klucz działa. Model: ' + model, models: ranked.slice(0, 20) };
  } catch (err) {
    return { ok: false, error: msgOf(err) };
  }
}

async function modelsFor(msg) {
  const provider = KEY_FIELD[msg.provider] ? msg.provider : 'gemini';
  const typed = String((msg && msg.key) || '').trim();

  try {
    if (provider === 'groq') {
      const key = typed || (await getKey('groq'));
      if (!key) return { ok: false, error: 'Brak klucza Groq' };
      const ids = await groqModels(key);
      // Modele z wizją pierwsze, resztę zostawiamy do wyboru ręcznego.
      const vision = GROQ_VISION.filter((id) => ids.indexOf(id) !== -1);
      const rest = ids.filter((id) => vision.indexOf(id) === -1);
      return { ok: true, models: vision.concat(rest).slice(0, 25) };
    }

    if (provider === 'openrouter') {
      const models = await openrouterModels();
      const vision = models.filter((m) => m.vision).map((m) => m.id);
      const hints = OPENROUTER_HINTS.filter((id) => vision.indexOf(id) !== -1);
      const rest = vision.filter((id) => hints.indexOf(id) === -1);
      return { ok: true, models: hints.concat(rest).slice(0, 25) };
    }

    const key = typed || (await getKey('gemini'));
    if (!key) return { ok: false, error: 'Brak klucza Gemini' };
    return { ok: true, models: rankGemini(await geminiModels(key)).slice(0, 20) };
  } catch (err) {
    return { ok: false, error: msgOf(err) };
  }
}

const ROUTES = {
  'tt:getState': () => buildState(),
  'tt:capture': (msg, sender) => handleCapture(sender && sender.tab),
  'tt:captureActive': () => handleCapture(null),
  'tt:repeat': (msg, sender) => togglePanel(sender && sender.tab),
  'tt:repeatActive': () => togglePanel(null),
  'tt:select': (msg, sender) => handleSelection(sender && sender.tab),
  'tt:selectActive': () => handleSelection(null),
  'tt:show': (msg, sender) => showLast(sender && sender.tab, msg.entry || null),
  'tt:toggleMode': (msg, sender) => toggleMode(sender && sender.tab),
  'tt:save': (msg) => saveAll(msg),
  'tt:savePos': (msg) => saveSettings({ pos: msg.pos || null }),
  'tt:testKey': (msg) => testKey(msg),
  'tt:listModels': (msg) => modelsFor(msg),
  'tt:clearError': () => clearError(),
  'tt:clearHistory': async () => {
    await chrome.storage.local.set({ history: [] });
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const handler = ROUTES[msg.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((out) => {
      try { sendResponse(out || { ok: true }); } catch (err) { /* popup zamknięty */ }
    })
    .catch((err) => {
      try { sendResponse({ ok: false, error: msgOf(err) }); } catch (e) { /* popup zamknięty */ }
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tt-ka') return;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (command === 'capture') await handleCapture(tab);
    else if (command === 'repeat') await togglePanel(tab);
    else if (command === 'select') await handleSelection(tab);
    else if (command === 'toggleAuto') await toggleMode(tab);
  } catch (err) {
    // Błędy zostały już pokazane przez fail()/reportFailure() — tutaj nic nie miga drugi raz.
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings: settings });
  const box = await chrome.storage.local.get('history');
  if (!Array.isArray(box.history)) await chrome.storage.local.set({ history: [] });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelFrames.delete(tabId);
  toggleAt.delete(tabId);
});
