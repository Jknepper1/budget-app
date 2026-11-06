'use strict';

/*
 * How data flows:
 * Every change (a purchase, a budget edit, and so on) goes into a queue saved on
 * the phone, then syncs to the Google Sheet in the background. What's on screen
 * is always the last data from the Sheet with the waiting changes applied on
 * top, so saving feels instant and works with no signal.
 */

const VERSION = '1.1.0';
const STARTER_CATEGORIES = ['Housing', 'Utilities', 'Groceries', 'Dining out', 'Gas', 'Insurance', 'Fun', 'Other'];
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_MS = 30000;
const TAB_REFRESH_MS = 30000;
const NEAR_LIMIT = 0.85;

const svg = (body, fill = 'none') =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  add: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  month: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  budget: svg('<path d="M5 4v6M5 14v6M12 4v2M12 10v10M19 4v9M19 17v3"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="15" r="2"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  forward: svg('<path d="M9 5l7 7-7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  backspace: svg('<path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
  over: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'),
};

/* ---------- Dates and money ---------- */

const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const thisMonth = () => today().slice(0, 7);
const monthOf = (date) => date.slice(0, 7);

function parseDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}

function shiftMonth(month, by) {
  const d = parseDate(month);
  d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const monthLong = (month) => parseDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const monthShort = (month) => parseDate(month).toLocaleDateString('en-US', { month: 'long' });
const dayShort = (date) => parseDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

const toCents = (dollars) => Math.round(Number(dollars) * 100);
const sumCents = (rows) => rows.reduce((total, row) => total + toCents(row.amount), 0);

/** Whole dollars drop the ".00" to keep summaries easy to scan. */
function fmt(cents) {
  const digits = cents % 100 === 0 ? 0 : 2;
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

const fmtExact = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function parseMoney(text) {
  const n = Number(String(text).replace(/[$,\s]/g, ''));
  return text !== '' && Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ---------- Storage on the phone ---------- */

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`budget.${key}`);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`budget.${key}`, JSON.stringify(value));
    } catch {
      toast('This phone is out of storage, so changes may not be kept.');
    }
  },
  clear() {
    ['config', 'queue', 'cache'].forEach((key) => {
      try { localStorage.removeItem(`budget.${key}`); } catch { /* nothing to clear */ }
    });
  },
};

const blankCache = () => ({ months: {}, bills: [], sheetUrl: '', syncedAt: 0 });
const blankAdd = () => ({ kind: 'purchase', amount: '', category: null, note: '', date: null });

const S = {
  config: store.get('config', null),
  queue: store.get('queue', []),
  cache: store.get('cache', blankCache()),
  tab: 'add',
  viewMonth: thisMonth(),
  openGroup: null,
  add: blankAdd(),
  syncing: false,
  syncAgain: false,
  syncError: null,
  renderWaiting: false,
};

let V = derive();

/* ---------- The on-screen view: Sheet data plus waiting changes ---------- */

function derive() {
  const view = JSON.parse(JSON.stringify({ months: S.cache.months, bills: S.cache.bills }));
  S.queue.forEach((op) => applyLocally(view, op));
  return view;
}

function monthIn(view, month) {
  if (!view.months[month]) view.months[month] = { purchases: [], income: [], budgets: null, prevIncome: null };
  return view.months[month];
}

/** Mirrors the Sheet's rule: a month with no budget of its own uses the latest earlier one. */
function budgetsIn(view, month) {
  const own = view.months[month] && view.months[month].budgets;
  if (own) return own;
  const earlier = Object.keys(view.months)
    .filter((m) => m < month && view.months[m].budgets)
    .sort()
    .pop();
  return earlier ? view.months[earlier].budgets : [];
}

function ownBudgets(view, month) {
  const entry = monthIn(view, month);
  if (!entry.budgets) entry.budgets = budgetsIn(view, month).map((b) => ({ ...b }));
  return entry.budgets;
}

function applyLocally(view, op) {
  const everyMonth = Object.values(view.months);
  switch (op.type) {
    case 'purchase.upsert':
    case 'income.upsert': {
      const list = op.type === 'purchase.upsert' ? 'purchases' : 'income';
      everyMonth.forEach((m) => { m[list] = m[list].filter((r) => r.id !== op.row.id); });
      monthIn(view, monthOf(op.row.date))[list].push({ ...op.row });
      break;
    }
    case 'purchase.delete':
      everyMonth.forEach((m) => { m.purchases = m.purchases.filter((r) => r.id !== op.id); });
      break;
    case 'income.delete':
      everyMonth.forEach((m) => { m.income = m.income.filter((r) => r.id !== op.id); });
      break;
    case 'budget.set': {
      const rows = ownBudgets(view, op.month);
      const row = rows.find((b) => b.category === op.category);
      if (row) row.amount = op.amount;
      else rows.push({ category: op.category, amount: op.amount });
      break;
    }
    case 'category.rename':
      everyMonth.forEach((m) => {
        (m.budgets || []).forEach((b) => { if (b.category === op.from) b.category = op.to; });
        m.purchases.forEach((p) => { if (p.category === op.from) p.category = op.to; });
      });
      view.bills.forEach((b) => { if (b.category === op.from) b.category = op.to; });
      break;
    case 'category.remove': {
      const entry = monthIn(view, op.month);
      entry.budgets = ownBudgets(view, op.month).filter((b) => b.category !== op.category);
      break;
    }
    case 'bill.upsert': {
      const existing = view.bills.find((b) => b.id === op.row.id);
      if (existing) Object.assign(existing, op.row);
      else view.bills.push({ ...op.row });
      break;
    }
    case 'bill.delete':
      view.bills = view.bills.filter((b) => b.id !== op.id);
      break;
    default:
      break;
  }
}

