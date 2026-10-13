/* اختبارات "بيتي" — بتشغّل التطبيق في متصفح حقيقي (Chromium) وبتتأكد من الحسابات.
   التشغيل:  npm install   ثم   npm test
   كل اختبار في متصفح نضيف (بيانات فاضية)، والتاريخ متثبت على 9 أكتوبر 2026
   عشان النتايج تبقى ثابتة. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gs': 'text/plain; charset=utf-8' };
const NOW = new Date('2026-10-09T10:00:00');

/* جوجل شيت مزيّف على /exec — نفس قواعد Code.gs بالظبط (stale + shrink بالحجم وبعدد الحركات)،
   ومعاه تأخير اختياري عشان نجرب "الصفحة لسه بتحمّل" */
const FAKE = { value: null, updatedAt: 0, delay: 0, posts: 0 };
const txCount = j => { try { return (JSON.parse(j).tx || []).length; } catch (e) { return 0; } };
function fakeSheet(req, res) {
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const send = o => { res.writeHead(200, H); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') return setTimeout(() => send({ ok: true, value: FAKE.value, updatedAt: FAKE.updatedAt }), FAKE.delay);
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const b = JSON.parse(body); FAKE.posts++;
    if (!b.force) {
      if (FAKE.updatedAt && b.updatedAt < FAKE.updatedAt) return send({ ok: false, code: 'stale' });
      if (FAKE.value && b.value.length < FAKE.value.length * 0.6) return send({ ok: false, code: 'shrink' });
      const o = txCount(FAKE.value), n = txCount(b.value);
      if (o >= 10 && n < o * 0.8) return send({ ok: false, code: 'shrink' });
    }
    FAKE.value = b.value; FAKE.updatedAt = b.updatedAt; send({ ok: true });
  });
}

// سيرفر صغير للملفات (عشان localStorage و Service Worker يشتغلوا زي الحقيقة)
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/exec') return fakeSheet(req, res);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

let passed = 0, failed = 0;
async function test(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.clock.install({ time: NOW });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  try {
    await page.goto(URL_);
    await fn(page);
    assert.deepEqual(errors, [], 'أخطاء جافاسكريبت في الصفحة');
    console.log('  ✅', name); passed++;
  } catch (e) {
    console.log('  ❌', name, '\n     ', e.message.split('\n').slice(0, 14).join('\n      ')); failed++;
  }
  await ctx.close();
}
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const fill = (page, n, v) => page.fill(`#sheetBody [name="${n}"]`, String(v));
// يدوس حفظ ويستنى الشاشة تتقفل (أو ثانية لو فضلت مفتوحة بسبب تحقق)
const submit = async page => {
  await page.click('#sheetBody button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#sheetWrap').classList.contains('open'), null, { timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(30);
};

console.log('بيتي — اختبارات\n');

await test('الصفحة بتفتح والقيم الافتراضية سليمة', async page => {
  assert.equal(await page.title(), 'بيتي — ميزانية البيت');
  const s = await ev(page, () => ({ wallets: S.wallets.length, cats: S.cats.length, cycle: S.settings.cycleDay }));
  assert.deepEqual(s, { wallets: 1, cats: 12, cycle: 1 });
});

await test('التحقق من الأرقام: بيرفض الحروف والسالب ويقبل الأرقام العربي', async page => {
  await page.click('.fab');
  await fill(page, 'amount', '5abc'); await submit(page);
  assert.equal(await ev(page, () => S.tx.length), 0, 'اتسجل رقم فيه حروف');
  await fill(page, 'amount', '-5'); await submit(page);
  assert.equal(await ev(page, () => S.tx.length), 0, 'اتسجل رقم سالب');
  await fill(page, 'amount', '١٬٥٠٠'); await submit(page);
  assert.equal(await ev(page, () => S.tx[0].amount), 1500);
});

await test('الرصيد = الجرد + الدخل − المصروف، والمرتب المتوقع مش رصيد', async page => {
  const r = await ev(page, () => {
    S.incomes.push({ id: 'i1', name: 'المرتب', amount: 15000, day: 1 });
    S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 5000 });
    S.tx.push({ id: 'e', ts: 2, type: 'exp', cat: 'food', amount: 100, date: '2026-10-09' });
    save();
    const a = cashBalance().value;
    S.tx.push({ id: 's', ts: 3, type: 'inc', incomeId: 'i1', amount: 15000, date: '2026-10-09' }); save();
    return [a, cashBalance().value];
  });
  assert.deepEqual(r, [4900, 19900]);
});

