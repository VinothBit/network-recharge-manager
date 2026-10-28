const SHELL_CACHE = "rlems-app-shell-v1";
const SHELL_FILES = [
  "/manifest.webmanifest",
  "/icons/rlems-192.png",
  "/icons/rlems-512.png",
  "/icons/rlems-192.svg",
  "/icons/rlems-512.svg",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES);

      // Precache only the static JS/CSS files referenced by Vite's built index.
      const indexResponse = await fetch("/index.html", { cache: "no-cache" });
      if (!indexResponse.ok || !indexResponse.headers.get("content-type")?.includes("text/html")) {
        throw new Error("Unable to load the static app shell for offline startup.");
      }
      const indexForParsing = await indexResponse.clone().text();
      await cache.put("/index.html", indexResponse);

      const assets = [...indexForParsing.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((path) => path.startsWith("/assets/") && /\.(js|css)$/i.test(path));
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
  if (url.origin !== self.location.origin) return;

  // Keep all API and account traffic network-only, including any future route names.
  if (/^\/(api|auth|login|logout|plans|reminders|backup|restore)(\/|$)/i.test(url.pathname)) {
    return;
  }

  if (request.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
            const responseCopy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put("/index.html", responseCopy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return cache.match("/index.html") || new Response(
            "RLEMS is unavailable offline. Connect to the local server and retry.",
            {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
          );
        })
    );
    return;
  }

  const isStaticAppAsset = (
    url.pathname.startsWith("/assets/") &&
    (request.destination === "script" || request.destination === "style")
  ) || [
    "/manifest.webmanifest",
    "/icons/rlems-192.png",
    "/icons/rlems-512.png",
    "/icons/rlems-192.svg",
    "/icons/rlems-512.svg",
    "/favicon.svg",
  ].includes(url.pathname);

  if (!isStaticAppAsset) return;

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