function monthSummary(month) {
  const entry = V.months[month] || { purchases: [], income: [] };
  const groups = new Map();
  budgetsIn(V, month).forEach((b) => {
    groups.set(b.category, { name: b.category, budget: toCents(b.amount), spent: 0, purchases: [], inBudget: true });
  });
  entry.purchases.forEach((p) => {
    if (!groups.has(p.category)) {
      groups.set(p.category, { name: p.category, budget: 0, spent: 0, purchases: [], inBudget: false });
    }
    const group = groups.get(p.category);
    group.spent += toCents(p.amount);
    group.purchases.push(p);
  });
  const rows = [...groups.values()];
  return {
    rows,
    purchases: entry.purchases,
    incomeRows: entry.income,
    income: sumCents(entry.income),
    spent: sumCents(entry.purchases),
    budgeted: rows.reduce((total, r) => total + r.budget, 0),
  };
}

function lastMonthIncome(month) {
  const own = V.months[month] && V.months[month].prevIncome;
  if (own != null) return toCents(own);
  const previous = V.months[shiftMonth(month, -1)];
  return previous ? sumCents(previous.income) : 0;
}

/* ---------- Saving and syncing ---------- */

/** Records a change. render: false is for screens that update themselves, like the budget list. */
function commit(op, { render: shouldRender = true } = {}) {
  S.queue.push({ ...op, opId: newId('op') });
  store.set('queue', S.queue);
  V = derive();
  if (shouldRender) render();
  else renderStatus();
  scheduleSync();
}

let syncTimer = null;
function scheduleSync(delay = 250) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function request(config, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // text/plain keeps the browser from sending a preflight check, which Apps Script can't answer.
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, passcode: config.passcode }),
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function sync() {
  if (!S.config) return;
  if (S.syncing) {
    S.syncAgain = true;
    return;
  }
  S.syncing = true;
  renderStatus();

  const ops = S.queue.slice(0, BATCH_SIZE);
  const months = [...new Set([thisMonth(), S.viewMonth])];
  try {
    const reply = await request(S.config, { ops, months });
    if (reply.ok) {
      const finished = new Set([...reply.done, ...reply.rejected.map((r) => r.opId)]);
      S.queue = S.queue.filter((op) => !finished.has(op.opId));
      store.set('queue', S.queue);
      Object.assign(S.cache.months, reply.months);
      S.cache.bills = reply.bills;
      S.cache.sheetUrl = reply.sheetUrl;
      S.cache.syncedAt = Date.now();
      store.set('cache', S.cache);
      S.syncError = null;
      if (reply.rejected.length) toast(`A change couldn't be saved: ${reply.rejected[0].error}`);
    } else {
      S.syncError = reply.error === 'bad_passcode' || reply.error === 'passcode_not_set' ? reply.error : 'server';
    }
  } catch {
    S.syncError = 'offline';
  }

  S.syncing = false;
  V = derive();
  renderWhenIdle();

  const networkProblem = S.syncError === 'offline' || S.syncError === 'server';
  if (networkProblem) {
    if (S.queue.length) scheduleSync(RETRY_MS);
  } else if (!S.syncError && (S.syncAgain || S.queue.length)) {
    scheduleSync(0);
  }
  S.syncAgain = false;
}

/* ---------- Building the page ---------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'icon') el.innerHTML = value; // Only ever the fixed ICONS above.
    else if (key in el && !key.includes('-')) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  });
  children.flat(Infinity).forEach((child) => {
    if (child != null && child !== false) el.append(child);
  });
  return el;
}

const byId = (id) => document.getElementById(id);

function isTypingInView() {
  const view = byId('view');
  const active = document.activeElement;
  return !!(view && active && view.contains(active) && active.matches('input, select'));
}

/** Background updates wait until you've finished typing, so they never steal your cursor. */
function renderWhenIdle() {
  if (isTypingInView()) {
    S.renderWaiting = true;
    renderStatus();
  } else {
    render();
  }
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.renderWaiting && !isTypingInView()) {
      S.renderWaiting = false;
      render();
    }
  }, 150);
});

function render() {
  S.renderWaiting = false;
  const root = byId('app');
  const previous = byId('view');
  const scroll = previous && previous.dataset.tab === S.tab ? previous.scrollTop : 0;

  if (!S.config) {
    root.replaceChildren(viewConnect());
    return;
  }

  const content = { add: viewAdd, month: viewMonth, budget: viewBudget }[S.tab]();
  content.id = 'view';
  content.dataset.tab = S.tab;
  root.replaceChildren(viewTopbar(), content, viewNav());
  content.scrollTop = scroll;
  renderStatus();
}

