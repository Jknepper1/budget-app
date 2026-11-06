// A stand-in for Google Sheets and Apps Script, used only for local testing.
// It runs the real apps-script/Code.gs, and copies the Sheets habits most likely
// to cause bugs: turning date-like and numeric text into real values, running
// anything that starts with "=" as a formula, and stripping a leading apostrophe.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) {
      throw new Error(`Range out of bounds: ${row},${col},${numRows},${numCols}`);
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.read(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.write(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet.write(this.row + r, this.col + c, v);
    }
    return this;
  }
  setNumberFormat(format) {
    for (let c = 0; c < this.numCols; c++) this.sheet.formats[this.col + c] = format;
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.formats = {};
  }
  getName() { return this.name; }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if ((this.rows[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    return this.rows.reduce((w, line) => {
      let last = 0;
      (line || []).forEach((v, i) => { if (v !== '' && v != null) last = i + 1; });
      return Math.max(w, last);
    }, 0);
  }
  getRange(row, col, numRows, numCols) { return new FakeRange(this, row, col, numRows, numCols); }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, c) => this.write(row, c + 1, v));
    return this;
  }
  deleteRow(row) { this.rows.splice(row - 1, 1); return this; }
  setFrozenRows() { return this; }
  read(row, col) {
    const v = (this.rows[row - 1] || [])[col - 1];
    return v == null ? '' : v;
  }
  write(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    this.rows[row - 1][col - 1] = this.parse(value, this.formats[col]);
  }
  parse(v, format) {
    if (typeof v !== 'string') return v;
    if (v.startsWith("'")) return v.slice(1);
    if (v.startsWith('=')) return '#FORMULA-RAN#';
    if (format === '@') return v;
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = v.match(/^(\d{4})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, 1);
    if (v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return v;
  }
  /** Mimics a person typing into the Sheet by hand. */
  typeRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, c) => {
      if (v !== '' && v != null) this.write(row, c + 1, v);
    });
    return row;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [new FakeSheet('Sheet1')];
  }
  getId() { return 'fake-sheet-id'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake-sheet-id/edit'; }
  getSpreadsheetTimeZone() { return LOCAL_TZ; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); }
}

function formatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  if (pattern === 'yyyy-MM-dd') return `${get('year')}-${get('month')}-${get('day')}`;
  if (pattern === 'yyyy-MM') return `${get('year')}-${get('month')}`;
  throw new Error(`Fake formatDate has no pattern ${pattern}`);
}

/**
 * Loads the real Code.gs against a fake spreadsheet.
 * Pass passcode: null to leave the file's placeholder in place.
 */
function loadBackend({ passcode = 'test-passcode', today } = {}) {
  const file = path.join(__dirname, '..', 'apps-script', 'Code.gs');
  let source = fs.readFileSync(file, 'utf8');
  if (passcode !== null) {
    source = source.replace("const PASSCODE = 'CHANGE-ME';", `const PASSCODE = ${JSON.stringify(passcode)};`);
  }

  const spreadsheet = new FakeSpreadsheet();
  const triggers = [];
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return text; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger(handler) {
        const builder = {
          timeBased: () => builder,
          everyDays: () => builder,
          atHour: () => builder,
          create() { triggers.push({ getHandlerFunction: () => handler }); },
        };
        return builder;
      },
    },
    Logger: { log() {} },
    console,
  };
  const ctx = vm.createContext(env);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });

  const api = {
    spreadsheet,
    triggers,
    ctx,
    setToday(value) {
      const [y, m, d] = value.split('-').map(Number);
      ctx.now_ = () => new Date(y, m - 1, d, 12);
    },
    /** Sends a request the way a phone would and returns the parsed reply. */
    post(body) {
      const payload = { passcode: passcode === null ? 'CHANGE-ME' : passcode, ...body };
      return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
    },
    postRaw(contents) {
      return JSON.parse(ctx.doPost({ postData: { contents } }).getContent());
    },
    get() { return JSON.parse(ctx.doGet().getContent()); },
    tab(name) { return spreadsheet.getSheetByName(name); },
  };
  if (today) api.setToday(today);
  return api;
}

module.exports = { loadBackend };
