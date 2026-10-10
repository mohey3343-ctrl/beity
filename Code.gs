/* =====================================================================
   بيتي — سكريبت المزامنة مع جوجل شيت (اختياري)

   الخطوات:
   1) اعمل Google Sheet جديد (منفصل عن شيت العمارة).
   2) Extensions ← Apps Script، امسح اللي موجود والصق الملف ده كله.
   3) غيّر SECRET تحت لكلمة سر من عندك.
   4) Deploy ← New deployment ← Web app
        Execute as: Me
        Who has access: Anyone
   5) انسخ رابط الـ Web app وحطه في إعدادات البرنامج مع نفس كلمة السر.

   البيانات بتتخزن في شيت اسمه budget_db (مقسومة على صفوف لأن الخلية
   ليها حد أقصى)، وكل يوم بيتعمل نسخة احتياطية في شيت backup_YYYY-MM-DD
   (بيفضل آخر 14 نسخة).
   ===================================================================== */

const SECRET = 'غيّر-دي';
const SHEET_NAME = 'budget_db';
const CHUNK = 40000;
const KEEP_BACKUPS = 14;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (SECRET && p.secret !== SECRET) return out({ ok: false, error: 'كلمة السر غلط' });
  const d = readDb();
  return out({ ok: true, value: d.value, updatedAt: d.updatedAt });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (x) { return out({ ok: false, error: 'طلب غير مفهوم' }); }
  if (SECRET && body.secret !== SECRET) return out({ ok: false, error: 'كلمة السر غلط' });
  if (body.action !== 'set' || typeof body.value !== 'string') return out({ ok: false, error: 'طلب غير مفهوم' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cur = readDb();
    const updatedAt = Number(body.updatedAt) || Date.now();
    if (!body.force) {
      // جهاز تاني رفع نسخة أحدث — الجهاز ده لازم يسحب الأول
      if (cur.updatedAt && updatedAt < cur.updatedAt) {
        return out({ ok: false, code: 'stale', error: 'فيه نسخة أحدث على الشيت' });
      }
      // حماية من مسح البيانات بالغلط (زي جهاز فتح فاضي ورفع قبل ما يحمّل)
      if (cur.value && body.value.length < cur.value.length * 0.6) {
        return out({ ok: false, code: 'shrink', error: 'النسخة الجديدة أصغر بكتير من القديمة' });
      }
      const oldTx = txCount(cur.value), newTx = txCount(body.value);
      if (oldTx >= 10 && newTx < oldTx * 0.8) {
        return out({ ok: false, code: 'shrink', error: 'النسخة الجديدة فيها حركات أقل بكتير (' + newTx + ' بدل ' + oldTx + ')' });
      }
    }
    backupIfNeeded();
    writeDb(body.value, updatedAt);
    return out({ ok: true, updatedAt: updatedAt });
  } finally {
    lock.releaseLock();
  }
}

/* الشيت اللي السكريبت معمول جواه — ولو السكريبت اتعمل لوحده (من script.google.com)
   بيعمل شيت جديد اسمه "بيتي — بيانات" مرة واحدة ويفتكره */
function book() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('sheetId');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create('بيتي — بيانات');
  props.setProperty('sheetId', ss.getId());
  return ss;
}

function txCount(json) {
  try { const o = JSON.parse(json); return (o && o.tx && o.tx.length) || 0; } catch (e) { return 0; }
}

function sheet() {
  const ss = book();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

/* الصف الأول: [updatedAt, عدد الأجزاء] — وبعده كل جزء في صف.
   كل جزء بيبدأ بحرف x عشان الشيت ما يحوّلوش لرقم أو معادلة. */
function readDb() {
  const sh = sheet();
  if (sh.getLastRow() < 1) return { value: null, updatedAt: 0 };
  const meta = sh.getRange(1, 1, 1, 2).getValues()[0];
  const updatedAt = Number(meta[0]) || 0;
  const n = Number(meta[1]) || 0;
  if (!n) return { value: null, updatedAt: updatedAt };
  const vals = sh.getRange(2, 1, n, 1).getValues();
  return { value: vals.map(function (r) { return String(r[0]).slice(1); }).join(''), updatedAt: updatedAt };
}

function writeDb(value, updatedAt) {
  const sh = sheet();
  const chunks = [];
  for (let i = 0; i < value.length; i += CHUNK) chunks.push(['x' + value.slice(i, i + CHUNK)]);
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([[updatedAt, chunks.length]]);
  if (chunks.length) sh.getRange(2, 1, chunks.length, 1).setValues(chunks);
}

function backupIfNeeded() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (props.getProperty('lastBackup') === today) return;
  const ss = book();
  const sh = sheet();
  if (sh.getLastRow() >= 1) {
    const name = 'backup_' + today;
    const old = ss.getSheetByName(name);
    if (old) ss.deleteSheet(old);
    sh.copyTo(ss).setName(name);
  }
  const backups = ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return /^backup_\d{4}-\d{2}-\d{2}$/.test(n); })
    .sort();
  while (backups.length > KEEP_BACKUPS) ss.deleteSheet(ss.getSheetByName(backups.shift()));
  props.setProperty('lastBackup', today);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