function viewTopbar() {
  const titles = { add: 'Add', month: 'This Month', budget: `${monthShort(thisMonth())} Budget` };
  return h('header', { class: 'topbar' },
    h('h1', {}, titles[S.tab]),
    h('button', { class: 'status', id: 'status', onclick: statusTapped }),
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', icon: ICONS.settings, onclick: openSettings }));
}

function statusText() {
  const waiting = S.queue.length;
  if (S.syncError === 'bad_passcode') return 'Passcode rejected';
  if (S.syncError === 'passcode_not_set') return 'Passcode not set';
  if (S.syncing) return waiting ? 'Saving…' : 'Updating…';
  if (waiting) return `${waiting} waiting to sync`;
  if (S.syncError) return 'Offline';
  return '';
}

function renderStatus() {
  const el = byId('status');
  if (!el) return;
  el.textContent = statusText();
  el.classList.toggle('alert', S.syncError === 'bad_passcode' || S.syncError === 'passcode_not_set');
}

function statusTapped() {
  if (S.syncError === 'bad_passcode' || S.syncError === 'passcode_not_set') openSettings();
  else scheduleSync(0);
}

function viewNav() {
  const tabs = [['add', 'Add', ICONS.add], ['month', 'This Month', ICONS.month], ['budget', 'Budget', ICONS.budget]];
  return h('nav', { class: 'nav', 'aria-label': 'Screens' }, tabs.map(([tab, label, icon]) =>
    h('button', { 'aria-current': S.tab === tab ? 'page' : null, onclick: () => goTo(tab) },
      h('span', { icon }), label)));
}

function goTo(tab) {
  document.activeElement?.blur();
  S.tab = tab;
  if (tab === 'month') S.viewMonth = thisMonth();
  render();
  // Switching screens often shouldn't mean a slow trip to Google every time.
  if (S.queue.length || Date.now() - S.cache.syncedAt > TAB_REFRESH_MS) scheduleSync(0);
}

let toastTimer = null;
function toast(message, undo) {
  const host = byId('toast');
  clearTimeout(toastTimer);
  const hide = () => host.replaceChildren();
  host.replaceChildren(h('div', { class: 'toast-body' },
    h('span', {}, message),
    undo && h('button', { onclick: () => { hide(); undo(); } }, 'Undo')));
  toastTimer = setTimeout(hide, undo ? 6000 : 3500);
}

function openSheet(title, buildBody) {
  const dialog = h('dialog', { class: 'sheet' });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', icon: ICONS.close, onclick: close })),
    buildBody(close),
  );
  dialog.addEventListener('cancel', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  document.body.append(dialog);
  dialog.showModal();
}

function field(label, control) {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

/* ---------- Connect screen ---------- */

function validScriptUrl(text) {
  try {
    const url = new URL(text);
    if (url.origin === location.origin && location.hostname === 'localhost') return true;
    return url.protocol === 'https:' && url.hostname === 'script.google.com' && url.pathname.endsWith('/exec');
  } catch {
    return false;
  }
}

function viewConnect() {
  const url = h('input', { type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'https://script.google.com/…/exec' });
  const passcode = h('input', { type: 'password', autocomplete: 'off' });
  const who = h('input', { type: 'text', autocomplete: 'given-name', maxLength: 40 });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'primary', onclick: connect }, 'Connect');

  async function connect() {
    const config = { url: url.value.trim(), passcode: passcode.value, who: who.value.trim() };
    error.textContent = '';
    if (!validScriptUrl(config.url)) {
      error.textContent = 'That doesn\'t look right. The web app address starts with https://script.google.com/ and ends in /exec.';
      return;
    }
    if (!config.passcode) { error.textContent = 'Enter your passcode.'; return; }
    if (!config.who) { error.textContent = 'Enter your name.'; return; }

    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      const reply = await request(config, { ops: [], months: [thisMonth()] });
      if (reply.ok) {
        S.config = config;
        store.set('config', config);
        Object.assign(S.cache.months, reply.months);
        S.cache.bills = reply.bills;
        S.cache.sheetUrl = reply.sheetUrl;
        S.cache.syncedAt = Date.now();
        store.set('cache', S.cache);
        V = derive();
        S.tab = budgetsIn(V, thisMonth()).length ? 'add' : 'budget';
        render();
        return;
      }
      error.textContent = reply.error === 'bad_passcode'
        ? 'That passcode doesn\'t match the one in your script.'
        : reply.error === 'passcode_not_set'
          ? 'The script still has its placeholder passcode. Change it, then deploy a new version.'
          : 'The script ran into a problem. Try again in a minute.';
    } catch {
      error.textContent = 'Couldn\'t reach your script. Check your signal and the address, and that "Who has access" is set to "Anyone".';
    }
    button.disabled = false;
    button.textContent = 'Connect';
  }

  return h('main', { class: 'setup' },
    h('h1', {}, 'Connect your budget'),
    h('p', {}, 'You only need to do this once on each phone.'),
    field('Web app address', url),
    field('Passcode', passcode),
    field('Your name', who),
    error,
    button);
}

/* ---------- Add screen ---------- */

