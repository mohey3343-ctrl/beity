/* بيتي — Service Worker عشان التطبيق يفتح من غير نت
   - الصفحة نفسها: من النت الأول (عشان التحديثات توصل)، ولو النت ضعيف/مقطوع
     أكتر من 3 ثواني بتفتح من النسخة المحفوظة.
   - الأيقونات والخطوط: من المحفوظ على طول، وبتتحدث في الخلفية.
   - المزامنة مع جوجل شيت: من النت بس، عمرها ما بتتحفظ هنا. */
const CACHE = 'beity-v1';
const CORE = ['./', './index.html', './manifest.json', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png', './Code.gs'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(r => { clearTimeout(t); resolve(r); }, err => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/script\.google(usercontent)?\.com$/.test(url.hostname)) return;

  const isPage = req.mode === 'navigate' || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname));
  if (isPage) {
    const net = fetch(req).then(r => {
      if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
      return r;
    });
    e.respondWith(withTimeout(net, 3000)
      .catch(() => caches.match('./index.html').then(hit => hit || net)));
    return;
  }

  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => {
      if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
