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
const FAKE = { value: null, updatedAt: 0, delay: 0, postDelay: 0, posts: 0 };
const txCount = j => { try { return (JSON.parse(j).tx || []).length; } catch (e) { return 0; } };
function fakeSheet(req, res) {
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const send = o => { res.writeHead(200, H); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') return setTimeout(() => send({ ok: true, value: FAKE.value, updatedAt: FAKE.updatedAt }), FAKE.delay);
  let body = ''; req.on('data', c => body += c); req.on('end', () => setTimeout(() => {
    const b = JSON.parse(body); FAKE.posts++;
    if (!b.force) {
      if (FAKE.updatedAt && b.updatedAt < FAKE.updatedAt) return send({ ok: false, code: 'stale' });
      if (FAKE.value && b.value.length < FAKE.value.length * 0.6) return send({ ok: false, code: 'shrink' });
      const o = txCount(FAKE.value), n = txCount(b.value);
      if (o >= 10 && n < o * 0.8) return send({ ok: false, code: 'shrink' });
    }
    FAKE.value = b.value; FAKE.updatedAt = b.updatedAt; send({ ok: true });
  }, FAKE.postDelay));
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
    return { rice: Math.round(learnedDaily(rz) * 30), buy: qtyPlain(mk, x.qty).replace(/[\u2066\u2069]/g, ''), cost: Math.round(x.cost) };
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
  // اتشرى النهارده → بيسأل: خلص بعد ما اشتريت (الجركن كله خلص)
  await page.click('#sheetBody input[name="when"][value="after"] + .evopt'); await submit(page);
  assert.match(await page.textContent('#toast'), /صابون سايل: من آخر جرد \(8 يوم\)/);
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
  const mp = async (n, y, m) => { await page.selectOption(`#sheetBody [data-mp="${n}"][data-mpk="y"]`, y); await page.selectOption(`#sheetBody [data-mp="${n}"][data-mpk="m"]`, m); };
  await mp('deadline', '2027', '12'); await mp('start', '2027', '01');
  assert.equal(await page.inputValue('#sheetBody [name="start"]'), '2027-01');
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

await test('خطة الشهر: الاستوك = اللي اتصرف + اللي فاضل تشتريه لآخر الشهر', async page => {
  const r = await ev(page, () => {
    S.items.push({ id: 'z', name: 'رز', group: 'تموين', base: 'KG', monthly: 30, price: 10 });   // كيلو في اليوم
    S.counts.push({ id: 'k', ts: 1, itemId: 'z', date: '2026-10-09', qty: 5 });
    S.tx.push({ id: 'b', ts: 2, type: 'exp', cat: 'house', itemId: 'z', qty: 2, amount: 50, date: '2026-10-09' });
    S.settings.coverMode = 'period'; S.settings.bufferDays = 3;
    save(); const o = summary(VIEW);
    return [o.houseSpent, Math.round(o.houseToBuy), Math.round(o.houseReserved), Math.round(o.houseMonthly), Math.round(sum(shopList(), x => x.cost))];
  });
  // من 9 لـ 31 أكتوبر = 23 يوم + 3 احتياطي = 26 كيلو، عندك 7 → تشتري 19 × 10 = 190 — نفس قايمة الشراء بالظبط
  assert.deepEqual(r, [50, 190, 240, 300, 190]);
});

await test('خطة الشهر: المواعيد بتتخصم بس لما تشيل فعلًا', async page => {
  const r = await ev(page, () => {
    S.incomes.push({ id: 'i', name: 'المرتب', amount: 10000, day: 1 });
    S.dues.push({ id: 'u', name: 'المدرسة', amount: 3000, baseAmount: 3000, date: '2026-12-15', repeat: 0 }); save();
    const a = summary(VIEW);
    S.tx.push({ id: 'r', ts: 1, type: 'reserve', dueId: 'u', dueDate: '2026-12-15', amount: 400, date: '2026-10-09' }); save();
    const b = summary(VIEW), next = summary(addMonths(VIEW, 1));
    return [Math.round(a.reservePlanned), Math.round(a.reserveToDo), Math.round(b.reservePlanned), Math.round(b.reserveToDo), Math.round(next.reservePlanned)];
  });
  // 3000 على 3 شهور = 1000 الشهر ده؛ الشهر الجاي (تخطيط) بيتحسب بالمطلوب: (3000−400)÷2
  assert.deepEqual(r, [0, 1000, 400, 600, 1300]);
});

await test('فاضل للمصروف من الخزنة: المحجوز + اللي لسه عليك + الفاضل = الخزنة', async page => {
  const r = await ev(page, () => {
    S.incomes.push({ id: 'i', name: 'المرتب', amount: 10000, day: 1 });
    S.bills.push({ id: 'bl', name: 'نت', amount: 1000, dueDay: 20 });
    S.dues.push({ id: 'u', name: 'المدرسة', amount: 3000, baseAmount: 3000, date: '2026-12-15', repeat: 0 });
    S.tx.push({ id: 'in', ts: 1, type: 'inc', incomeId: 'i', amount: 10000, date: '2026-10-01' });
    S.cashCounts.push({ id: 'c', ts: 2, date: '2026-10-02', amount: 8000 });        // معاه أقل: 2000 اتصرفوا من غير تسجيل
    S.tx.push({ id: 'rs', ts: 3, type: 'reserve', dueId: 'u', dueDate: '2026-12-15', amount: 3000, date: '2026-10-05' });
    S.tx.push({ id: 'e', ts: 4, type: 'exp', cat: 'food', amount: 500, date: '2026-10-06' });
    save(); const o = summary(VIEW);
    S.incomes.push({ id: 'i2', name: 'دخل تاني', amount: 5000, day: 25 }); save();   // دخل لسه ما نزلش
    const o2 = summary(VIEW);
    return { safe: o.safe, res: o.reservedAll, owed: o.owedLeft, free: o.free, gap: Math.round(o.cashGap), sum: o.reservedAll + o.owedLeft + o.free,
      free2: o2.free, pending: o2.incPending };
  });
  // رصيد = 8000 − 3000 − 500 = 4500 · الخزنة 7500 · لسه عليك النت 1000 · فاضل 3500 — والدخل اللي لسه ما نزلش مش بيزوّده
  assert.deepEqual(r, { safe: 7500, res: 3000, owed: 1000, free: 3500, gap: -2000, sum: 7500, free2: 3500, pending: 5000 });
});

await test('مراجعة الاستوك: صفر+صفر، تغيير العبوة، المبلغ المقترح، تعديل الشراء', async page => {
  const r = await ev(page, () => {
    // صفر وبعده صفر: يرجع للتقديري ويفضل في قايمة الشراء
    S.items.push({ id: 'z', name: 'سكر', group: 'تموين', base: 'PCS', monthly: 30, price: 2 });
    S.counts.push({ id: 'a', ts: 1, itemId: 'z', date: '2026-09-20', qty: 0 }, { id: 'b', ts: 2, itemId: 'z', date: '2026-10-09', qty: 0 });
    S.items.push({ id: 'm', name: 'مكرونة', group: 'تموين', base: 'KG', pu: 'كيس', pf: 0.45, monthly: 4.5, price: 100 / 3 });
    save();
    return { rate: dailyRate(byId(S.items, 'z')).v, buy: shopList().find(x => x.it.id === 'z').qty };
  });
  assert.deepEqual(r, { rate: 1, buy: 33 });
  // تغيير العبوة من كيس 0.45 لكرتونة 4.5 من غير لمس الأرقام: القيمة بالكيلو ما تتغيرش
  await ev(page, () => itemForm('m'));
  await page.selectOption('#sheetBody [name="pu"]', 'كرتونة'); await fill(page, 'pf', '4.5');
  await page.dispatchEvent('#sheetBody [name="pf"]', 'change');
  await submit(page);
  assert.deepEqual(await ev(page, () => { const it = byId(S.items, 'm'); return [it.pf, +it.monthly.toFixed(3), +it.price.toFixed(2)]; }), [4.5, 4.5, 33.33]);
  // فتح الصنف وحفظه من غير تغيير ما يزحزحش الأرقام
  await ev(page, () => { byId(S.items, 'z').monthly = 1; byId(S.items, 'z').pu = 'طبق'; byId(S.items, 'z').pf = 30; save(); itemForm('z'); });
  await submit(page);
  assert.equal(await ev(page, () => byId(S.items, 'z').monthly), 1);
  // الشراء بالمبلغ المقترح زي ما هو ما يغيرش السعر، والكمية بتحدّث المبلغ
  await ev(page, () => { byId(S.items, 'm').pu = 'كيس'; byId(S.items, 'm').pf = 0.5; byId(S.items, 'm').price = 30; save(); buyItem('m'); });
  await fill(page, 'qty', 3);
  assert.equal(await page.inputValue('#sheetBody [name="amount"]'), '45');
  await submit(page);
  assert.deepEqual(await ev(page, () => [S.tx.at(-1).qty, S.tx.at(-1).amount, byId(S.items, 'm').price]), [1.5, 45, 30]);
  // تعديل الشراء: الكمية بالكيس، والسعر يتظبط لو دي آخر مرة
  await ev(page, () => quickAdd({ tx: S.tx.at(-1) }));
  assert.equal(await page.inputValue('#sheetBody [name="qty"]'), '3');
  await fill(page, 'qty', 2); await fill(page, 'amount', 40); await submit(page);
  assert.deepEqual(await ev(page, () => [S.tx.at(-1).qty, byId(S.items, 'm').price]), [1, 40]);
});

await test('مراجعة الحسابات: السحب من الهدف، الشهور الجاية، سقف التحويش، الديون المسددة، التواريخ', async page => {
  const r = await ev(page, () => {
    const out = {};
    // سحب من هدف: المطلوب ما يزيدش والفلوس تفضل في "فاضل"
    S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.goals.push({ id: 'g', name: 'عربية', target: 100000, initial: 40000, deadline: '2027-09' });
    S.tx.push({ id: 'w', ts: 2, type: 'save', goalId: 'g', amount: -3000, date: '2026-10-09' });
    save(); let o = summary(VIEW); out.withdraw = [Math.round(o.owedLeft), Math.round(o.free)];
    S.goals = []; S.tx = []; S.cashCounts = [];
    // الشهور الجاية: هدف بيبدأ يناير، ميعاد 3000 في ديسمبر شايل له 400، ميعاد شهري 600، دين 3000 بقسط 1000
    S.goals.push({ id: 'g2', name: 'عربية', target: 120000, deadline: '2027-12', start: '2027-01' });
    S.dues.push({ id: 'u', name: 'مدرسة', amount: 3000, baseAmount: 3000, date: '2026-12-15', repeat: 0 });
    S.dues.push({ id: 'm', name: 'نادي', amount: 600, baseAmount: 600, date: '2026-10-20', repeat: 1, dom: 20 });
    S.tx.push({ id: 'rs', ts: 3, type: 'reserve', dueId: 'u', dueDate: '2026-12-15', amount: 400, date: '2026-10-09' });
    S.debts.push({ id: 'd', name: 'سلفة', total: 3000, monthly: 1000, dueDay: 5 });
    save();
    const at = k => summary(addMonths(VIEW, k));
    out.goalJan = Math.round(at(3).savePlanned);
    out.duesNovDec = [1, 2].map(k => Math.round(sum(at(k).dueLines.filter(l => l.d.id === 'u'), l => l.planned)));
    out.monthly = [1, 2].map(k => Math.round(sum(at(k).dueLines.filter(l => l.d.id === 'm'), l => l.planned)));
    out.debt = [0, 1, 2, 3, 4].map(k => Math.round(at(k).debtPlanned));
    // دين اتسدد كله من غير الميعاد: الميعاد بتاعه يختفي
    S.dues.push({ id: 'dd', name: '', debtId: 'd', amount: 3000, baseAmount: 3000, date: '2026-12-01', repeat: 0 });
    S.tx.push({ id: 'pd', ts: 4, type: 'debt', debtId: 'd', amount: 3000, date: '2026-10-09' }); save();
    out.paidDue = activeDues().some(d => d.id === 'dd');
    // سقف التحويش: فاضل 500 بس
    S.goals = [{ id: 'g3', name: 'موبايل', target: 3000, initial: 2500, monthly: 2000, deadline: '2027-06' }]; save();
    out.cap = [Math.round(goalPlanMonthly(S.goals[0])), Math.round(-sum(forecast(90).pts.flatMap(p => p.ev).filter(e => e.goal), e => e.a))];
    // التواريخ: يوم 31 ما يزحفش، ولما الشهر بيبدأ 25 فاتورة يوم 31 تيجي آخر سبتمبر
    out.dom = [addMonthsDate('2027-01-31', 1, 31), addMonthsDate('2027-02-28', 1, 31)];
    S.settings.cycleDay = 25; out.d31 = dueDateIn(periodRange({ y: 2026, m: 8 }), 31); S.settings.cycleDay = 1;
    return out;
  });
  assert.deepEqual(r, { withdraw: [5000, 8000], goalJan: 10000, duesNovDec: [1300, 1300], monthly: [600, 600], debt: [1000, 1000, 1000, 0, 0],
    paidDue: false, cap: [500, 500], dom: ['2027-02-28', '2027-03-31'], d31: '2026-09-30' });
});

await test('مراجعة التسجيل: مسح دفعة ميعاد، تعديل ميعاد مدفوع جزء منه، المحفظة في التعديل، عنوان اليوم', async page => {
  await ev(page, () => { S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.dues.push({ id: 'u', name: 'تأمين', amount: 3000, baseAmount: 3000, date: '2026-12-15', repeat: 0 });
    S.tx.push({ id: 'r', ts: 2, type: 'reserve', dueId: 'u', dueDate: '2026-12-15', amount: 1000, date: '2026-10-09' }); save(); payDue('u'); });
  await submit(page);
  assert.deepEqual(await ev(page, () => [cashBalance().value, !!byId(S.dues, 'u').paidOn]), [7000, true]);
  // مسح الدفعة من اليومية: الميعاد يرجع والمحجوز يرجع محجوز
  await ev(page, () => ACT.delTx({ id: S.tx.find(t => t.type === 'bill').id }));
  assert.deepEqual(await ev(page, () => [cashBalance().value, !!byId(S.dues, 'u').paidOn, totalReserved(), S.tx.length]), [9000, false, 1000, 1]);
  // دفع جزء وبعدين فتح الميعاد وحفظه زي ما هو: الباقي يفضل 2500
  await ev(page, () => payDue('u')); await fill(page, 'amount', 500); await submit(page);
  await ev(page, () => dueForm('u')); await submit(page);
  assert.equal(await ev(page, () => byId(S.dues, 'u').amount), 2500);
  // تعديل حركة قديمة من غير محفظة: تفضل في محفظتها
  const w = await ev(page, () => { S.wallets.push({ id: 'w2', name: 'بنك', icon: '🏦' }); S.settings.lastWallet = 'w2';
    S.tx.push({ id: 'old', ts: 5, type: 'exp', cat: 'food', amount: 50, date: '2026-10-09' }); save(); quickAdd({ tx: byId(S.tx, 'old') }); return 0; });
  await fill(page, 'note', 'ملاحظة'); await submit(page);
  assert.equal(await ev(page, () => walletOf(byId(S.tx, 'old'))), 'w_main');
  // عنوان اليوم ما يكتبش "−-200" لما فيه سحب من هدف
  const head = await ev(page, () => { S.tx = [{ id: 'wd', ts: 6, type: 'save', goalId: 'x', amount: -200, date: '2026-10-07' }]; save(); ACT.tab({ tab: 'log' }); return document.querySelector('.day-h').textContent; });
  assert.ok(!head.includes('−-'), head);
});

await test('جرد صنف لوحده: الاستهلاك بيتحسب بالساعة من آخر جرد، ورسالة بالنتيجة', async page => {
  await ev(page, () => {
    S.items.push({ id: 's', name: 'سكر', group: 'تموين', base: 'KG', pu: 'كيس', pf: 1, monthly: 2, price: 30 });
    S.counts.push({ id: 'p', ts: new Date('2026-10-03T04:00:00').getTime(), itemId: 's', date: '2026-10-03', qty: 1.8 }); save(); countItem('s');
  });
  await fill(page, 'qty', '1.5'); await submit(page);
  const msg = (await page.textContent('#toast')).replace(/[\u2066\u2069]/g, '');
  assert.match(msg, /6 يوم و6 ساعة/); assert.match(msg, /استهلكت 1.5 كيس|استهلكت 0.3/);
  assert.match(msg, /1.44/);
  // معدل متعلَّم بالساعة، والمتوقع بيقل بالساعة
  const r = await ev(page, () => {
    S.counts.push({ id: 'a', ts: new Date('2026-10-01T10:00:00').getTime(), itemId: 'z', date: '2026-10-01', qty: 2 },
      { id: 'b', ts: new Date('2026-10-09T08:00:00').getTime(), itemId: 'z', date: '2026-10-09', qty: 1.2 });
    S.items.push({ id: 'z', name: 'رز', group: 'تموين', base: 'KG', monthly: 30 }); save();
    const it = byId(S.items, 'z');
    return [+(learnedDaily(it)).toFixed(4), +estStock(it).toFixed(4)];
  });
  // 0.8 كيلو في 7 يوم و22 ساعة = 0.10105/يوم · من 8 الصبح لـ 10 = ساعتين
  assert.deepEqual(r, [+(0.8 / (7 + 22 / 24)).toFixed(4), +(1.2 - 0.8 / (7 + 22 / 24) * 2 / 24).toFixed(4)]);
});

await test('جرد صنف واحد بس بيحدّث قايمة الشراء على طول (من الجرد ومن جرد الصنف)', async page => {
  const buy = n => ev(page, n => { const x = shopList().find(y => y.it.name === n); return [+x.have.toFixed(2), x.qty]; }, n);
  await ev(page, () => { ACT.seedItems(); S.items.forEach(it => { it.monthly = 3; it.price = 20; }); const t = new Date('2026-10-02T10:00:00').getTime();
    S.items.forEach((it, i) => S.counts.push({ id: 'k' + i, ts: t + i, itemId: it.id, date: '2026-10-02', qty: it.monthly * 2 })); save();
    ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' }); });
  const before = await buy('سكر'), other = await buy('رز');
  assert.equal(before[1], 0, 'قبل الجرد: عنده كفاية');
  const id = await ev(page, () => S.items.find(i => i.name === 'سكر').id);
  await page.fill(`#jardForm input[data-item="${id}"]`, '0.5'); await page.click('[data-act="saveJard"]');
  if (await page.isVisible('#sheetWrap.open')) await submit(page);
  const after = await buy('سكر');
  assert.ok(after[0] < 0.6 && after[1] > 0, 'السكر لازم يدخل القايمة: ' + after);
  assert.deepEqual(await buy('رز'), other, 'الأصناف التانية ما تتغيرش');
  // ومن "جرد الصنف ده"
  await ev(page, () => countItem(S.items.find(i => i.name === 'رز').id)); await fill(page, 'qty', '0'); await submit(page);
  assert.ok((await buy('رز'))[1] > 0);
  await ev(page, () => ACT.sub({ k: 'stock', v: 'shop' }));
  assert.ok(await page.isVisible('text=سكر') && await page.isVisible('text=رز'));
});

await test('من غير جرد: "خلص" ← شراء ← "خلص" بيحسب الاستهلاك الحقيقي', async page => {
  const r = await ev(page, () => {
    S.items.push({ id: 'f', name: 'فول', group: 'تموين', base: 'KG', pu: 'كيس', pf: 0.5, monthly: 1, price: 40 });
    const at = s => new Date(s).getTime();
    S.counts.push({ id: 'o1', ts: at('2026-09-20T20:00:00'), itemId: 'f', date: '2026-09-20', qty: 0 });            // خلص
    S.tx.push({ id: 'b1', ts: at('2026-09-21T12:00:00'), type: 'exp', cat: 'house', itemId: 'f', qty: 1.5, amount: 120, date: '2026-09-21' });   // اشترى 3 أكياس
    S.counts.push({ id: 'o2', ts: at('2026-10-09T08:00:00'), itemId: 'f', date: '2026-10-09', qty: 0 });            // خلص تاني
    save(); const it = byId(S.items, 'f');
    return { perMonth: +(learnedDaily(it) * 30).toFixed(2), src: dailyRate(it).src };
  });
  // 1.5 كيلو في 18.5 يوم → 2.43 كيلو في الشهر، محسوب من غير ولا جرد
  assert.deepEqual(r, { perMonth: +(1.5 / 18.5 * 30).toFixed(2), src: 'learned' });
});

await test('إيقاف صنف: "مش الشهر ده" و"موسمي" بيطلعوه من القايمة والخطة، و"رجّعه" بيرجّعه', async page => {
  await ev(page, () => { S.items.push({ id: 'mg', name: 'مانجا', group: 'فاكهة', base: 'KG', monthly: 3, price: 60 }, { id: 'tm', name: 'طماطم', group: 'خضار', base: 'KG', monthly: 6, price: 20 }); save();
    ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'shop' }); });
  const inList = () => ev(page, () => shopList().filter(x => x.qty > 0).map(x => x.it.id).sort());
  const toBuy = () => ev(page, () => Math.round(summary(VIEW).houseToBuy));
  assert.deepEqual(await inList(), ['mg', 'tm']);
  const all = await toBuy();
  await page.click('tr[data-id="mg"] [data-act="itemPause"]'); await page.click('#sheetBody [data-v="always"]');
  assert.deepEqual(await inList(), ['tm']);
  assert.ok(await toBuy() < all, 'المانجا لازم تطلع من الخطة');
  assert.ok(await page.isVisible('text=موسمي — لحد ما ترجّعه'));
  await page.click('tr[data-id="tm"] [data-act="itemPause"]'); await page.click('#sheetBody [data-v="month"]');
  assert.deepEqual([await inList(), await ev(page, () => byId(S.items, 'tm').pause)], [[], '2026-10-31']);
  await page.click('[data-act="itemResume"][data-id="mg"]');
  assert.deepEqual(await inList(), ['mg']);
});

await test('البيت بيتكلف كام في الشهر: التزامات + استوك بالمجموعات + التصنيفات المختارة بس', async page => {
  const r = await ev(page, () => {
    S.bills.push({ id: 'el', name: 'كهربا', amount: 600, dueDay: 5 }, { id: 'ph', name: 'باقة موبايل', amount: 200, dueDay: 5 });
    S.items.push({ id: 'a', name: 'رز', group: 'تموين', base: 'KG', monthly: 10, price: 30 }, { id: 'b', name: 'صابون', group: 'منظفات', base: 'L', monthly: 2, price: 50 },
      { id: 'c', name: 'مانجا', group: 'فاكهة', base: 'KG', monthly: 3, price: 60, pause: 'always' });
    S.tx.push({ id: 'm', ts: 1, type: 'exp', cat: 'market', amount: 900, date: '2026-10-05' }, { id: 't', ts: 2, type: 'exp', cat: 'transport', amount: 500, date: '2026-10-05' });
    S.settings.homeBillsOff = ['ph']; save();
    const H = homeCost();
    return { total: Math.round(H.total), names: H.lines.map(l => l.name) };
  });
  // كهربا 600 + تموين 300 + منظفات 100 + خضار: 900 في 9 أيام → 3100 متوقع للشهر · من غير الموبايل والمواصلات والمانجا الموسمية
  assert.deepEqual(r, { total: 4100, names: ['سوبر ماركت وخضار', 'كهربا', 'استوك: تموين', 'استوك: منظفات'] });
  await ev(page, () => ACT.tab({ tab: 'report' }));
  assert.ok(await page.isVisible('text=البيت بيتكلف كام في الشهر'));
});

await test('حذف تصنيف: تختار المصروفات تتنقل لأنهي تصنيف، وتقدر تتراجع', async page => {
  await ev(page, () => { S.cats.push({ id: 'cafe', name: 'كافيه', icon: '☕' }); S.tx.push({ id: 'x', ts: 1, type: 'exp', cat: 'cafe', amount: 40, date: '2026-10-09' }); save(); ACT.delCat({ id: 'cafe' }); });
  await page.selectOption('#sheetBody [name="to"]', 'food'); await submit(page);
  assert.deepEqual(await ev(page, () => [S.cats.some(c => c.id === 'cafe'), byId(S.tx, 'x').cat]), [false, 'food']);
  await page.click('#undoBar [data-act="undo"]');
  assert.deepEqual(await ev(page, () => [S.cats.some(c => c.id === 'cafe'), byId(S.tx, 'x').cat]), [true, 'cafe']);
});

await test('خطة الشهر: سطور الخطة بتتجمع بالظبط لـ"متاح" و"فاضل" = حر للصرف', async page => {
  const r = await ev(page, () => {
    S.incomes.push({ id: 'i', name: 'مرتب', amount: 20000, day: 1 }, { id: 'i2', name: 'تاني', amount: 3000, day: 25 });
    S.bills.push({ id: 'b', name: 'كهربا', amount: 800, dueDay: 5 });
    S.dues.push({ id: 'u', name: 'عيد ميلاد', kind: 'event', amount: 1000, baseAmount: 1000, date: '2026-12-01', repeat: 12 });
    S.tx.push({ id: 'in', ts: 1, type: 'inc', incomeId: 'i', amount: 20000, date: '2026-10-01' }, { id: 'bp', ts: 2, type: 'bill', billId: 'b', amount: 800, date: '2026-10-05' },
      { id: 'l', ts: 3, type: 'lend', amount: 500, date: '2026-10-06' }, { id: 'ev', ts: 4, type: 'exp', cat: 'gifts', dueId: 'u', amount: 300, date: '2026-10-06' },
      { id: 'e', ts: 5, type: 'exp', cat: 'food', amount: 700, date: '2026-10-07' });
    S.cashCounts.push({ id: 'c', ts: 10, date: '2026-10-08', amount: 15000 });
    S.tx.push({ id: 'e2', ts: 11, type: 'exp', cat: 'food', amount: 200, date: '2026-10-09' });
    save(); const o = summary(VIEW);
    ACT.tab({ tab: 'home' });
    const lines = [...document.querySelectorAll('.plan-line')].map(el => [el.querySelector('span').textContent.trim().split('\n')[0], el.querySelector('b.num') ? el.querySelector('b.num').textContent : '']);
    const val = s => +s.replace(/[^\d.-]/g, '').replace(/^-?/, m => m) * (s.trim().startsWith('−') ? -1 : 1);
    const nums = lines.map(([k, v]) => [k, val(v)]);
    const idx = nums.findIndex(([k]) => k.includes('متاح للمصروف'));
    const top = nums.slice(0, idx).reduce((a, [, v]) => a + v, 0);
    return { top: Math.round(top), avail: Math.round(o.varAvail), card: Math.round(nums[idx][1]), free: Math.round(o.free), heroFree: document.querySelector('#heroMain').textContent.includes(fmt(o.free)) };
  });
  assert.equal(r.top, r.avail, 'مجموع السطور لازم = المتاح');
  assert.equal(r.card, r.avail); assert.ok(r.heroFree, 'حر للصرف فوق لازم = فاضل للمصروف');
  // معاه 15000 − 200 = 14800، مفيش حاجة لسه عليه → فاضل 14800
  assert.equal(r.free, 14800);
  // صرف النهاردة 200 → الفاضل يتقسم من بكرة: 14800 ÷ 22 يوم (10 لـ 31 أكتوبر)
  const txt = await page.textContent('.plan-line.total + .muted');
  assert.match(txt.replace(/[\u2066\u2069]/g, ''), /14,800 ÷ 22 يوم \(من بكرة لآخر الشهر\) = حوالي 673/);
});

await test('مناسبة: تصرف عليها على كذا مرة ("لسه هكمل")، وبعدين "خلصت" والباقي يرجع للرصيد', async page => {
  await ev(page, () => { S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.dues.push({ id: 'b', name: 'عيد ميلاد دودو', kind: 'event', cat: 'gifts', amount: 2000, baseAmount: 2000, date: '2026-10-31', repeat: 12, dom: 31 });
    S.tx.push({ id: 'r', ts: 2, type: 'reserve', dueId: 'b', dueDate: '2026-10-31', amount: 2000, date: '2026-10-09' }); save(); payDue('b'); });
  await fill(page, 'amount', 800); await page.selectOption('#sheetBody [name="cat"]', 'food'); await fill(page, 'note', 'تورتة'); await submit(page);   // الافتراضي: لسه هكمل
  assert.deepEqual(await ev(page, () => [S.tx.at(-2).cat, S.tx.at(-2).note]), ['food', 'عيد ميلاد دودو — تورتة']);
  const s1 = await ev(page, () => { const d = byId(S.dues, 'b'); return [d.amount, d.date, totalReserved(), cashBalance().value]; });
  assert.deepEqual(s1, [1200, '2026-10-31', 1200, 8000]);
  await ev(page, () => payDue('b'));
  assert.match(await page.textContent('#sheetBody .note'), /اتصرف عليها قبل كده 800/);
  await fill(page, 'amount', 900); await page.click('#sheetBody input[name="evdone"][value="1"] + .evopt'); await submit(page);
  const s2 = await ev(page, () => { const d = byId(S.dues, 'b'); return [d.amount, d.date, totalReserved(), cashBalance().value]; });
  // اتصرف 1700 من 2000 → الـ300 الباقيين رجعوا للرصيد، والمناسبة الجاية السنة الجاية بنفس الميزانية
  assert.deepEqual(s2, [2000, '2027-10-31', 0, 8300]);
});

await test('مناسبة: تعديلها بعد ما صرفت عليها ما يرجّعش الميزانية كاملة، والمحجوز الزيادة يرجع، وتربط مصروف قديم بيها', async page => {
  const st = () => ev(page, () => { const d = byId(S.dues, 'b'); return [d.amount, Math.round(dueReserved(d)), Math.round(cashBalance().value)]; });
  await ev(page, () => { S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.dues.push({ id: 'b', name: 'عيد ميلاد دودو', kind: 'event', cat: 'gifts', amount: 2000, baseAmount: 2000, date: '2026-10-31', repeat: 12, dom: 31 });
    S.tx.push({ id: 'r', ts: 2, type: 'reserve', dueId: 'b', dueDate: '2026-10-31', amount: 1000, date: '2026-10-08' },
      { id: 'x', ts: 3, type: 'exp', cat: 'gifts', amount: 250, note: 'طقم لدودو', date: '2026-10-08' }); save(); payDue('b'); });
  await fill(page, 'amount', 450); await submit(page);
  assert.deepEqual(await st(), [1550, 550, 8750]);
  // فتحت المناسبة وحفظتها (غيرت التصنيف مثلًا): الفاضل يفضل 1550 مش يرجع 2000
  await ev(page, () => eventForm('b')); await page.selectOption('#sheetBody [name="cat"]', 'food'); await submit(page);
  assert.deepEqual(await st(), [1550, 550, 8750]);
  await ev(page, () => payDue('b')); await fill(page, 'amount', 300); await submit(page);
  assert.deepEqual(await st(), [1250, 250, 8750]);
  // بيانات اتلخبطت قبل الإصلاح (الفاضل اترجع 1700): بيتصلح لوحده من الحركات
  await ev(page, () => { byId(S.dues, 'b').amount = 1700; save(); });
  assert.deepEqual(await st(), [1250, 250, 8750]);
  // شلت أكتر من الفاضل → "شايل زيادة" وزرار يرجّعها لرصيدك
  await ev(page, () => { S.tx.push({ id: 'r2', ts: 9, type: 'reserve', dueId: 'b', dueDate: '2026-10-31', amount: 1450, date: '2026-10-09' }); save(); ACT.tab({ tab: 'bills' }); ACT.sub({ k: 'bills', v: 'dues' }); });
  assert.match(await page.textContent('body'), /شايل زيادة/);
  await page.click('[data-act="unreserveExtra"]');
  assert.deepEqual(await st(), [1250, 1250, 7750]);
  // المصروف القديم (250 طقم) تربطه بالمناسبة من تعديله: يتطرح من فاضلها ومن المحجوز، والخزنة ما تتغيرش
  await ev(page, () => quickAdd({ tx: byId(S.tx, 'x') })); await page.selectOption('#sheetBody [name="ev"]', 'b'); await submit(page);
  assert.deepEqual(await st(), [1000, 1000, 8000]);
  // وتفك الربط تاني
  await ev(page, () => quickAdd({ tx: byId(S.tx, 'x') })); await page.selectOption('#sheetBody [name="ev"]', ''); await submit(page);
  assert.deepEqual(await st(), [1250, 1250, 7750]);
});

await test('جرد الفلوس: بتكتب الخزنة كلها (شامل المحجوز) والبرنامج بيطرح المحجوز لوحده', async page => {
  await ev(page, () => { S.cashCounts.push({ id: 'c', ts: 1, date: '2026-10-08', amount: 10000 });
    S.dues.push({ id: 'u', name: 'مدرسة', amount: 5000, baseAmount: 5000, date: '2026-12-15', repeat: 0 });
    S.tx.push({ id: 'r', ts: 2, type: 'reserve', dueId: 'u', dueDate: '2026-12-15', amount: 3000, date: '2026-10-08' }); save(); cashCount(); });
  assert.match(await page.textContent('#sheetBody'), /المفروض معاك 10,000/);
  await fill(page, 'amount', 10000); await submit(page);
  assert.deepEqual(await ev(page, () => [cashBalance().value, totalReserved(), S.tx.filter(t => t.type === 'exp').length]), [7000, 3000, 0]);
  // الخزنة فيها 9500 بس → 500 مصاريف ما اتسجلتش
  await ev(page, () => cashCount()); await fill(page, 'amount', 9500); await submit(page);
  assert.deepEqual(await ev(page, () => [cashBalance().value, totalReserved()]), [6500, 3000]);
});

await test('جرد الفلوس بعد جرد قديم (اتعمل بالطريقة القديمة): ما يسجّلش المحجوز كمصاريف', async page => {
  await ev(page, () => { S.dues.push({ id: 'u', name: 'سلفة', amount: 8000, baseAmount: 8000, date: '2026-12-01', repeat: 0 });
    S.tx.push({ id: 'r', ts: 1, type: 'reserve', dueId: 'u', dueDate: '2026-12-01', amount: 5000, date: '2026-10-05' });
    S.cashCounts.push({ id: 'old', ts: 2, date: '2026-10-08', amount: 8088 });   // جرد قديم: كتب الخزنة كلها
    save(); cashCount(); });
  await fill(page, 'amount', 8088); await submit(page);
  assert.deepEqual(await ev(page, () => [cashBalance().value, totalReserved(), S.tx.filter(t => t.type === 'exp').length]), [3088, 5000, 0]);
});

await test('دفع ميعاد من المحجوز: بيظهر في سطر المواعيد مش في الالتزامات الثابتة', async page => {
  await ev(page, () => { S.bills.push({ id: 'b', name: 'كهربا', amount: 1000, dueDay: 5 });
    S.dues.push({ id: 'u', name: 'سلفة', amount: 8000, baseAmount: 8000, date: '2026-12-01', repeat: 0 });
    S.tx.push({ id: 'r', ts: 1, type: 'reserve', dueId: 'u', dueDate: '2026-12-01', amount: 8000, date: '2026-10-05' }); save(); payDue('u'); });
  await fill(page, 'amount', 4000); await submit(page);
  const r = await ev(page, () => { const o = summary(VIEW); ACT.tab({ tab: 'home' });
    const line = [...document.querySelectorAll('.plan-line')].find(el => el.textContent.includes('مواعيد السداد'));
    return [o.billPlanned, o.duePaid, o.reservePlanned, line && line.querySelector('b.num').textContent.replace(/[^\d,]/g, '')]; });
  // الالتزامات الثابتة = الكهربا بس، وسطر المواعيد = 4000 اتدفعوا + 4000 لسه محجوزين
  assert.deepEqual(r, [1000, 4000, 4000, '8,000']);
});

await test('العيش خلص من أيام واشتريت كيس النهارده: المتوقع = الكيس، مش صفر', async page => {
  const r = await ev(page, () => {
    S.items.push({ id: 'b', name: 'عيش', group: 'تموين', base: 'PCS', pu: 'كيس', pf: 7, monthly: 56, price: 1.43 });
    // جرد 7 رغيفات من 10 أيام — بمعدل 56 في الشهر كانوا يخلصوا في أقل من 4 أيام
    S.counts.push({ id: 'c', ts: new Date('2026-09-29T09:00:00').getTime(), itemId: 'b', date: '2026-09-29', qty: 7 });
    S.tx.push({ id: 't', ts: Date.now(), type: 'exp', cat: 'house', itemId: 'b', qty: 7, amount: 10, date: todayS() });
    save(); const it = byId(S.items, 'b');
    return [+estStock(it).toFixed(2), shopList().find(x => x.it.id === 'b').have.toFixed(2)];
  });
  assert.deepEqual(r, [7, '7.00']);
  // ولو الشراء من يومين: الكيس يتحسب من يوم الشراء (7 − يومين استهلاك)
  const r2 = await ev(page, () => { const t = byId(S.tx, 't'); t.date = addDays(todayS(), -2); t.ts = new Date(t.date + 'T09:00:00').getTime(); save();
    return +estStock(byId(S.items, 'b')).toFixed(2); });
  const left = 7 - 56 / 30 * ((new Date('2026-10-09T10:00:00') - new Date('2026-10-07T09:00:00')) / 864e5);
  assert.ok(Math.abs(r2 - left) < 0.5, r2 + ' vs ' + left);
});

await test('صنف ما اتجردش خالص واشتريته: المتوقع = اللي اشتريته ناقص الاستهلاك من يوم الشراء', async page => {
  const r = await ev(page, () => {
    S.items.push({ id: 'rm', name: 'رمان', group: 'خضار وفاكهة', base: 'KG', pu: 'كيس', pf: 1, monthly: 3, price: 34 });
    S.tx.push({ id: 'b', ts: new Date('2026-10-08T10:00:00').getTime(), type: 'exp', cat: 'house', itemId: 'rm', qty: 1.74, amount: 60, date: '2026-10-08' });
    save(); return [+estStock(byId(S.items, 'rm')).toFixed(2)];
  });
  assert.equal(r[0], +(1.74 - 3 / 30).toFixed(2));   // يوم استهلاك
});

await test('شراء نص كيلو من صنف عبوته كيس كيلو: ضغطة "نص كيلو" والمبلغ يتحسب', async page => {
  await ev(page, () => { S.items.push({ id: 'tm', name: 'طماطم', group: 'خضار وفاكهة', base: 'KG', pu: 'كيس', pf: 1, monthly: 4, price: 20 }); save(); buyItem('tm'); });
  await page.click('#sheetBody [data-act="buyQuick"][data-q="0.5"]');
  assert.equal(await page.inputValue('#sheetBody [name="amount"]'), '10');
  assert.ok(await page.isVisible('#sheetWrap.open'), 'الشاشة تفضل مفتوحة');
  await submit(page);
  assert.deepEqual(await ev(page, () => { const x = S.tx.at(-1); return [x.qty, x.amount, x.u.n]; }), [0.5, 10, 'KG']);
});

await test('قايمة الشراء: الفرط (كيلو/لتر) بتقترح على قد الاستهلاك بالظبط، والعبوة المقفولة بعبوة كاملة', async page => {
  const r = await ev(page, () => {
    S.items.push({ id: 'tm', name: 'طماطم', group: 'خضار وفاكهة', base: 'KG', pu: 'كيس', pf: 1, monthly: 3.3, price: 20 },
      { id: 'zt', name: 'زيت', group: 'تموين', base: 'L', pu: 'زجاجة', pf: 0.8, monthly: 0.3, price: 100 },
      { id: 'sk', name: 'سكر', group: 'تموين', base: 'KG', pu: 'كيس', pf: 1, monthly: 3.3, price: 30, loose: false });
    ['tm', 'zt', 'sk'].forEach(id => S.counts.push({ id: 'c' + id, ts: 1, itemId: id, date: '2026-10-09', qty: 0 }));
    save(); const q = id => shopList().find(x => x.it.id === id).qty;
    return [q('tm'), q('zt'), q('sk'), shopQty(byId(S.items, 'tm'), 0.5), shopQty(byId(S.items, 'tm'), 1.5)];
  });
  // 3.3 كيلو في الشهر + 3 أيام احتياطي = 3.63 بالظبط · الزيت عبوة 0.8 كاملة · السكر متعلّم "مش فرط" → 4 أكياس
  assert.deepEqual(r, [3.63, 0.8, 4, 'نص كيلو', 'كيلو ونص']);
  // من الصنف: تشيل علامة "فرط" فتتحفظ
  await ev(page, () => itemForm('tm')); await page.uncheck('#sheetBody [name="loose"]'); await submit(page);
  assert.deepEqual(await ev(page, () => [byId(S.items, 'tm').loose, shopList().find(x => x.it.id === 'tm').qty]), [false, 4]);
});

await test('جرد أقل من اللي اتشرى النهارده: يسأل "قبل الشراء ولا بعده"، وجرد غلط يتمسح من الصنف', async page => {
  const est = () => ev(page, () => +estStock(byId(S.items, 'jb')).toFixed(2));
  await ev(page, () => { S.items.push({ id: 'jb', name: 'جبنة براميلي', group: 'ألبان وبروتين', base: 'KG', pu: 'طبق', pf: 1, monthly: 0.5, price: 200 });
    S.counts.push({ id: 'k0', ts: new Date('2026-10-05T09:00:00').getTime(), itemId: 'jb', date: '2026-10-05', qty: 0.2 });
    S.tx.push({ id: 'b', ts: Date.now() - 3600e3, type: 'exp', cat: 'house', itemId: 'jb', qty: 0.46, amount: 92, date: todayS() }); save(); countItem('jb'); });
  await fill(page, 'qty', '0'); await submit(page);
  assert.match(await page.textContent('#sheetBody'), /الجرد ده اتعمل امتى|قبل ما أشتري/);
  await submit(page);                                     // الافتراضي: قبل الشراء
  assert.equal(await est(), 0.46);
  // من الجرد الكبير: "بعد ما اشتريت" → اللي كتبته هو الموجود
  await ev(page, () => { ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' }); });
  await page.fill('#jardForm input[data-item="jb"]', '0.1'); await page.click('[data-act="saveJard"]');
  if (!(await page.textContent('#sheetBody')).includes('قبل ما أشتري')) await submit(page);
  await page.click('#sheetBody input[name="when"][value="after"] + .evopt'); await submit(page);
  assert.equal(await est(), 0.1);
  // جرد اتسجل غلط: يتمسح من شاشة الصنف ويرجع اللي قبله
  await ev(page, () => itemForm('jb'));
  await page.click(`#sheetBody [data-act="delCount"][data-id="${await ev(page, () => S.counts.at(-1).id)}"]`);
  assert.equal(await est(), 0.46);
});

await test('"خلص؟" بعد شراء النهارده بيسأل، ومسودة جرد اتكتبت امبارح بتتسجّل بوقت كتابتها', async page => {
  const est = () => ev(page, () => { EPOCH++; return +estStock(byId(S.items, 'jb')).toFixed(2); });
  await ev(page, () => { S.items.push({ id: 'jb', name: 'جبنة', group: 'ألبان وبروتين', base: 'KG', pu: 'طبق', pf: 1, monthly: 0, price: 200 });
    S.counts.push({ id: 'k0', ts: new Date('2026-10-05T09:00:00').getTime(), itemId: 'jb', date: '2026-10-05', qty: 0.2 });
    S.tx.push({ id: 'b', ts: Date.now() - 3600e3, type: 'exp', cat: 'house', itemId: 'jb', qty: 0.46, amount: 92, date: todayS() }); save(); ACT.itemOut({ id: 'jb' }); });
  assert.match(await page.textContent('#sheetBody'), /قبل ما أشتري/);
  await submit(page);                                    // خلص قبل ما اشتري → الشراء فاضل
  assert.equal(await est(), 0.46);
  // مسودة: كتبت 0.1 امبارح 9 بليل، واشتريت 0.5 النهارده، وحفظت دلوقتي → الجرد امبارح والشراء بعده
  await ev(page, () => { S.counts = S.counts.filter(c => c.id === 'k0'); S.tx = []; save();
    localStorage.setItem(JDRAFT_KEY, JSON.stringify({ jb: { v: '0.1', u: 'base', t: new Date('2026-10-08T21:00:00').getTime() } }));
    S.tx.push({ id: 'b2', ts: Date.now() - 600e3, type: 'exp', cat: 'house', itemId: 'jb', qty: 0.5, amount: 100, date: todayS() }); save();
    ACT.tab({ tab: 'stock' }); ACT.sub({ k: 'stock', v: 'jard' }); });
  await page.click('[data-act="saveJard"]');
  if (await page.isVisible('#sheetWrap.open')) await submit(page);
  assert.deepEqual(await ev(page, () => S.counts.at(-1).date), '2026-10-08');
  assert.equal(await est(), 0.6);
});

await test('فاتورة كل 3 شهور (الموبايل): بتتضاف من نفس الشاشة، وتظهر في الالتزامات، وبتتقسم على الشهور', async page => {
  await ev(page, () => { ACT.tab({ tab: 'bills' }); billForm(); });
  await fill(page, 'name', 'فاتورة الموبايل'); await fill(page, 'amount', 900);
  await page.selectOption('#sheetBody [name="every"]', '3');
  assert.ok(await page.isVisible('#sheetBody [name="next"]') && !(await page.isVisible('#sheetBody [name="dueDay"]')));
  await page.fill('#sheetBody [name="next"]', '2026-12-25'); await submit(page);
  assert.ok(!(await page.isVisible('#sheetWrap.open')), 'الشاشة تتقفل بعد الإضافة');
  const r = await ev(page, () => { const d = S.dues[0]; return [S.bills.length, d.name, d.amount, d.repeat, Math.round(duePerMonth(d, periodOf(todayS())))]; });
  // 900 على 3 شهور (أكتوبر ونوفمبر وديسمبر) = 300 في الشهر
  assert.deepEqual(r, [0, 'فاتورة الموبايل', 900, 3, 300]);
  assert.match(await page.textContent('#view'), /فاتورة الموبايل[\s\S]*كل 3 شهور/);
});

await test('شراء بوحدتين مختلفتين (جركن 4 لتر وزجاجة 0.6): التعديل بيعرض كل واحد بوحدته، والاستوك صح', async page => {
  await ev(page, () => { S.items.push({ id: 'sb', name: 'صابون سايل', group: 'منظفات', base: 'L', pu: 'جركن', pf: 4, monthly: 2, price: 30, alt: [{ pu: 'زجاجة', pf: 0.6 }] });
    S.counts.push({ id: 'k', ts: 1, itemId: 'sb', date: '2026-10-09', qty: 0 }); save(); buyItem('sb'); });
  await fill(page, 'qty', 1); await fill(page, 'amount', 120); await submit(page);                     // جركن
  await ev(page, () => buyItem('sb')); await page.selectOption('#sheetBody [name="bu"]', 'alt0');
  await fill(page, 'qty', 1); await fill(page, 'amount', 25); await submit(page);                      // زجاجة
  assert.deepEqual(await ev(page, () => [S.tx.map(t => t.qty), +estStock(byId(S.items, 'sb')).toFixed(2)]), [[4, 0.6], 4.6]);
  // تعديل الزجاجة: تظهر "1 زجاجة" مش "0.15 جركن"، وتغييرها لـ 2 زجاجة = 1.2 لتر
  await ev(page, () => quickAdd({ tx: S.tx[1] }));
  assert.equal(await page.inputValue('#sheetBody [name="qty"]'), '1');
  assert.match(await page.textContent('#sheetBody [name="qu"] option:checked'), /زجاجة/);
  await fill(page, 'qty', 2); await submit(page);
  assert.deepEqual(await ev(page, () => S.tx.map(t => t.qty)), [4, 1.2]);
  // شراء قديم من غير وحدة متسجلة: يظهر بالمقياس (لتر) — مش بيتلخبط مع الجركن
  await ev(page, () => { delete S.tx[0].u; save(); quickAdd({ tx: S.tx[0] }); });
  assert.equal(await page.inputValue('#sheetBody [name="qty"]'), '4');
  await page.selectOption('#sheetBody [name="qu"]', { label: 'جركن (4 L)' });
  assert.equal(await page.inputValue('#sheetBody [name="qty"]'), '1');
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

await test('الدمج: التعديل الأحدث على أي جهاز هو اللي بيفضل', async page => {
  const r = await ev(page, () => {
    S.goals.push({ id: 'g', name: 'عربية', target: 100, deadline: '2027-12' }); save();
    const remote = JSON.parse(JSON.stringify(S));               // نسخة الشيت قبل التعديل
    byId(S.goals, 'g').start = '2027-01'; save();                // تعديل هنا بعدها
    remote.goals.push({ id: 'g2', name: 'تاني', target: 5, deadline: '2027-12' });   // وحاجة جديدة اتضافت من جهاز تاني
    const m = mergeStates(remote, S);
    // والعكس: لو الجهاز التاني عدّل بعدنا، تعديله هو اللي يكسب
    const remote2 = JSON.parse(JSON.stringify(S)); remote2.goals[0].name = 'عربية جديدة'; remote2.goals[0]._m = Date.now() + 5000;
    const m2 = mergeStates(remote2, S);
    return [byId(m.goals, 'g').start, m.goals.length, byId(m2.goals, 'g').name];
  });
  assert.deepEqual(r, ['2027-01', 2, 'عربية جديدة']);
});

await test('زرار التحديث: بيزامن الأول وبعدين يعيد تحميل الصفحة من غير ما حاجة تضيع', async page => {
  const SYNC = URL_ + 'exec';
  Object.assign(FAKE, { value: null, updatedAt: 0, delay: 0, posts: 0 });
  await ev(page, sync => { S.settings.syncUrl = sync; S.settings.syncSecret = ''; save(); }, SYNC);
  await page.waitForTimeout(500);
  await page.click('.fab'); await fill(page, 'amount', '33'); await submit(page);
  await Promise.all([page.waitForEvent('load'), page.click('#refreshBtn')]);
  await page.waitForTimeout(300);
  assert.deepEqual([await ev(page, () => S.tx.map(t => t.amount)), txCount(FAKE.value)], [[33], 1]);
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

// جهازين حقيقيين (متصفحين) على نفس الشيت
async function device(){
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.on('dialog', d => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(URL_); return { ctx, page };
}
const amounts = () => JSON.parse(FAKE.value || '{"tx":[]}').tx.map(t => t.amount).sort((a, b) => a - b);
const addExp = (page, a) => ev(page, a => { S.tx.push({ id: 'e' + a, ts: Date.now(), type: 'exp', cat: 'food', amount: a, date: todayS() }); save(); }, a);
const settle = page => page.waitForFunction(() => !syncBusy && !syncTimer, null, { timeout: 8000 }).catch(() => {}).then(() => page.waitForTimeout(2200));
async function syncTest(name, fn){
  Object.assign(FAKE, { value: null, updatedAt: 0, delay: 0, postDelay: 0, posts: 0 });
  const A = await device(), B = await device();
  try{ await fn(A.page, B.page); console.log('  ✅', name); passed++; }
  catch(e){ console.log('  ❌', name, '\n     ', e.message.split('\n').slice(0, 10).join('\n      ')); failed++; }
  await A.ctx.close(); await B.ctx.close();
}
const connect = (page, a) => ev(page, url => { S.settings.syncUrl = url; S.settings.syncSecret = ''; save(); pullRemote(true); }, URL_ + 'exec');

await syncTest('مزامنة جهازين: كل جهاز يسجّل، والشيت فيه الاتنين (مفيش حد يكتب فوق التاني)', async (A, B) => {
  await addExp(A, 1); await connect(A); await settle(A);
  await connect(B); await settle(B);
  await addExp(A, 11); await settle(A);
  await addExp(B, 22); await settle(B);
  assert.deepEqual(amounts(), [1, 11, 22]);
  await ev(A, () => pullRemote(false)); await settle(A);
  assert.deepEqual(await ev(A, () => S.tx.map(t => t.amount).sort((a, b) => a - b)), [1, 11, 22]);
});

await syncTest('تسجيل وإحنا بنرفع: التسجيل التاني بيترفع بعدها', async (A) => {
  await addExp(A, 1); await connect(A); await settle(A);
  FAKE.postDelay = 1500;
  await addExp(A, 11); await A.waitForTimeout(1800);   // الرفع بدأ وبطيء
  await addExp(A, 22);
  FAKE.postDelay = 0; await A.waitForTimeout(5000); await settle(A);
  assert.deepEqual(amounts(), [1, 11, 22]);
});

await syncTest('توصيل المزامنة على جهاز فيه دخل وفواتير بس ما يمسحهمش', async (A, B) => {
  await addExp(A, 5); await connect(A); await settle(A);
  await ev(B, () => { S.incomes.push({ id: 'in', name: 'مرتب', amount: 1000, day: 1 }); S.bills.push({ id: 'bl', name: 'نت', amount: 100, dueDay: 5 }); save(); });
  await connect(B); await settle(B);
  assert.deepEqual(await ev(B, () => [S.incomes.length, S.bills.length, S.tx.length]), [1, 1, 1]);
});

await syncTest('شاشة تعديل مفتوحة والمزامنة جت: التعديل ما يضيعش', async (A, B) => {
  await addExp(A, 100); await connect(A); await settle(A);
  await connect(B); await settle(B);
  await ev(B, () => quickAdd({ tx: S.tx.find(t => t.amount === 100) }));
  await addExp(A, 7); await settle(A);              // جهاز تاني رفع وانا فاتح الشاشة
  await ev(B, () => pullRemote(false)); await B.waitForTimeout(500);
  await fill(B, 'amount', 250); await submit(B); await settle(B); await B.waitForTimeout(1500); await settle(B);
  assert.deepEqual(await ev(B, () => S.tx.map(t => t.amount).sort((a, b) => a - b)), [7, 250]);
  assert.deepEqual(amounts(), [7, 250]);
});

await syncTest('التراجع بيرجّع المتمسوح بس، وما يمسحش اللي اتسجل بعده — وما يرجعش يتمسح من جهاز تاني', async (A, B) => {
  await addExp(A, 1); await addExp(A, 2); await connect(A); await settle(A);
  await connect(B); await settle(B);
  await ev(A, () => ACT.delTx({ id: 'e1' })); await A.waitForTimeout(100);
  await addExp(A, 77);
  await ev(A, () => ACT.undo()); await settle(A);
  assert.deepEqual(await ev(A, () => S.tx.map(t => t.amount).sort((a, b) => a - b)), [1, 2, 77]);
  await ev(B, () => pullRemote(false)); await settle(B);
  await addExp(B, 3); await settle(B);
  assert.deepEqual(amounts(), [1, 2, 3, 77]);
});

await syncTest('مسح حاجات كتير بإيدك بيترفع عادي (مش بيتقفل كـ"الشيت أكبر")', async (A) => {
  for (let i = 1; i <= 12; i++) await ev(A, i => S.tx.push({ id: 'x' + i, ts: i, type: 'exp', cat: 'food', amount: i, date: todayS(), grp: i > 9 ? 'g' : undefined }), i);
  await ev(A, () => save()); await connect(A); await settle(A);
  await ev(A, () => ACT.delGroup({ id: 'g' })); await settle(A); await A.waitForTimeout(1000); await settle(A);
  assert.equal(amounts().length, 9);
});

await browser.close();
server.close();
console.log(`\n${passed} نجح · ${failed} فشل`);
process.exit(failed ? 1 : 0);