function displayAmount(text) {
  if (!text) return '$0';
  const [whole, decimals] = text.split('.');
  const grouped = Number(whole).toLocaleString('en-US');
  return decimals === undefined ? `$${grouped}` : `$${grouped}.${decimals}`;
}

/** What's still needed before this entry can be saved, or null if it's ready. */
function missingForSave() {
  const { kind, amount, category, note } = S.add;
  if (toCents(amount || 0) <= 0) return 'Enter an amount';
  if (kind === 'income') return null;
  if (!category) return 'Choose a category';
  if (!note.trim()) return 'Add a description';
  return null;
}

/** Where a category stands, or null if that month has no budget for it. */
function budgetStanding(category, month, extraCents = 0) {
  const group = monthSummary(month).rows.find((r) => r.name === category);
  if (!group || !group.inBudget) return null;
  const left = group.budget - group.spent - extraCents;
  return left >= 0 ? `${fmt(left)} left in ${category}` : `${fmt(-left)} over in ${category}`;
}

function addHint() {
  const { kind, category, amount, date } = S.add;
  if (kind !== 'purchase' || !category) return '';
  const entered = toCents(amount || 0);
  const standing = budgetStanding(category, monthOf(date || today()), entered);
  if (!standing) return '';
  return entered ? `${standing} after this` : standing;
}

function updateAdd() {
  const { amount, date, category } = S.add;
  const display = byId('amount');
  if (!display) return;
  display.textContent = displayAmount(amount);
  display.classList.toggle('empty', !amount);
  byId('hint').textContent = addHint();
  byId('date-label').textContent = date ? dayShort(date) : 'Today';
  const missing = missingForSave();
  const save = byId('save');
  save.disabled = !!missing;
  save.textContent = missing || (S.add.kind === 'income' ? 'Save income' : 'Save purchase');
  document.querySelectorAll('.chip').forEach((chip) => {
    const on = chip.dataset.cat === category;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  });
}

function pressKey(key) {
  let { amount } = S.add;
  if (key === 'back') {
    amount = amount.slice(0, -1);
  } else if (key === '.') {
    if (!amount.includes('.')) amount = amount ? `${amount}.` : '0.';
  } else {
    const [whole, decimals] = amount.split('.');
    if (decimals !== undefined) {
      if (decimals.length < 2) amount += key;
    } else if (whole === '0') {
      amount = key;
    } else if (whole.length < 7) {
      amount += key;
    }
  }
  S.add.amount = amount;
  updateAdd();
}

function saveAdd() {
  if (missingForSave()) return;
  document.activeElement?.blur();
  const { kind, amount, category, note, date } = S.add;
  const cents = toCents(amount);
  const base = {
    amount: cents / 100,
    date: date || today(),
    note: note.trim(),
    who: S.config.who,
  };
  S.add = blankAdd();

  if (kind === 'income') {
    const row = { ...base, id: newId('i') };
    commit({ type: 'income.upsert', row });
    toast(`Saved ${fmtExact(cents)} income`, () => commit({ type: 'income.delete', id: row.id }));
    return;
  }

  const row = { ...base, id: newId('p'), category, source: 'manual' };
  commit({ type: 'purchase.upsert', row });
  const standing = budgetStanding(category, monthOf(row.date));
  toast(standing ? `Saved. ${standing}` : 'Saved', () => commit({ type: 'purchase.delete', id: row.id }));
}