await test('معدل الاستهلاك بيتعلم من الجرد، والعبوة بتتحول صح', async page => {
  const r = await ev(page, () => {
    ACT.seedItems();
    const rz = S.items.find(i => i.name === 'رز');            // KG، كيس = 1
    S.counts.push({ id: 'a', ts: 1, itemId: rz.id, date: '2026-09-19', qty: 10 });
    S.tx.push({ id: 'b', ts: 2, type: 'exp', cat: 'house', itemId: rz.id, qty: 5, amount: 190, date: '2026-09-29' });
    S.counts.push({ id: 'c', ts: 3, itemId: rz.id, date: '2026-10-09', qty: 7 });
    const mk = S.items.find(i => i.name === 'مكرونة');        // KG، كيس = 0.45
    mk.monthly = 10 * 0.45; mk.price = 15 / 0.45;
    S.counts.push({ id: 'd', ts: 4, itemId: mk.id, date: '2026-10-09', qty: 0.9 });
    save();
    const x = shopList().find(s => s.it.id === mk.id);
    return { rice: Math.round(learnedDaily(rz) * 30), buy: qtyPlain(mk, x.qty), cost: Math.round(x.cost) };
  });
  assert.deepEqual(r, { rice: 12, buy: '9 كيس (4.05 KG)', cost: 135 });
});

