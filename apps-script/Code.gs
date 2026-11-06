/**
 * BUDGET APP BACKEND
 * Lives inside your Google Sheet and is the only thing that reads or writes it.
 * Full setup steps are in the project's README.
 *
 * The line below limits this script to this one spreadsheet. It cannot see
 * any of your other Google files.
 * @OnlyCurrentDoc
 */

// >>> Change this to your own passcode before running setup. <<<
const PASSCODE = 'CHANGE-ME';

const UNSET_PASSCODE = 'CHANGE-ME';

const TABS = {
  Purchases: ['Date', 'Amount', 'Category', 'Note', 'Who', 'Source', 'Created', 'ID'],
  Income: ['Date', 'Amount', 'Note', 'Who', 'Created', 'ID'],
  Budgets: ['Month', 'Category', 'Amount'],
  Bills: ['Name', 'Amount', 'Category', 'Day', 'Start Month', 'Last Posted', 'ID'],
};

// Any column not listed here is plain text, so Sheets won't turn a note like
// "5/6" into a date.
const COLUMN_FORMATS = { date: 'yyyy-mm-dd', amount: '$#,##0.00', day: '0' };

/* ---------- Run once from the editor ---------- */

function setup() {
  if (PASSCODE === UNSET_PASSCODE) {
    throw new Error('Change PASSCODE at the top of this file first, then run setup again.');
  }
  Object.keys(TABS).forEach(sheet_);

  const ss = ss_();
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const hasTrigger = ScriptApp.getProjectTriggers()
    .some((t) => t.getHandlerFunction() === 'dailyBills');
  if (!hasTrigger) {
    ScriptApp.newTrigger('dailyBills').timeBased().everyDays(1).atHour(1).create();
  }
  Logger.log('Setup finished. Next step: Deploy > New deployment.');
}

/** Runs on the daily timer so bills land in the Sheet even if nobody opens the app. */
function dailyBills() {
  withLock_(postDueBills_);
}

/* ---------- Web app entry points ---------- */

/** Open the web address in a browser to check the deployment. Shows no budget data. */
function doGet() {
  try {
    return json_({ ok: !!ss_().getId(), app: 'budget', passcodeSet: PASSCODE !== UNSET_PASSCODE });
  } catch (err) {
    return json_({ ok: false, app: 'budget', error: String(err) });
  }
}