function viewAdd() {
  const add = S.add;
  const isIncome = add.kind === 'income';
  const categories = budgetsIn(V, thisMonth()).map((b) => b.category);
  if (add.category && !categories.includes(add.category)) add.category = null;

  const setKind = (kind) => {
    add.kind = kind;
    render();
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

  let middle;
  if (isIncome) {
    const received = monthSummary(thisMonth()).income;
    middle = h('div', { class: 'add-empty' }, `${fmt(received)} received so far in ${monthShort(thisMonth())}`);
  } else if (categories.length) {
    middle = h('div', { class: 'chips' }, categories.map((name) =>
      h('button', {
        class: 'chip',
        'data-cat': name,
        onclick: () => {
          add.category = add.category === name ? null : name;
          updateAdd();
        },
      }, name)));
  } else {
    middle = h('div', { class: 'add-empty' },
      'Set up your categories first.',
      h('button', { class: 'text-btn', onclick: () => goTo('budget') }, 'Go to Budget'));
  }

  const content = h('main', { class: 'view add' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type of entry' },
      h('button', { 'aria-pressed': String(!isIncome), onclick: () => setKind('purchase') }, 'Purchase'),
      h('button', { 'aria-pressed': String(isIncome), onclick: () => setKind('income') }, 'Income')),
    h('div', { class: 'amount', id: 'amount', 'aria-live': 'polite' }),
    h('div', { class: 'hint', id: 'hint' }),
    h('div', { class: 'add-meta' },
      h('label', { class: 'date-pill' },
        h('span', { id: 'date-label' }),
        h('span', { icon: ICONS.down }),
        h('input', {
          type: 'date',
          'aria-label': 'Date',
          value: add.date || today(),
          max: today(),
          onchange: (event) => {
            const value = event.target.value;
            add.date = value && value !== today() ? value : null;
            updateAdd();
          },
        })),
      h('input', {
        class: 'input note',
        type: 'text',
        placeholder: isIncome ? 'Source (optional)' : 'Description',
        'aria-label': isIncome ? 'Source' : 'Description',
        required: !isIncome,
        maxLength: 200,
        enterkeyhint: 'done',
        value: add.note,
        oninput: (event) => {
          add.note = event.target.value;
          updateAdd();
        },
        onkeydown: (event) => { if (event.key === 'Enter') event.target.blur(); },
      })),
    middle,
    h('div', { class: 'keypad' }, keys.map((key) =>
      h('button', {
        'aria-label': key === 'back' ? 'Delete' : null,
        icon: key === 'back' ? ICONS.backspace : null,
        onclick: () => pressKey(key),
      }, key === 'back' ? null : key))),
    h('button', { class: 'primary', id: 'save', onclick: saveAdd }));

  // updateAdd finds elements by id, so run it once this screen is on the page.
  queueMicrotask(updateAdd);
  return content;
}

/* ---------- This Month screen ---------- */

const newestFirst = (rows) => [...rows].reverse().sort((a, b) => b.date.localeCompare(a.date));

function meter(fraction, state) {
  const width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  return h('div', { class: `meter ${state}`, 'aria-hidden': 'true' }, h('div', { style: { width } }));
}

function budgetState(spent, budget) {
  if (spent > budget) return 'over';
  // Landing exactly on budget is fine: a mortgage equal to its category shouldn't warn every month.
  if (budget > 0 && spent < budget && spent / budget >= NEAR_LIMIT) return 'warn';
  return 'ok';
}

function stateIcon(state) {
  if (state === 'ok') return null;
  return h('span', { class: `state-icon ${state}`, icon: state === 'over' ? ICONS.over : ICONS.warn });
}

function toggleGroup(id) {
  S.openGroup = S.openGroup === id ? null : id;
  render();
}

function txnList(rows, kind) {
  return h('div', { class: 'txns' }, newestFirst(rows).map((row) => {
    const title = row.note || row.category || 'Income';
    const meta = [dayShort(row.date), row.source === 'auto' ? 'Added automatically' : row.who]
      .filter(Boolean).join(' · ');
    const extra = kind === 'purchase' && row.note ? `${row.category} · ` : '';
    return h('button', { class: 'txn', onclick: () => openTxnEditor(kind, row) },
      h('span', { class: 'txn-main' },
        h('span', { class: 'txn-title' }, title),
        h('span', { class: 'txn-meta' }, `${S.openGroup === 'all' ? extra : ''}${meta}`)),
      h('span', { class: 'txn-amt' }, fmtExact(toCents(row.amount))));
  }));
}

function categoryGroup(group) {
  const id = `cat:${group.name}`;
  const open = S.openGroup === id;
  const left = group.budget - group.spent;
  const state = group.inBudget ? budgetState(group.spent, group.budget) : 'ok';

  const value = !group.inBudget
    ? `${fmt(group.spent)} spent`
    : left >= 0 ? `${fmt(left)} left` : `${fmt(-left)} over`;
  const sub = group.inBudget ? `${fmt(group.spent)} of ${fmt(group.budget)}` : 'Not in this month\'s budget';
  const fraction = group.budget > 0 ? group.spent / group.budget : (group.spent > 0 ? 1 : 0);

  return h('div', { class: 'group' },
    h('button', { class: 'row', 'aria-expanded': String(open), onclick: () => toggleGroup(id) },
      h('span', { class: 'row-line' },
        h('span', { class: 'row-name' }, group.name),
        h('span', { class: 'row-value' }, stateIcon(state), value)),
      group.inBudget && meter(fraction, state),
      h('span', { class: 'row-sub' }, sub)),
    open && (group.purchases.length
      ? txnList(group.purchases, 'purchase')
      : h('div', { class: 'txns' }, h('p', { class: 'empty-note' }, 'No purchases yet'))));
}

function viewMonth() {
  const month = S.viewMonth;
  const isCurrent = month === thisMonth();
  const summary = monthSummary(month);
  const known = !!S.cache.months[month] || !!V.months[month];
  const left = summary.income - summary.spent;

  const changeMonth = (by) => {
    S.viewMonth = shiftMonth(S.viewMonth, by);
    S.openGroup = null;
    render();
    scheduleSync(0);
  };

  const header = h('div', { class: 'month-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous month', icon: ICONS.back, onclick: () => changeMonth(-1) }),
    h('strong', {}, monthLong(month)),
    h('button', { class: 'icon-btn', 'aria-label': 'Next month', icon: ICONS.forward, disabled: isCurrent, onclick: () => changeMonth(1) }));

  if (!known) {
    return h('main', { class: 'view' }, header,
      h('div', { class: 'card' }, h('p', { class: 'empty-note' }, S.syncError ? 'This month isn\'t saved on this phone. It will load when you\'re back online.' : 'Loading…')));
  }

  // Before the first paycheck of the month, "over income" would be alarming and not useful.
  const noIncomeYet = isCurrent && summary.income === 0;
  let heroLabel = isCurrent ? 'Left this month' : 'Left over';
  if (noIncomeYet) heroLabel = 'Spent so far';
  else if (left < 0) heroLabel = isCurrent ? 'Over income so far by' : 'Over income by';

  const overallState = budgetState(summary.spent, summary.budgeted);
  const groupsCard = summary.rows.length
    ? summary.rows.map(categoryGroup)
    : h('p', { class: 'empty-note' }, isCurrent ? 'Set up categories on the Budget screen.' : 'No budget or purchases this month.');

  return h('main', { class: 'view' },
    header,
    h('section', { class: 'card hero' },
      h('div', { class: 'hero-label' }, heroLabel),
      h('div', { class: 'hero-value' }, fmt(Math.abs(left))),
      h('div', { class: 'stats' },
        h('div', {}, h('b', {}, fmt(summary.income)), isCurrent ? 'Income so far' : 'Income'),
        h('div', {}, h('b', {}, fmt(summary.spent)), 'Spent')),
      summary.budgeted > 0 && h('div', { class: 'overall' },
        h('p', {}, `${fmt(summary.spent)} of ${fmt(summary.budgeted)} budgeted`),
        meter(summary.spent / summary.budgeted, overallState))),
    h('h2', { class: 'section-title' }, 'Categories'),
    h('section', { class: 'card' }, groupsCard),
    h('h2', { class: 'section-title' }, 'History'),
    h('section', { class: 'card' },
      h('div', { class: 'group' },
        h('button', { class: 'row', 'aria-expanded': String(S.openGroup === 'all'), onclick: () => toggleGroup('all') },
          h('span', { class: 'row-plain' }, h('span', { class: 'row-name' }, 'All purchases'), h('span', { class: 'row-value' }, String(summary.purchases.length)))),
        S.openGroup === 'all' && summary.purchases.length > 0 && txnList(summary.purchases, 'purchase')),
      h('div', { class: 'group' },
        h('button', { class: 'row', 'aria-expanded': String(S.openGroup === 'income'), onclick: () => toggleGroup('income') },
          h('span', { class: 'row-plain' }, h('span', { class: 'row-name' }, 'Income'), h('span', { class: 'row-value' }, String(summary.incomeRows.length)))),
        S.openGroup === 'income' && summary.incomeRows.length > 0 && txnList(summary.incomeRows, 'income'))));
}

