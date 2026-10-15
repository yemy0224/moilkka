// 앱 화면 파일을 저장해두는 서비스 워커 (설치형 앱에 필요)
// 화면 파일을 바꿨으면 아래 버전 숫자를 올려주세요.
const CACHE = '49th-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/config.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 같은 사이트의 화면 파일만: 네트워크 먼저, 안 되면 저장본
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html')))
  );
});