await test('الجرد: البحث بيخبّي الباقي من غير ما يمسح اللي اتكتب، والفاضي ما بيتحفظش', async page => {
  await ev(page, () => { ACT.seedItems(); save(); ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' }); });
  const rz = await ev(page, () => S.items.find(i => i.name === 'رز').id);
  await page.fill(`#jardForm input[data-item="${rz}"]`, '3');
  const shown = () => ev(page, () => [...document.querySelectorAll('#jardForm .jard-row')].filter(r => r.offsetParent).map(r => r.dataset.nm));
  await page.fill('[data-q="jard"]', 'مكرونه');
  assert.deepEqual(await shown(), ['مكرونة']);
  await page.fill('[data-q="jard"]', 'حاجة مش موجودة');
  assert.deepEqual([(await shown()).length, await page.isVisible('[data-qnone="jard"]')], [0, true]);
  await page.fill('[data-q="jard"]', '');
  assert.equal((await shown()).length, await ev(page, () => S.items.length));
  await page.fill('[data-q="jard"]', 'مكرونة');
  await page.click('[data-act="saveJard"]');
  assert.deepEqual(await ev(page, () => S.counts.map(c => [byId(S.items, c.itemId).name, c.qty])), [['رز', 3]]);
});

await test('الجرد: اللي بيتكتب بيفضل لو خرجت، وقبل الحفظ بيسألك عن الفاضي اللي ممكن يكون خلص', async page => {
  const ids = await ev(page, () => {
    ACT.seedItems();
    const [a, b, c] = S.items;
    S.counts.push({ id: 'x1', ts: 1, itemId: a.id, date: '2026-10-05', qty: 5 }, { id: 'x2', ts: 2, itemId: b.id, date: '2026-10-05', qty: 5 });
    save(); ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' });
    return [a.id, b.id, c.id];
  });
  await page.fill(`#jardForm input[data-item="${ids[2]}"]`, '4');
  await ev(page, () => { ACT.tab({ tab: 'home' }); ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' }); });
  assert.equal(await page.inputValue(`#jardForm input[data-item="${ids[2]}"]`), '4', 'الرقم اتمسح لما خرجت ورجعت');
  // صنف جديد من جوه الجرد: الأرقام اللي اتكتبت ما بتضيعش، والصنف اللي اتعدّ وهو بيتضاف ما يتسألش عنه
  await page.fill('[data-q="jard"]', 'تونة');
  await page.click('[data-qnone="jard"] [data-act="itemNew"]');
  assert.equal(await page.inputValue('#sheetBody [name="name"]'), 'تونة');
  await fill(page, 'stock', '3'); await submit(page);
  assert.equal(await page.inputValue(`#jardForm input[data-item="${ids[2]}"]`), '4', 'الرقم اتمسح بعد إضافة صنف');
  assert.equal(await page.inputValue('[data-q="jard"]'), '');
  // الدوس على اسم الصنف بيفتح تعديله، والأرقام برضه ما بتضيعش
  await page.click(`#jardForm .jard-row:has(input[data-item="${ids[2]}"]) .nm`);
  assert.equal(await page.inputValue('#sheetBody [name="name"]'), await ev(page, id => byId(S.items, id).name, ids[2]));
  await submit(page);
  assert.equal(await page.inputValue(`#jardForm input[data-item="${ids[2]}"]`), '4', 'الرقم اتمسح بعد تعديل صنف');
  await page.click('[data-act="saveJard"]');
  // a و b عندهم جرد قديم ومتسابوا فاضيين → بيظهروا في السؤال
  const asked = await ev(page, () => [...document.querySelectorAll('#sheetBody input[type=checkbox]')].map(x => x.name));
  assert.deepEqual(asked, ['z_' + ids[0], 'z_' + ids[1]]);
  await page.check(`#sheetBody [name="z_${ids[1]}"]`); await submit(page);
  const r = await ev(page, () => ({ c: S.counts.filter(c => !c.id.startsWith('x') && byId(S.items, c.itemId).name !== 'تونة').map(c => [c.itemId, c.qty]), draft: localStorage.getItem(JDRAFT_KEY) }));
  const f = await ev(page, id => packF(byId(S.items, id)), ids[2]);   // الجرد بالعبوة افتراضيًا
  assert.deepEqual(r, { c: [[ids[2], 4 * f], [ids[1], 0]], draft: null });
});

await test('الأصناف: البحث بيفضل شغال بعد تعديل صنف', async page => {
  await ev(page, () => { ACT.seedItems(); save(); ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'items' }); });
  const shown = () => ev(page, () => [...document.querySelectorAll('.list-item[data-nm]')].filter(r => r.offsetParent).map(r => r.dataset.nm));
  await page.fill('[data-q="items"]', 'رز');
  assert.deepEqual(await shown(), ['رز']);
  await page.click('.list-item[data-nm="رز"]'); await submit(page);
  assert.deepEqual([await shown(), await page.inputValue('[data-q="items"]')], [['رز'], 'رز']);
  await page.fill('[data-q="items"]', '');
  assert.equal((await shown()).length, await ev(page, () => S.items.length));
});

await test('سجّل شراء: تختار اشتريته بإيه، والعبوة الجديدة بتتحفظ للصنف', async page => {
  await ev(page, () => { S.items.push({ id: 'tn', name: 'تونة', group: 'تموين', base: 'PCS', monthly: 4, price: 0 }); save(); });
  const buys = () => ev(page, () => S.tx.filter(t => t.itemId === 'tn').map(t => [t.qty, t.amount]));
  // صنف من غير عبوة: يشتري بكرتونة (فيها 12) من غير ما تبقى الأساسية
  await ev(page, () => buyItem('tn'));
  await page.selectOption('#sheetBody [name="bu"]', '__new');
  await page.selectOption('#sheetBody [name="npu"]', 'كرتونة');
  await fill(page, 'npf', 12); await page.uncheck('#sheetBody [name="main"]');
  await fill(page, 'qty', 2); await fill(page, 'amount', 960);
  assert.match(await page.textContent('#sheetBody [data-bl-l="conv"]'), /2 كرتونة = 24/);
  await submit(page);
  assert.deepEqual(await buys(), [[24, 960]]);
  assert.deepEqual(await ev(page, () => [byId(S.items, 'tn').pu, byId(S.items, 'tn').alt]), [undefined, [{ pu: 'كرتونة', pf: 12 }]]);
  // المرة الجاية الكرتونة موجودة في الاختيارات
  await ev(page, () => buyItem('tn'));
  const opts = await ev(page, () => [...document.querySelectorAll('#sheetBody [name="bu"] option')].map(o => o.textContent));
  assert.deepEqual(opts.slice(0, 2), ['كرتونة (= 12 PCS)', 'PCS — قطعة']);
  await page.selectOption('#sheetBody [name="bu"]', 'base'); await fill(page, 'qty', 3); await fill(page, 'amount', 120); await submit(page);
  assert.deepEqual(await buys(), [[24, 960], [3, 120]]);
  // وفي "كذا حاجة" تقدر تختار الوحدة برضه
  await page.click('.fab'); await page.click('#sheetBody [data-act="qaMulti"]');
  await page.selectOption('#mlines .ml-row:first-child [data-f="cat"]', 'house');
  await page.selectOption('#mlines .ml-row:first-child [data-f="item"]', 'tn');
  await page.fill('#mlines .ml-row:first-child [data-f="amount"]', '480');
  await page.fill('#mlines .ml-row:first-child [data-f="qty"]', '1');
  await page.selectOption('#mlines .ml-row:first-child [data-f="unit"]', 'alt0');
  await submit(page);
  assert.deepEqual((await buys()).at(-1), [12, 480]);
  // علبة بحجم تاني بنفس اسم العبوة الأساسية بتتحفظ برضه
  await ev(page, () => { const it = byId(S.items, 'tn'); it.pu = 'علبة'; it.pf = 3; save(); buyItem('tn'); });
  await page.selectOption('#sheetBody [name="bu"]', '__new'); await page.selectOption('#sheetBody [name="npu"]', 'علبة');
  await fill(page, 'npf', 1); await fill(page, 'qty', 1); await fill(page, 'amount', 40); await submit(page);
  assert.deepEqual(await ev(page, () => itemUnits(byId(S.items, 'tn')).map(u => unitShort(byId(S.items, 'tn'), u))), ['علبة 3', 'كرتونة', 'علبة 1', 'PCS']);
});

await test('جركن بحجم مختلف للمرة دي بس، و"خلص" بضغطة واحدة ويترجع', async page => {
  await ev(page, () => { S.items.push({ id: 'sb', name: 'صابون سايل', group: 'منظفات', base: 'L', pu: 'جركن', pf: 4, monthly: 2, price: 30 });
    S.counts.push({ id: 'c0', ts: 1, itemId: 'sb', date: '2026-10-01', qty: 6 }); save(); buyItem('sb'); });
  assert.equal(await page.inputValue('#sheetBody [name="npf"]'), '4');
  await fill(page, 'npf', '4.6'); await fill(page, 'qty', 1); await fill(page, 'amount', 150);
  assert.match(await page.textContent('#sheetBody [data-bl-l="sizeNote"]'), /للمرة دي بس/);
  await submit(page);
  assert.deepEqual(await ev(page, () => [S.tx.at(-1).qty, byId(S.items, 'sb').pf, (byId(S.items, 'sb').alt || []).length]), [4.6, 4, 0]);
  // خلص من قايمة الأصناف
  await ev(page, () => { ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'items' }); });
  await page.click('.list-item[data-id="sb"] [data-act="itemOut"]');
  assert.equal(await ev(page, () => estStock(byId(S.items, 'sb'))), 0);
  assert.ok(await ev(page, () => shopList().find(x => x.it.id === 'sb').qty > 0), 'لازم يدخل قايمة الشراء');
  await page.click('#undoBar [data-act="undo"]');
  assert.ok(await ev(page, () => estStock(byId(S.items, 'sb')) > 0 && S.tomb.length === 1), 'التراجع لازم يرجّعه ويعلّم على الجرد اللي اتشال');
});