function openTxnEditor(kind, row) {
  const isIncome = kind === 'income';
  openSheet(isIncome ? 'Edit income' : 'Edit purchase', (close) => {
    const amount = h('input', { type: 'text', inputmode: 'decimal', value: (toCents(row.amount) / 100).toFixed(2) });
    const date = h('input', { type: 'date', value: row.date, max: today() });
    const note = h('input', { type: 'text', value: row.note || '', maxLength: 200 });
    const error = h('p', { class: 'form-error', role: 'alert' });

    let category = null;
    if (!isIncome) {
      const names = budgetsIn(V, monthOf(row.date)).map((b) => b.category);
      if (!names.includes(row.category)) names.push(row.category);
      category = h('select', {}, names.map((name) => h('option', { value: name, selected: name === row.category }, name)));
    }

    const save = () => {
      const value = parseMoney(amount.value);
      if (!Number.isFinite(value) || value === 0) { error.textContent = 'Enter an amount.'; return; }
      if (!date.value) { error.textContent = 'Choose a date.'; return; }
      if (!isIncome && !note.value.trim()) { error.textContent = 'Enter a description.'; return; }
      const updated = { ...row, amount: value, date: date.value, note: note.value.trim() };
      if (!isIncome) updated.category = category.value;
      close();
      commit({ type: `${kind}.upsert`, row: updated });
    };

    const remove = () => {
      close();
      commit({ type: `${kind}.delete`, id: row.id });
      toast(isIncome ? 'Income deleted' : 'Purchase deleted', () => commit({ type: `${kind}.upsert`, row }));
    };

    return h('div', {},
      h('div', { class: 'field-pair' }, field('Amount', amount), field('Date', date)),
      !isIncome && field('Category', category),
      field(isIncome ? 'Source' : 'Description', note),
      error,
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { class: 'danger-btn', onclick: remove }, 'Delete'));
  });
}

/* ---------- Budget screen ---------- */

const plainAmount = (dollars) => {
  const cents = toCents(dollars);
  return cents === 0 ? '' : String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
};

function updateBudgetTotals() {
  const budgetedEl = byId('b-budgeted');
  if (!budgetedEl) return;
  const budgeted = [...document.querySelectorAll('.b-amt')].reduce((total, input) => {
    const value = parseMoney(input.value);
    return total + (Number.isFinite(value) && value > 0 ? toCents(value) : 0);
  }, 0);
  const left = monthSummary(thisMonth()).income - budgeted;
  budgetedEl.textContent = fmt(budgeted);
  byId('b-left').textContent = left < 0 ? `-${fmt(-left)}` : fmt(left);
}

