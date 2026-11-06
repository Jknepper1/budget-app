const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackend } = require('./fake-google');

let nextOp = 1;
const op = (type, fields) => ({ opId: `op${nextOp++}`, type, ...fields });
const purchase = (id, date, amount, category = 'Food', extra = {}) =>
  op('purchase.upsert', { row: { id, date, amount, category, note: '', who: 'Sam', ...extra } });
const income = (id, date, amount) => op('income.upsert', { row: { id, date, amount, note: 'Pay', who: 'Sam' } });
const budget = (month, category, amount) => op('budget.set', { month, category, amount });
const bill = (id, day, startMonth, amount = 100, name = 'Rent', category = 'Housing') =>
  op('bill.upsert', { row: { id, name, amount, category, day, start_month: startMonth } });

const backend = (today = '2026-11-06') => {
  const b = loadBackend({ today });
  b.ctx.setup();
  return b;
};
const month = (b, ym) => b.post({ months: [ym] }).months[ym];

test('wrong passcode is refused and nothing is written', () => {
  const b = backend();
  const res = b.postRaw(JSON.stringify({ passcode: 'nope', ops: [purchase('p_1', '2026-11-01', 5)], months: ['2026-11'] }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad_passcode');
  assert.equal(res.months, undefined);
  assert.equal(month(b, '2026-11').purchases.length, 0);
});

test('the placeholder passcode never unlocks the app, and setup refuses to run', () => {
  const b = loadBackend({ passcode: null, today: '2026-11-06' });
  assert.equal(b.post({ months: ['2026-11'] }).error, 'passcode_not_set');
  assert.throws(() => b.ctx.setup(), /Change PASSCODE/);
  assert.equal(b.get().passcodeSet, false);
});

test('setup creates the tabs and one daily timer, even if run twice', () => {
  const b = backend();
  b.ctx.setup();
  const names = b.spreadsheet.getSheets().map((s) => s.getName()).sort();
  assert.deepEqual(names, ['Bills', 'Budgets', 'Income', 'Purchases']);
  assert.equal(b.triggers.length, 1);
  assert.equal(b.get().ok, true);
});

test('purchases come back in the right month with clean dates', () => {
  const b = backend();
  const res = b.post({ ops: [purchase('p_1', '2026-11-03', 12.5), purchase('p_2', '2026-10-31', 7)], months: ['2026-11', '2026-10'] });
  assert.deepEqual(res.months['2026-11'].purchases.map((p) => [p.id, p.date, p.amount]), [['p_1', '2026-11-03', 12.5]]);
  assert.deepEqual(res.months['2026-10'].purchases.map((p) => [p.id, p.date]), [['p_2', '2026-10-31']]);
});

test('a retried change does not create a duplicate', () => {
  const b = backend();
  const change = purchase('p_1', '2026-11-03', 12.5);
  b.post({ ops: [change] });
  b.post({ ops: [change] });
  assert.equal(month(b, '2026-11').purchases.length, 1);
});

test('editing a purchase can move it between months, and deleting is safe to repeat', () => {
  const b = backend();
  b.post({ ops: [purchase('p_1', '2026-11-03', 12.5)] });
  b.post({ ops: [purchase('p_1', '2026-10-03', 20)] });
  assert.equal(month(b, '2026-11').purchases.length, 0);
  assert.equal(month(b, '2026-10').purchases[0].amount, 20);
  const del = op('purchase.delete', { id: 'p_1' });
  b.post({ ops: [del] });
  assert.equal(b.post({ ops: [del] }).ok, true);
  assert.equal(month(b, '2026-10').purchases.length, 0);
});

test('notes that look like formulas, dates, or numbers stay plain text', () => {
  const b = backend();
  const notes = ['=SUM(A1:A9)', '5/6', '+1 extra', '-5 off', '@home', '1.50', 'plain'];
  b.post({ ops: notes.map((note, i) => purchase(`p_${i}`, '2026-11-01', 1, 'Food', { note })) });
  assert.deepEqual(month(b, '2026-11').purchases.map((p) => p.note), notes);
});

test('a category that looks like a formula survives budgets and renames', () => {
  const b = backend();
  b.post({ ops: [budget('2026-11', '=Fun', 50)] });
  assert.equal(month(b, '2026-11').budgets[0].category, '=Fun');
  b.post({ ops: [op('category.rename', { from: '=Fun', to: '+Play' })] });
  assert.equal(month(b, '2026-11').budgets[0].category, '+Play');
});

test('income totals by month and reports last month for reference', () => {
  const b = backend();
  b.post({ ops: [income('i_1', '2026-10-15', 2500.1), income('i_2', '2026-10-30', 2500.2), income('i_3', '2026-11-15', 2600)] });
  const nov = month(b, '2026-11');
  assert.equal(nov.prevIncome, 5000.3);
  assert.equal(nov.income.length, 1);
});

test('a new month inherits budgets without changing the old one', () => {
  const b = backend();
  b.post({ ops: [budget('2026-10', 'Food', 500), budget('2026-10', 'Gas', 100)] });
  assert.deepEqual(month(b, '2026-11').budgets, [{ category: 'Food', amount: 500 }, { category: 'Gas', amount: 100 }]);
  assert.deepEqual(month(b, '2026-12').budgets.length, 2, 'later months inherit too');

  b.post({ ops: [budget('2026-11', 'Food', 650)] });
  assert.equal(month(b, '2026-10').budgets.find((x) => x.category === 'Food').amount, 500, 'past month unchanged');
  assert.equal(month(b, '2026-11').budgets.find((x) => x.category === 'Food').amount, 650);
  assert.equal(month(b, '2026-11').budgets.find((x) => x.category === 'Gas').amount, 100, 'other categories copied');
  assert.equal(month(b, '2026-12').budgets.find((x) => x.category === 'Food').amount, 650, 'edit carries forward');
  assert.deepEqual(month(b, '2026-09').budgets, [], 'months before any budget stay empty');
});

test('setting the same budget twice does not duplicate the row', () => {
  const b = backend();
  const change = budget('2026-11', 'Food', 500);
  b.post({ ops: [change, change] });
  assert.equal(month(b, '2026-11').budgets.length, 1);
});

test('renaming a category updates purchases, budgets, and bills in every month', () => {
  const b = backend();
  b.post({ ops: [
    budget('2026-10', 'Food', 500), budget('2026-11', 'Food', 600),
    purchase('p_1', '2026-10-05', 10), purchase('p_2', '2026-11-05', 20),
    bill('b_1', 28, '2026-11', 15, 'Meal kit', 'Food'),
  ] });
  const res = b.post({ ops: [op('category.rename', { from: 'Food', to: 'Groceries' })], months: ['2026-10', '2026-11'] });
  assert.equal(res.months['2026-10'].budgets[0].category, 'Groceries');
  assert.equal(res.months['2026-11'].budgets[0].category, 'Groceries');
  assert.equal(res.months['2026-10'].purchases[0].category, 'Groceries');
  assert.equal(res.months['2026-11'].purchases[0].category, 'Groceries');
  assert.equal(res.bills[0].category, 'Groceries');
});

test('removing a category leaves past months and purchases alone', () => {
  const b = backend();
  b.post({ ops: [budget('2026-10', 'Food', 500), budget('2026-10', 'Gas', 100), purchase('p_1', '2026-11-02', 30, 'Gas')] });
  b.post({ ops: [op('category.remove', { month: '2026-11', category: 'Gas' })] });
  assert.equal(month(b, '2026-10').budgets.length, 2);
  const nov = month(b, '2026-11');
  assert.deepEqual(nov.budgets.map((x) => x.category), ['Food']);
  assert.equal(nov.purchases[0].category, 'Gas', 'the purchase stays');
});

test('a bill is recorded on its day, once, as an auto purchase', () => {
  const b = backend('2026-11-14');
  b.post({ ops: [bill('b_1', 15, '2026-11', 1800, 'Mortgage')] });
  assert.equal(month(b, '2026-11').purchases.length, 0, 'not due yet');

  b.setToday('2026-11-15');
  b.ctx.dailyBills();
  b.post({});
  b.ctx.dailyBills();
  const rows = month(b, '2026-11').purchases;
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].date, rows[0].amount, rows[0].category, rows[0].note, rows[0].who, rows[0].source],
    ['2026-11-15', 1800, 'Housing', 'Mortgage', 'Auto', 'auto'],
  );
});

