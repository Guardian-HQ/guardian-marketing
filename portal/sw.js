// Guardian — minimal hand-rolled service worker.
//
// We intentionally skip next-pwa here: it still doesn't have a stable
// release for the Next.js App Router build output used by this app, and
// pulling in Workbox for four static screens is more machinery than this
// scaffold needs. This file gives us the two things that make the PWA
// installable and resilient to a flaky connection: an app-shell precache
// and a per-request-type strategy. Revisit next-pwa (or Workbox directly)
// once the app has enough routes/data-fetching that a hand-rolled cache
// strategy becomes a liability.
//
// What this worker must never do, learned the hard way:
//
//  - **Never cache `/api/*`.** Those responses are one guardian's family,
//    and this cache is origin-scoped and outlives a sign-out, so caching
//    them means a second guardian on the same device can be served the
//    first one's data. Cache-first also served a signed-in guardian stale
//    data forever: a child they had just added stayed missing from Home,
//    and the funnel read a finished step as unfinished. The Cache-Control
//    headers the BFF sends cannot save us here, because `caches.put`
//    ignores them entirely.
//
//  - **Never serve a cached HTML or RSC payload before the network.** Those
//    documents name content-hashed script chunks. After a deploy the names
//    change, and a stale document asking for chunks that no longer exist
//    leaves the app rendering its server markup with React never hydrating:
//    a page that looks fine and does nothing. Navigations go to the network
//    first and fall back to the cache only when the network fails, which is
//    what "works offline" actually needs.
//
// Hashed build assets under `/_next/static/` are the one safe cache-first
// case: the URL changes whenever the bytes do, so a hit is never stale.

const CACHE_VERSION = "guardian-shell-v3";
const APP_SHELL = [
  "/",
  "/family",
  "/permissions",
  "/settings",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

/** One guardian's data: never stored, never served from a shared cache. */
function isPrivateData(url) {
  return url.pathname.startsWith("/api/");
}

/** A document request: the HTML or the RSC payload behind a client navigation. */
function isDocument(request, url) {
  return request.mode === "navigate" || url.searchParams.has("_rsc");
}

/** Immutable, content-hashed build output. */
function isHashedAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
      }
      return response;
    });
  });
}

function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached ?? Response.error()));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GET requests; let everything else pass through.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  const url = new URL(request.url);

  // One guardian's data never enters a cache shared with the next guardian.
  if (isPrivateData(url)) {
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isDocument(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else same-origin and static: icons, the manifest, fonts.
  event.respondWith(cacheFirst(request));
});

// Web Push delivery — see docs/foundation-contract.md §2.7/§3, "the
// incoming-request moment": guardian-api sends server-side to a registered
// device when a fresh-prompt request needs a guardian's attention. The
// contract fixes the registration/config shapes (`GET /push/config`,
// `POST /push/devices`) but does not pin the *payload* a push message
// itself carries byte-for-byte, so this reads `title`/`body`/`url`
// defensively with fallbacks rather than assuming a shape guardian-api
// hasn't documented — the honest thing to do against an unspecified-but-
// implied payload.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title ?? "Guardian";
  const options = {
    body: data.body ?? "A new request needs your attention.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url ?? "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    }),
  );
});