function budgetRow(start) {
  const month = thisMonth();
  let current = start.category;

  const name = h('input', {
    type: 'text',
    placeholder: 'Category name',
    'aria-label': 'Category name',
    maxLength: 60,
    enterkeyhint: 'next',
    value: current,
    onkeydown: (event) => { if (event.key === 'Enter') amount.focus(); },
    onchange: () => {
      const value = name.value.trim();
      if (value === current) { name.value = current; return; }
      if (!value) {
        name.value = current;
        if (current) toast('A category needs a name.');
        return;
      }
      const taken = budgetsIn(V, month).some((b) =>
        b.category !== current && b.category.toLowerCase() === value.toLowerCase());
      if (taken) {
        name.value = current;
        toast(`You already have a category called ${value}.`);
        return;
      }
      if (current) {
        commit({ type: 'category.rename', from: current, to: value }, { render: false });
        if (S.add.category === current) S.add.category = value;
      } else {
        const typed = parseMoney(amount.value);
        commit({ type: 'budget.set', month, category: value, amount: Number.isFinite(typed) && typed > 0 ? typed : 0 }, { render: false });
      }
      current = value;
      name.value = value;
    },
  });

  const amount = h('input', {
    class: 'b-amt',
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0',
    enterkeyhint: 'done',
    'aria-label': 'Monthly amount',
    value: plainAmount(start.amount),
    oninput: updateBudgetTotals,
    onkeydown: (event) => { if (event.key === 'Enter') amount.blur(); },
    onchange: () => {
      const text = amount.value.trim();
      const value = text === '' ? 0 : parseMoney(text);
      if (!Number.isFinite(value) || value < 0) {
        const saved = budgetsIn(V, month).find((b) => b.category === current);
        amount.value = saved ? plainAmount(saved.amount) : '';
        toast('Enter a dollar amount, like 250.');
        updateBudgetTotals();
        return;
      }
      amount.value = plainAmount(value);
      if (current) commit({ type: 'budget.set', month, category: current, amount: value }, { render: false });
      updateBudgetTotals();
    },
  });

  const row = h('div', { class: 'budget-row' },
    name,
    h('label', { class: 'money-input' }, amount),
    h('button', {
      class: 'icon-btn remove',
      'aria-label': 'Remove category',
      icon: ICONS.close,
      onclick: () => {
        if (!current) { row.remove(); return; }
        const budgets = budgetsIn(V, month);
        if (budgets.length <= 1) {
          toast('Keep at least one category. You can rename this one instead.');
          return;
        }
        const saved = budgets.find((b) => b.category === current);
        const removedName = current;
        const removedAmount = saved ? saved.amount : 0;
        document.activeElement?.blur();
        commit({ type: 'category.remove', month, category: removedName });
        toast(`Removed ${removedName}`, () => commit({ type: 'budget.set', month, category: removedName, amount: removedAmount }));
      },
    }));
  row.focusName = () => name.focus();
  return row;
}

function viewBudget() {
  const month = thisMonth();
  const summary = monthSummary(month);
  const budgets = budgetsIn(V, month);
  const previous = lastMonthIncome(month);
  const left = summary.income - summary.budgeted;

  const list = h('div', { id: 'b-list' }, budgets.map(budgetRow));

  const addStarters = () => {
    STARTER_CATEGORIES.forEach((category) => commit({ type: 'budget.set', month, category, amount: 0 }, { render: false }));
    render();
  };

  return h('main', { class: 'view' },
    h('section', { class: 'card totals' },
      h('div', { class: 'totals-row' }, h('span', {}, 'Income so far'), h('span', {}, fmt(summary.income))),
      h('div', { class: 'totals-row' }, h('span', {}, 'Budgeted'), h('span', { id: 'b-budgeted' }, fmt(summary.budgeted))),
      h('div', { class: 'totals-row main' }, h('span', {}, 'Left to assign'), h('span', { id: 'b-left' }, left < 0 ? `-${fmt(-left)}` : fmt(left))),
      previous > 0 && h('p', { class: 'totals-note' }, `Last month's income was ${fmt(previous)}.`)),

    h('h2', { class: 'section-title' }, 'Categories'),
    h('section', { class: 'card' },
      budgets.length === 0 && h('div', { class: 'starter', id: 'b-starter' },
        h('p', {}, 'Start with a common set, or add your own below.'),
        h('button', { class: 'text-btn', onclick: addStarters }, 'Add common categories')),
      list),
    h('button', {
      class: 'text-btn',
      onclick: () => {
        const starter = byId('b-starter');
        if (starter) starter.remove();
        const row = budgetRow({ category: '', amount: 0 });
        list.append(row);
        row.focusName();
      },
    }, '+ Add category'),

    h('h2', { class: 'section-title' }, 'Monthly bills'),
    h('p', { class: 'section-note' }, 'Recorded automatically on their day and counted in their category.'),
    V.bills.length > 0 && h('section', { class: 'card' }, [...V.bills]
      .sort((a, b) => a.day - b.day)
      .map((bill) => h('button', { class: 'row', onclick: () => openBillEditor(bill) },
        h('span', { class: 'row-line' },
          h('span', { class: 'row-name' }, bill.name),
          h('span', { class: 'row-value' }, fmtExact(toCents(bill.amount)))),
        h('span', { class: 'row-sub' }, `${bill.category} · on the ${ordinal(bill.day)}`)))),
    h('button', { class: 'text-btn', onclick: () => openBillEditor(null) }, '+ Add bill'));
}