test('a bill set for the 31st lands on the last day of shorter months', () => {
  const b = backend('2027-01-05');
  b.post({ ops: [bill('b_1', 31, '2027-02')] });
  b.setToday('2027-02-28');
  assert.equal(month(b, '2027-02').purchases[0].date, '2027-02-28');
  b.setToday('2027-04-30');
  assert.equal(month(b, '2027-04').purchases[0].date, '2027-04-30');
});

test('deleting an auto-added purchase skips that month and it stays deleted', () => {
  const b = backend('2026-11-06');
  b.post({ ops: [bill('b_1', 1, '2026-11')] });
  const id = month(b, '2026-11').purchases[0].id;
  b.post({ ops: [op('purchase.delete', { id })] });
  b.ctx.dailyBills();
  assert.equal(month(b, '2026-11').purchases.length, 0);
  b.setToday('2026-12-01');
  assert.equal(month(b, '2026-12').purchases.length, 1, 'it returns next month');
});

test('a bill that starts next month does not post this month', () => {
  const b = backend('2026-11-06');
  b.post({ ops: [bill('b_1', 1, '2026-12')] });
  assert.equal(month(b, '2026-11').purchases.length, 0);
  b.setToday('2026-12-01');
  assert.equal(month(b, '2026-12').purchases.length, 1);
});