await test('ترتيب الأصناف حسب الإتاحة: اللي خلص الأول وبعده اللي هيخلص', async page => {
  const order = await ev(page, () => {
    S.items.push({ id: 'a', name: 'كتير', group: 'ج1', base: 'PCS', monthly: 30 }, { id: 'b', name: 'خلصان', group: 'ج2', base: 'PCS', monthly: 30 },
      { id: 'c', name: 'قرب', group: 'ج1', base: 'PCS', monthly: 30 }, { id: 'd', name: 'مش متجرد', group: 'ج2', base: 'PCS', monthly: 30 });
    S.counts.push({ id: 'k1', ts: 1, itemId: 'a', date: '2026-10-09', qty: 40 }, { id: 'k2', ts: 2, itemId: 'b', date: '2026-10-09', qty: 0 },
      { id: 'k3', ts: 3, itemId: 'c', date: '2026-10-09', qty: 3 });
    save(); ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'items' }); ACT.itemSort({ v: 'avail' });
    return [...document.querySelectorAll('.list-item[data-nm]')].map(r => r.dataset.nm);
  });
  assert.deepEqual(order, ['خلصان', 'قرب', 'كتير', 'مش متجرد']);
  await page.fill('[data-q="items"]', 'ج2');   // البحث بالمجموعة شغال في القايمة الواحدة برضه
  assert.deepEqual(await ev(page, () => [...document.querySelectorAll('.list-item[data-nm]')].filter(r => r.offsetParent).map(r => r.dataset.nm)), ['خلصان', 'مش متجرد']);
});

