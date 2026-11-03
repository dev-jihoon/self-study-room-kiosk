/* 한 번 열어 두면 와이파이가 끊겨도 키오스크가 뜨도록 정적 파일을 저장한다 */
const CACHE = 'study-room-kiosk-v16';
const FILES = [
  './', 'admin', 'me', 'cards', 'away', 'manifest.webmanifest',
  'css/style.css', 'css/admin.css',
  'js/core.js', 'js/store.js', 'js/seatmap.js', 'js/scanner.js', 'js/kiosk.js', 'js/admin.js', 'js/code128.js', 'js/tablefile.js',
  'vendor/zxing.min.js', 'vendor/fonts/PretendardVariable.woff2', 'vendor/qrcode.js',
  'data/layout.json', 'data/roster.json', 'icon.svg'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  /* 글꼴과 라이브러리는 바뀌지 않으니 저장본을 먼저 쓴다 (CACHE 이름을 올리면 새로 받음) */
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
    return;
  }
  /* 나머지는 새 버전을 먼저 받아 보고, 안 되면 저장본을 쓴다 */
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