test('missed months catch up, each dated in its own month', () => {
  const b = backend('2026-09-20');
  b.post({ ops: [bill('b_1', 10, '2026-09')] });
  b.setToday('2026-12-05');
  const res = b.post({ months: ['2026-10', '2026-11', '2026-12'] });
  assert.equal(res.months['2026-10'].purchases[0].date, '2026-10-10');
  assert.equal(res.months['2026-11'].purchases[0].date, '2026-11-10');
  assert.equal(res.months['2026-12'].purchases.length, 0, 'December is not due yet');
});

test('editing a bill changes future amounts but does not re-post this month', () => {
  const b = backend('2026-11-06');
  b.post({ ops: [bill('b_1', 1, '2026-11', 100)] });
  b.post({ ops: [bill('b_1', 1, '2026-11', 150)] });
  const nov = month(b, '2026-11').purchases;
  assert.equal(nov.length, 1);
  assert.equal(nov[0].amount, 100);
  b.setToday('2026-12-01');
  assert.equal(month(b, '2026-12').purchases[0].amount, 150);
});

test('a deleted bill stops, and its past purchases stay', () => {
  const b = backend('2026-11-06');
  b.post({ ops: [bill('b_1', 1, '2026-11')] });
  const res = b.post({ ops: [op('bill.delete', { id: 'b_1' })], months: ['2026-11'] });
  assert.equal(res.bills.length, 0);
  assert.equal(res.months['2026-11'].purchases.length, 1);
  b.setToday('2026-12-01');
  assert.equal(month(b, '2026-12').purchases.length, 0);
});

test('a bad change is reported and dropped while good ones still apply', () => {
  const b = backend();
  const good = purchase('p_1', '2026-11-03', 5);
  const noDate = purchase('p_2', 'yesterday', 5);
  const noAmount = purchase('p_3', '2026-11-03', 'lots');
  const unknown = op('wat', {});
  const res = b.post({ ops: [noDate, good, noAmount, unknown], months: ['2026-11'] });
  assert.deepEqual(res.done, [good.opId]);
  assert.deepEqual(res.rejected.map((r) => r.opId), [noDate.opId, noAmount.opId, unknown.opId]);
  assert.equal(res.months['2026-11'].purchases.length, 1);
});

test('if Sheets fails mid-request, changes are not reported done, so the phone retries', () => {
  const b = backend();
  const change = purchase('p_1', '2026-11-03', 5);
  const sheet = b.tab('Purchases');
  const realAppend = sheet.appendRow;
  sheet.appendRow = () => { throw new Error('Service Spreadsheets failed'); };
  const failed = b.post({ ops: [change], months: ['2026-11'] });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'server_error');
  assert.equal(failed.done, undefined);

  sheet.appendRow = realAppend;
  assert.deepEqual(b.post({ ops: [change] }).done, [change.opId]);
  assert.equal(month(b, '2026-11').purchases.length, 1);
});

test('rows typed directly into the Sheet show up and can be edited', () => {
  const b = backend();
  b.tab('Purchases').typeRow(['2026-11-04', '$1,204.50', 'Food', 'Typed by hand']);
  const row = month(b, '2026-11').purchases[0];
  assert.equal(row.amount, 1204.5);
  assert.ok(row.id, 'gets an ID');
  assert.equal(row.source, 'manual');

  b.post({ ops: [purchase(row.id, row.date, 99)] });
  const after = month(b, '2026-11').purchases;
  assert.equal(after.length, 1);
  assert.equal(after[0].amount, 99);
});

test('reordering columns in the Sheet does not break anything', () => {
  const b = backend();
  b.post({ ops: [purchase('p_1', '2026-11-03', 5, 'Food', { note: 'first' })] });
  const sheet = b.tab('Purchases');
  sheet.rows = sheet.rows.map((line) => [line[3], line[0], line[1], line[2], ...line.slice(4)]);
  sheet.formats = {};
  b.post({ ops: [purchase('p_2', '2026-11-04', 6, 'Food', { note: 'second' })] });
  const rows = month(b, '2026-11').purchases;
  assert.deepEqual(rows.map((p) => [p.note, p.amount, p.category]), [['first', 5, 'Food'], ['second', 6, 'Food']]);
});

test('the health check reveals no budget data', () => {
  const b = backend();
  b.post({ ops: [purchase('p_1', '2026-11-03', 5, 'Food', { note: 'secret' })] });
  const text = JSON.stringify(b.get());
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('test-passcode'));
});