await test('هدف لسه ما بدأش: مش بيتخصم من خطة الشهر لحد شهر البداية', async page => {
  await ev(page, () => { ACT.tab({ tab: 'goals' }); goalForm(); });
  await fill(page, 'name', 'عربية'); await fill(page, 'target', 120000);
  await page.fill('#sheetBody [name="deadline"]', '2027-12'); await page.fill('#sheetBody [name="start"]', '2027-01');
  await submit(page);
  const r = await ev(page, () => {
    const g = S.goals[0], pr = goalProjection(g);
    return { start: g.start, planned: Math.round(summary(VIEW).savePlanned), base: Math.round(pr.base), atDl: Math.round(pr.atDeadline),
      reach: pr.reachAt, note: !!document.querySelector('[data-act="goalStartNow"]') };
  });
  // من يناير لديسمبر 2027 = 12 شهر → 10,000 في الشهر، والشهر ده صفر
  assert.deepEqual(r, { start: '2027-01', planned: 0, base: 10000, atDl: 120000, reach: 14, note: true });
  await page.click('[data-act="goalStartNow"]');
  assert.equal(await ev(page, () => Math.round(summary(VIEW).savePlanned)), Math.round(120000 / 15));
});

await test('مواعيد السداد: تشيل كام في الشهر، والدفع من المحجوز من غير ما يتخصم مرتين', async page => {
  const r = await ev(page, () => {
    S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.dues.push({ id: 'u', name: 'المدرسة', amount: 12000, baseAmount: 12000, date: '2027-09-01', repeat: 12 });
    S.dues.push({ id: 'v', name: 'تأمين', amount: 3000, baseAmount: 3000, date: '2026-12-15', repeat: 0 });
    save();
    const per = [duePerMonth(S.dues[0], periodOf(todayS())), duePerMonth(S.dues[1], periodOf(todayS()))].map(Math.round);
    S.tx.push({ id: 'r', ts: 2, type: 'reserve', dueId: 'v', dueDate: '2026-12-15', amount: 1000, date: '2026-10-09' }); save();
    const afterReserve = cashBalance().value;
    return { per, afterReserve };
  });
  assert.deepEqual(r, { per: [1000, 1000], afterReserve: 9000 });
  await ev(page, () => payDue('v')); await submit(page);
  const after = await ev(page, () => ({ bal: cashBalance().value, paid: byId(S.dues, 'v').paidOn, reserved: totalReserved() }));
  assert.deepEqual(after, { bal: 7000, paid: '2026-10-09', reserved: 0 });
});