function openBillEditor(bill) {
  const categories = budgetsIn(V, thisMonth()).map((b) => b.category);
  if (bill && !categories.includes(bill.category)) categories.push(bill.category);
  if (!categories.length) {
    toast('Add a category first.');
    return;
  }

  openSheet(bill ? 'Edit bill' : 'Add bill', (close) => {
    const month = thisMonth();
    const name = h('input', { type: 'text', maxLength: 60, placeholder: 'Mortgage', value: bill ? bill.name : '' });
    const amount = h('input', { type: 'text', inputmode: 'decimal', value: bill ? plainAmount(bill.amount) : '' });
    const category = h('select', {}, categories.map((c) =>
      h('option', { value: c, selected: !!bill && c === bill.category }, c)));
    const day = h('select', { onchange: updateCheck }, Array.from({ length: 31 }, (_, i) =>
      h('option', { value: i + 1, selected: (bill ? bill.day : 1) === i + 1 }, ordinal(i + 1))));
    const error = h('p', { class: 'form-error', role: 'alert' });

    const addNow = h('input', { type: 'checkbox', checked: true });
    const check = h('label', { class: 'check' }, addNow, h('span', {}, `Also record it for ${monthShort(month)}`));

    /** A new bill whose day already passed this month might already be paid, so ask. */
    function dayHasPassed() {
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      return Math.min(Number(day.value), lastDay) <= new Date().getDate();
    }

    function updateCheck() {
      check.style.display = !bill && dayHasPassed() ? '' : 'none';
    }
    updateCheck();

    const save = () => {
      const value = parseMoney(amount.value);
      if (!name.value.trim()) { error.textContent = 'Enter a name.'; return; }
      if (!Number.isFinite(value) || value <= 0) { error.textContent = 'Enter an amount.'; return; }
      const startsNextMonth = !bill && dayHasPassed() && !addNow.checked;
      const row = {
        id: bill ? bill.id : newId('b'),
        name: name.value.trim(),
        amount: value,
        category: category.value,
        day: Number(day.value),
        start_month: bill ? bill.start_month : (startsNextMonth ? shiftMonth(month, 1) : month),
      };
      close();
      commit({ type: 'bill.upsert', row });
    };

    const remove = () => {
      close();
      commit({ type: 'bill.delete', id: bill.id });
      toast(`Removed ${bill.name}. Past purchases stay.`, () => commit({ type: 'bill.upsert', row: bill }));
    };

    return h('div', {},
      field('Name', name),
      h('div', { class: 'field-pair' }, field('Amount', amount), field('Day of the month', day)),
      field('Category', category),
      check,
      error,
      h('button', { class: 'primary', onclick: save }, 'Save'),
      bill && h('button', { class: 'danger-btn', onclick: remove }, 'Delete bill'));
  });
}

/* ---------- Settings ---------- */

function openSettings() {
  openSheet('Settings', (close) => {
    const who = h('input', {
      type: 'text',
      maxLength: 40,
      value: S.config.who,
      onchange: () => {
        const value = who.value.trim();
        if (!value) { who.value = S.config.who; return; }
        S.config.who = value;
        store.set('config', S.config);
      },
    });

    const passcode = h('input', {
      type: 'password',
      autocomplete: 'off',
      value: S.config.passcode,
      onchange: () => {
        if (!passcode.value) { passcode.value = S.config.passcode; return; }
        S.config.passcode = passcode.value;
        store.set('config', S.config);
        S.syncError = null;
        scheduleSync(0);
      },
    });

    const waiting = S.queue.length;
    let armed = false;
    const disconnect = h('button', {
      class: 'danger-btn',
      onclick: () => {
        if (!armed) {
          armed = true;
          disconnect.textContent = waiting
            ? `Tap again. ${waiting} unsynced change${waiting === 1 ? '' : 's'} will be lost.`
            : 'Tap again to disconnect';
          return;
        }
        store.clear();
        S.config = null;
        S.queue = [];
        S.cache = blankCache();
        S.add = blankAdd();
        S.syncError = null;
        V = derive();
        close();
        render();
      },
    }, 'Disconnect this phone');

    const lastSync = S.cache.syncedAt
      ? new Date(S.cache.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'not yet';

    return h('div', {},
      field('Your name', who),
      field('Passcode', passcode),
      S.cache.sheetUrl && h('a', { class: 'setting-link', href: S.cache.sheetUrl, target: '_blank', rel: 'noopener' }, 'Open the Google Sheet'),
      h('button', { class: 'setting-link', onclick: () => { close(); scheduleSync(0); } }, 'Sync now'),
      h('p', { class: 'setting-note' }, `Last synced: ${lastSync}. ${waiting ? `${waiting} waiting to sync.` : 'Nothing waiting.'} Version ${VERSION}.`),
      disconnect);
  });
}

/* ---------- Start up ---------- */

function start() {
  render();
  if (S.config) sync();

  window.addEventListener('online', () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  });

  const allowServiceWorker = location.protocol === 'https:' || new URLSearchParams(location.search).has('sw');
  if ('serviceWorker' in navigator && allowServiceWorker) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