function doPost(e) {
  try {
    if (PASSCODE === UNSET_PASSCODE) return json_({ ok: false, error: 'passcode_not_set' });
    const req = JSON.parse(e.postData.contents);
    if (req.passcode !== PASSCODE) return json_({ ok: false, error: 'bad_passcode' });
    return json_(sync_(req));
  } catch (err) {
    return json_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Applies the phone's waiting changes, then returns the latest data.
 * A change with bad data is reported and dropped. Any other failure (such as
 * Sheets being briefly unavailable) fails the whole request, so the phone keeps
 * its changes and retries. Every change is safe to apply twice.
 */
function sync_(req) {
  return withLock_(() => {
    const done = [];
    const rejected = [];
    (req.ops || []).forEach((op) => {
      try {
        applyOp_(op);
        done.push(op.opId);
      } catch (err) {
        if (!err.badOp) throw err;
        rejected.push({ opId: op.opId, error: err.message });
      }
    });
    postDueBills_();
    return Object.assign({ ok: true, done, rejected }, snapshot_(req.months || []));
  });
}

function applyOp_(op) {
  switch (op.type) {
    case 'purchase.upsert': return upsert_('Purchases', cleanPurchase_(op.row));
    case 'purchase.delete': return removeById_('Purchases', op.id);
    case 'income.upsert': return upsert_('Income', cleanIncome_(op.row));
    case 'income.delete': return removeById_('Income', op.id);
    case 'budget.set':
      return setBudget_(needMonth_(op.month), needText_(op.category, 'category', 60), needAmount_(op.amount));
    case 'category.rename':
      return renameCategory_(needText_(op.from, 'category', 60), needText_(op.to, 'category', 60));
    case 'category.remove':
      return removeCategory_(needMonth_(op.month), needText_(op.category, 'category', 60));
    case 'bill.upsert': return upsert_('Bills', cleanBill_(op.row));
    case 'bill.delete': return removeById_('Bills', op.id);
    default: return bad_('Unknown change: ' + op.type);
  }
}

/* ---------- Reading data for the app ---------- */

function snapshot_(months) {
  const purchases = read_('Purchases').rows.filter((r) => r.id && r.date && r.amount);
  const income = read_('Income').rows.filter((r) => r.id && r.date && r.amount);
  const budgets = read_('Budgets').rows.filter((r) => r.month && r.category);
  const bills = read_('Bills').rows.filter((r) => r.id && r.name);

  const data = {};
  months.filter((m) => /^\d{4}-\d{2}$/.test(m)).slice(0, 3).forEach((month) => {
    const previous = prevMonth_(month);
    data[month] = {
      purchases: purchases.filter((r) => r.date.slice(0, 7) === month).map(publicPurchase_),
      income: income.filter((r) => r.date.slice(0, 7) === month).map(publicIncome_),
      budgets: effectiveBudgets_(budgets, month),
      prevIncome: round2_(income
        .filter((r) => r.date.slice(0, 7) === previous)
        .reduce((sum, r) => sum + r.amount, 0)),
    };
  });

  return { months: data, bills: bills.map(publicBill_), sheetUrl: ss_().getUrl() };
}

function publicPurchase_(r) {
  return { id: r.id, date: r.date, amount: r.amount, category: r.category, note: r.note, who: r.who, source: r.source || 'manual' };
}

function publicIncome_(r) {
  return { id: r.id, date: r.date, amount: r.amount, note: r.note, who: r.who };
}

function publicBill_(r) {
  return { id: r.id, name: r.name, amount: r.amount, category: r.category, day: r.day, start_month: r.start_month, last_posted: r.last_posted };
}

/** A month without its own budget rows uses the most recent earlier month's. */
function effectiveRows_(rows, month) {
  const source = rows.reduce((best, r) => (r.month <= month && r.month > best ? r.month : best), '');
  return source ? rows.filter((r) => r.month === source) : [];
}

function effectiveBudgets_(rows, month) {
  const merged = [];
  effectiveRows_(rows, month).forEach((r) => {
    const same = merged.find((b) => b.category === r.category);
    if (same) same.amount = round2_(same.amount + r.amount);
    else merged.push({ category: r.category, amount: r.amount });
  });
  return merged;
}

/* ---------- Budgets and categories ---------- */

/** Gives a month its own copy of the rows it inherits, so editing it leaves earlier months alone. */
function materialize_(month) {
  const table = read_('Budgets');
  if (table.rows.some((r) => r.month === month)) return;
  effectiveRows_(table.rows, month).forEach((r) => {
    writeRow_(table, { month, category: r.category, amount: r.amount });
  });
}

function setBudget_(month, category, amount) {
  materialize_(month);
  const table = read_('Budgets');
  const row = table.rows.find((r) => r.month === month && r.category === category);
  if (row) writeRow_(table, Object.assign({}, row, { amount }), row._row);
  else writeRow_(table, { month, category, amount });
}

/** A rename applies everywhere, including past months, so history stays together. */
function renameCategory_(from, to) {
  ['Purchases', 'Budgets', 'Bills'].forEach((name) => {
    const table = read_(name);
    const col = table.header.indexOf('category') + 1;
    if (!col) return;
    table.rows.forEach((r) => {
      if (r.category === from) table.sheet.getRange(r._row, col).setValue(toCell_('category', to));
    });
  });
}

/** Removes a category from this month onward. Past months and purchases are untouched. */
function removeCategory_(month, category) {
  materialize_(month);
  const table = read_('Budgets');
  table.rows
    .filter((r) => r.month >= month && r.category === category)
    .reverse()
    .forEach((r) => table.sheet.deleteRow(r._row));
}

/* ---------- Fixed bills ---------- */

/**
 * Records each bill once per month, on its day. Last Posted is what prevents
 * repeats, so deleting an auto-added purchase (to skip a month) stays deleted.
 * Missed months are caught up, each dated on its own due day.
 */
function postDueBills_() {
  const table = read_('Bills');
  const col = table.header.indexOf('last_posted') + 1;
  if (!col) return;
  const today = Utilities.formatDate(now_(), tz_(), 'yyyy-MM-dd');
  const thisMonth = today.slice(0, 7);

  table.rows.forEach((bill) => {
    if (!bill.id || !bill.name || !bill.amount) return;
    let month = bill.last_posted ? nextMonth_(bill.last_posted) : (bill.start_month || thisMonth);
    if (bill.start_month && month < bill.start_month) month = bill.start_month;

    let posted = '';
    while (month <= thisMonth) {
      const due = dueDate_(month, bill.day);
      if (due > today) break;
      upsert_('Purchases', {
        id: 'bill_' + bill.id + '_' + month,
        date: due,
        amount: bill.amount,
        category: bill.category,
        note: bill.name,
        who: 'Auto',
        source: 'auto',
      });
      posted = month;
      month = nextMonth_(month);
    }
    if (posted) table.sheet.getRange(bill._row, col).setValue(posted);
  });
}

/** Bills set for the 29th-31st land on the last day of shorter months. */
function dueDate_(month, day) {
  const parts = month.split('-').map(Number);
  const lastDay = new Date(parts[0], parts[1], 0).getDate();
  return month + '-' + pad_(Math.min(day || 1, lastDay));
}

/* ---------- Validating what the phone sends ---------- */

function bad_(message) {
  const err = new Error(message);
  err.badOp = true;
  throw err;
}

function needId_(v) {
  return v && typeof v === 'string' ? v.slice(0, 80) : bad_('Missing id');
}

function needDate_(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : bad_('Bad date: ' + v);
}

function needMonth_(v) {
  return /^\d{4}-\d{2}$/.test(v) ? v : bad_('Bad month: ' + v);
}

function needAmount_(v) {
  const n = Number(v);
  return v !== '' && v !== null && isFinite(n) ? round2_(n) : bad_('Bad amount: ' + v);
}

function needText_(v, label, max) {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || bad_('Missing ' + label);
}

function optText_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function cleanPurchase_(r) {
  r = r || {};
  return {
    id: needId_(r.id),
    date: needDate_(r.date),
    amount: needAmount_(r.amount),
    category: needText_(r.category, 'category', 60),
    note: optText_(r.note, 200),
    who: optText_(r.who, 40),
    source: r.source === 'auto' ? 'auto' : 'manual',
  };
}

function cleanIncome_(r) {
  r = r || {};
  return {
    id: needId_(r.id),
    date: needDate_(r.date),
    amount: needAmount_(r.amount),
    note: optText_(r.note, 200),
    who: optText_(r.who, 40),
  };
}

function cleanBill_(r) {
  r = r || {};
  const day = Number(r.day);
  if (!(day >= 1 && day <= 31)) bad_('Bad day: ' + r.day);
  return {
    id: needId_(r.id),
    name: needText_(r.name, 'name', 60),
    amount: needAmount_(r.amount),
    category: needText_(r.category, 'category', 60),
    day: Math.floor(day),
    start_month: needMonth_(r.start_month),
  };
}

/* ---------- Sheet helpers ---------- */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function now_() {
  return new Date();
}

let cachedTz_ = null;
function tz_() {
  if (!cachedTz_) cachedTz_ = ss_().getSpreadsheetTimeZone();
  return cachedTz_;
}

function key_(header) {
  return String(header).trim().toLowerCase().replace(/\s+/g, '_');
}

function sheet_(name) {
  const ss = ss_();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = ss.insertSheet(name);
  const headers = TABS[name];
  headers.forEach((header, i) => {
    sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat(COLUMN_FORMATS[key_(header)] || '@');
  });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

/** Reads a tab into objects keyed by column header, so reordering columns in the Sheet is safe. */
function read_(name) {
  const sheet = sheet_(name);
  const width = sheet.getLastColumn();
  const height = sheet.getLastRow();
  const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(key_);
  const rows = [];
  if (height < 2) return { sheet, header, rows };

  const idCol = header.indexOf('id');
  sheet.getRange(2, 1, height - 1, width).getValues().forEach((values, i) => {
    const row = { _row: i + 2 };
    header.forEach((key, c) => { row[key] = fromCell_(key, values[c]); });
    // A row typed straight into the Sheet has no ID yet. Give it one so the app can edit it.
    if (idCol >= 0 && !row.id && row.amount) {
      row.id = 's_' + Utilities.getUuid().slice(0, 12);
      sheet.getRange(row._row, idCol + 1).setValue(row.id);
    }
    rows.push(row);
  });
  return { sheet, header, rows };
}

function writeRow_(table, obj, rowNumber) {
  const cells = table.header.map((key) => toCell_(key, obj[key]));
  if (rowNumber) table.sheet.getRange(rowNumber, 1, 1, cells.length).setValues([cells]);
  else table.sheet.appendRow(cells);
}

function upsert_(name, obj) {
  const table = read_(name);
  const existing = table.rows.find((r) => r.id === obj.id);
  if (existing) writeRow_(table, Object.assign({}, existing, obj), existing._row);
  else writeRow_(table, Object.assign({ created: now_().toISOString() }, obj));
}

function removeById_(name, id) {
  const table = read_(name);
  const row = table.rows.find((r) => r.id === id);
  if (row) table.sheet.deleteRow(row._row);
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function fromCell_(key, v) {
  if (key === 'amount') return toAmount_(v);
  if (key === 'day') return Math.floor(Number(v)) || 1;
  if (key === 'date') {
    if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : '';
  }
  if (key === 'month' || key === 'start_month' || key === 'last_posted') {
    if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM');
    const m = String(v).match(/^\d{4}-\d{2}/);
    return m ? m[0] : '';
  }
  const s = v == null ? '' : String(v);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

/** A leading apostrophe stops Sheets from running text like "=SUM(A1)" as a formula. */
function toCell_(key, v) {
  if (v == null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function toAmount_(v) {
  if (typeof v === 'number') return round2_(v);
  const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? round2_(n) : 0;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function pad_(n) {
  return (n < 10 ? '0' : '') + n;
}

function nextMonth_(month) {
  const parts = month.split('-').map(Number);
  return parts[1] === 12 ? (parts[0] + 1) + '-01' : parts[0] + '-' + pad_(parts[1] + 1);
}

function prevMonth_(month) {
  const parts = month.split('-').map(Number);
  return parts[1] === 1 ? (parts[0] - 1) + '-12' : parts[0] + '-' + pad_(parts[1] - 1);
}