await test('خطة الديون: الأقساط + الدفعات بتواريخ', async page => {
  const r = await ev(page, () => {
    S.debts.push({ id: 'd1', name: 'تلاجة', total: 6000, monthly: 1500, dueDay: 10 });
    S.debts.push({ id: 'd2', name: 'خالي', total: 20000, monthly: 0, dueDay: 1 });
    S.dues.push({ id: 'p1', debtId: 'd2', amount: 10000, date: '2026-12-15' }, { id: 'p2', debtId: 'd2', amount: 10000, date: '2027-03-15' });
    save();
    return debtPlan(0).rows.map(x => x.d.name + ':' + monthLabelFromNow(x.end));
  });
  assert.deepEqual(r, ['تلاجة:يناير 2027', 'خالي:مارس 2027']);
});

await test('الأهداف والجمعية: المطلوب الشهري وميعاد القبض', async page => {
  const r = await ev(page, () => {
    S.goals.push({ id: 'g', name: 'العربية', target: 850000, initial: 120000, deadline: '2027-12', monthly: 0 });
    S.goals.push({ id: 'j', kind: 'gameya', name: 'جمعية', monthly: 2000, months: 10, start: '2026-10', target: 20000, deadline: '2027-07' });
    save();
    return [Math.round(goalRequired(S.goals[0])), goalPlanMonthly(S.goals[1])];
  });
  assert.deepEqual(r, [48667, 2000]);   // (850,000 − 120,000) ÷ 15 شهر (أكتوبر 2026 ← ديسمبر 2027)
});

await test('فلوس ليا: التقسيط على دفعات والاستلام', async page => {
  await ev(page, () => { ACT.tab({ tab: 'bills' }); ACT.sub({ k: 'bills', v: 'recv' }); });
  await page.click('[data-act="recvForm"]');
  await fill(page, 'name', 'أحمد'); await fill(page, 'total', '20000'); await fill(page, 'first', '2026-11-01'); await fill(page, 'count', '4');
  await submit(page);
  const sched = await ev(page, () => S.recvs[0].sched.map(x => x.date + ':' + x.amount));
  assert.deepEqual(sched, ['2026-11-01:5000', '2026-12-01:5000', '2027-01-01:5000', '2027-02-01:5000']);
  await ev(page, () => recvGet(S.recvs[0].id)); await submit(page);
  assert.equal(await ev(page, () => recvRemaining(S.recvs[0])), 15000);
});

await test('المحافظ: التحويل والرسوم والجرد لكل محفظة', async page => {
  const r = await ev(page, () => {
    S.wallets.push({ id: 'wb', name: 'البنك', icon: '🏦' });
    S.cashCounts.push({ id: 'c1', ts: 1, date: '2026-10-08', amount: 2000 }, { id: 'c2', ts: 2, date: '2026-10-08', amount: 10000, walletId: 'wb' });
    S.tx.push({ id: 'x', ts: 3, type: 'xfer', from: 'wb', to: 'w_main', amount: 1000, date: '2026-10-09' });
    S.tx.push({ id: 'f', ts: 4, type: 'exp', cat: 'other', amount: 5, walletId: 'wb', date: '2026-10-09' });
    save();
    const B = cashBalance();
    return { cash: B.wallets[0].value, bank: B.wallets[1].value, total: B.value, out: summary(VIEW).outActual };
  });
  assert.deepEqual(r, { cash: 3000, bank: 8995, total: 11995, out: 5 });
});

await test('كذا حاجة مع بعض: تسجيل فاتورة، ومسحها كلها، والتراجع', async page => {
  await ev(page, () => ACT.seedItems());
  await page.click('.fab'); await page.click('[data-act="qaMulti"]');
  const row = i => page.locator('#mlines .ml-row').nth(i);
  await row(0).locator('[data-f="amount"]').pressSequentially('120');
  await row(1).locator('[data-f="cat"]').selectOption('house');
  await row(1).locator('[data-f="item"]').selectOption({ label: 'رز' });
  await row(1).locator('[data-f="qty"]').fill('3');
  await row(1).locator('[data-f="amount"]').pressSequentially('120');
  await submit(page);
  const r = await ev(page, () => ({ n: S.tx.length, grp: new Set(S.tx.map(t => t.grp)).size, riceQty: S.tx.find(t => t.itemId).qty }));
  assert.deepEqual(r, { n: 2, grp: 1, riceQty: 3 });
  await ev(page, () => ACT.delGroup({ id: S.tx[0].grp }));
  assert.equal(await ev(page, () => S.tx.length), 0);
  await page.click('#undoBar button');
  assert.equal(await ev(page, () => S.tx.length), 2);
});

