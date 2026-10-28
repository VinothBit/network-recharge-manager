const APP_BASE_URL = new URL("./", self.registration.scope);
const APP_BASE_PATH = APP_BASE_URL.pathname;
const SHELL_CACHE = "rlems-app-shell-v2";
const INDEX_URL = new URL("index.html", APP_BASE_URL).href;
const SHELL_FILES = [
  "manifest.webmanifest",
  "icons/rlems-192.png",
  "icons/rlems-512.png",
  "icons/rlems-192.svg",
  "icons/rlems-512.svg",
  "favicon.svg",
].map((path) => new URL(path, APP_BASE_URL).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES);

      // Cache only the public HTML shell and the hashed JS/CSS app assets.
      const indexResponse = await fetch(INDEX_URL, { cache: "no-cache" });
      if (!indexResponse.ok || !indexResponse.headers.get("content-type")?.includes("text/html")) {
        throw new Error("Unable to load the static app shell for offline startup.");
      }

      const indexText = await indexResponse.clone().text();
      await cache.put(INDEX_URL, indexResponse);
      const assets = [...indexText.matchAll(/(?:src|href)=["']([^"']+)['"]/g)]
        .map((match) => new URL(match[1], INDEX_URL))
        .filter((url) => (
          url.origin === APP_BASE_URL.origin &&
          url.pathname.startsWith(`${APP_BASE_PATH}assets/`) &&
          /\.(js|css)$/i.test(url.pathname)
        ))
        .map((url) => url.href);
      await cache.addAll(assets);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("rlems-app-shell-") && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== APP_BASE_URL.origin || !url.pathname.startsWith(APP_BASE_PATH)) return;

  if (request.mode === "navigate") {
    const isAppEntry = url.pathname === APP_BASE_PATH || url.pathname === INDEX_URL.pathname;
    if (!isAppEntry) return;

    event.respondWith(
      fetch(request)
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return cache.match(INDEX_URL) || new Response(
            "RLEMS is unavailable offline. Connect to the server and retry.",
            {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
          );
        })
    );
    return;
  }

  // API/account requests are deliberately never intercepted or cached.
  if (/^\/(api|auth|login|logout|plans|reminders|backup|restore)(\/|$)/i.test(url.pathname)) return;

  const isHashedAppAsset = (
    url.pathname.startsWith(`${APP_BASE_PATH}assets/`) &&
    (request.destination === "script" || request.destination === "style")
  );
  const isPublicShellFile = SHELL_FILES.includes(url.href);
  if (!isHashedAppAsset && !isPublicShellFile) return;

  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) => cache.match(request)).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const responseCopy = response.clone();
          event.waitUntil(
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, responseCopy))
          );
        }
        return response;
      });
    })
  );
});