await test('حدود التصنيفات: تنبيه عند 80%', async page => {
  const r = await ev(page, () => {
    S.cats.find(c => c.id === 'food').limit = 1000;
    S.tx.push({ id: 'a', ts: 1, type: 'exp', cat: 'food', amount: 850, date: '2026-10-05' }); save();
    return limitMsg('food');
  });
  assert.equal(r.bad, false);
  assert.match(r.t, /85%/);
});

await test('الكاش فلو: بيكتشف العجز قبل المرتب', async page => {
  const r = await ev(page, () => {
    S.incomes.push({ id: 'i1', name: 'المرتب', amount: 15000, day: 25 });
    S.bills.push({ id: 'b', name: 'إيجار', amount: 4000, dueDay: 12 });
    S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 3000 });
    save();
    const F = forecast(30, false);
    return { neg: F.firstNeg && F.firstNeg.date, payday: F.pts.find(x => x.ev.some(e => e.n.includes('المرتب'))).date };
  });
  assert.deepEqual(r, { neg: '2026-10-12', payday: '2026-10-25' });
});

await test('الحسابات المتخزنة مؤقتًا بتتحدّث بعد أي تسجيل', async page => {
  const a = await ev(page, () => summary(VIEW).varSpent);
  await page.click('.fab'); await fill(page, 'amount', '70'); await submit(page);
  assert.deepEqual([a, await ev(page, () => summary(VIEW).varSpent)], [0, 70]);
});

await test('كل الصفحات بتتعرض من غير أخطاء', async page => {
  for (const t of ['home', 'log', 'stock', 'bills', 'goals', 'report', 'cash', 'settings']) await ev(page, tab => ACT.tab({ tab }), t);
  for (const v of ['jard', 'shop']) await ev(page, v => { ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v }); }, v);
  for (const v of ['dues', 'debts', 'recv']) await ev(page, v => { ACT.tab({ tab: 'bills' }); ACT.sub({ k: 'bills', v }); }, v);
});

await test('المزامنة: جهاز جديد وهو بيحمّل ما يمسحش الشيت، والدمج ما يضيّعش حاجة، والمسح ما يترفعش', async page => {
  const SYNC = URL_ + 'exec';
  const tx = Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, ts: i, type: 'exp', cat: 'food', amount: 10, date: '2026-10-05' }));
  Object.assign(FAKE, { value: JSON.stringify({ v: 1, updatedAt: 1000, settings: { cycleDay: 1 }, tx }), updatedAt: 1000, delay: 2000, posts: 0 });
  // موبايل جديد فاضي، المزامنة متوصلة، والشيت بطيء — والمستخدم بيسجل مصروف قبل ما التحميل يخلص
  await ev(page, sync => { S.settings.syncUrl = sync; S.settings.syncSecret = ''; persist(); pullRemote(false); }, SYNC);
  await page.click('.fab'); await fill(page, 'amount', '55'); await submit(page);
  await page.waitForTimeout(1200);
  assert.equal(FAKE.posts, 0, 'رفع قبل ما يخلص التحميل من الشيت');
  await page.waitForTimeout(3000);
  assert.equal(await ev(page, () => S.tx.length), 41, 'الموبايل لازم يبقى فيه بيانات الشيت + المصروف الجديد');
  assert.equal(txCount(FAKE.value), 41, 'الشيت لازم يبقى فيه الكل');
  FAKE.delay = 0;
  // المسح على الجهاز ما يترفعش تلقائي فوق الشيت
  await ev(page, sync => { S = fresh(); S.settings.syncUrl = sync; S.updatedAt = Date.now(); persist(); pushRemote(false); }, SYNC);
  await page.waitForTimeout(1200);
  assert.equal(txCount(FAKE.value), 41, 'نسخة فاضية اترفعت فوق الشيت');
});

await browser.close();
server.close();
console.log(`\n${passed} نجح · ${failed} فشل`);
process.exit(failed ? 1 : 0);
