// Service worker for The Will of The City.
//
// Served at /sw.js (see views.service_worker) rather than /static/sw.js on purpose — a service
// worker's default max scope is the directory it's served from, and this one needs to cover the
// whole app ("/") so it can intercept navigations to /home/, /menu/, /history/, etc. and receive
// push events no matter which page (or no page) is currently open.

// Bump this whenever this file's caching behaviour changes. Pages now reference static files
// through Django's {% static %} tag, which in production yields content-hashed URLs
// (style.3f9a1c2b7d4e.css) — a changed file gets a new URL, so a stale cached copy can't be served
// for it any more. That's what used to bite here: an edited script.js kept being served from this
// cache under its unchanging name until this version string was bumped by hand.
const CACHE_NAME = "wotc-shell-v3";

// Precached so the device itself still renders offline on a first cold start. Everything else under
// /static/ is cached at runtime the first time it's fetched (see the fetch handler).
const SHELL_ASSETS = [
    "/static/index_logo.webp",
    "/static/detailed_index_logo.webp",
    "/static/limbus_index_beeper.mp3",
    "/static/manifest.webmanifest",
];

// Matches WhiteNoise/ManifestStaticFilesStorage's hashed names, e.g. script.0123456789ab.js
const HASHED_ASSET = /\.[0-9a-f]{12}\.[a-z0-9]+$/i;

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())  // don't make the user close every tab to get an updated worker
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

function cacheResponse(request, response) {
    if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
}

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;  // never intercept POSTs (complete/ignore/subscribe/etc.)

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (url.pathname.startsWith("/static/")) {
        if (HASHED_ASSET.test(url.pathname) || SHELL_ASSETS.includes(url.pathname)) {
            // Immutable (hashed) or deliberately precached: cache-first.
            event.respondWith(
                caches.match(request).then((cached) => cached || fetch(request).then((res) => cacheResponse(request, res)))
            );
        } else {
            // Unhashed (local dev, icons): network-first so edits show up, cache as offline fallback.
            event.respondWith(
                fetch(request).then((res) => cacheResponse(request, res)).catch(() => caches.match(request))
            );
        }
        return;
    }

    // Everything else (page navigations, /get_score/, /get_history/, etc.): network-first, no
    // caching — this data has to stay live. A failed navigation gets a minimal inline offline
    // notice instead of the browser's own error page.
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() => new Response(
                "<!DOCTYPE html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Offline</title>" +
                "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#02060b;color:#86bada;font-family:monospace;padding:2rem;text-align:center'>" +
                "<div><p style='letter-spacing:.3em;font-size:12px;opacity:.6'>INDEX DEVICE // NO SIGNAL</p>" +
                "<p>The City is still recording. Try again once you're back online.</p></div></body>",
                { status: 503, headers: { "Content-Type": "text/html" } }
            ))
        );
    }
});

self.addEventListener("push", (event) => {
    let payload = { title: "PRESCRIPT ISSUED", body: "" };
    if (event.data) {
        try {
            payload = event.data.json();
        } catch (err) {
            payload.body = event.data.text();
        }
    }

    const options = {
        body: payload.body || "",
        icon: payload.icon || "/static/icons/icon-192.png",
        badge: payload.badge || "/static/icons/icon-192.png",
        tag: payload.tag || undefined,
        data: {
            url: payload.url || "/home/",
            actionUrls: (payload.actions || []).reduce((map, a) => {
                map[a.action] = a.url;
                return map;
            }, {}),
        },
    };
    if (payload.actions && payload.actions.length) {
        // Rendered as tap-to-act buttons where the browser supports it (desktop Chrome, Android).
        // Where it isn't supported (notably iOS Safari at the time of writing), these are simply
        // ignored and tapping the notification body falls through to the default open-app below.
        options.actions = payload.actions.map((a) => ({ action: a.action, title: a.title }));
    }

    event.waitUntil(Promise.all([
        self.registration.showNotification(payload.title || "PRESCRIPT ISSUED", options),
        // If the app is already open (foreground or background tab), tell it a new prescript
        // landed so the inbox can show it immediately instead of waiting for its next poll —
        // see the "new-prescript" handler in script.js.
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            clients.forEach((client) => client.postMessage({ type: "new-prescript" }));
        }),
    ]));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    const data = event.notification.data || {};
    const actionUrl = data.actionUrls && data.actionUrls[event.action];
    const targetUrl = new URL(data.url || "/home/", self.location.origin).href;

    event.waitUntil((async () => {
        // Complete/Ignore taps: hit the action URL first (same GET the ntfy notification action
        // buttons use — see notify_trigger in views.py), then bring the app to the foreground.
        if (actionUrl) {
            try {
                await fetch(actionUrl, { credentials: "omit" });
            } catch (err) {
                // best-effort — the app will still show the prescript as unanswered if this failed
            }
        }

        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of allClients) {
            if (client.url.startsWith(self.location.origin) && "focus" in client) {
                await client.focus();
                if ("navigate" in client) await client.navigate(targetUrl);
                return;
            }
        }
        await self.clients.openWindow(targetUrl);
    })());
});

// Fires if the browser itself invalidates a subscription (e.g. it expired) and hands back a
// fresh one automatically. Re-registers with the server so pushes don't silently stop.
self.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil((async () => {
        try {
            const newSub = event.newSubscription || await self.registration.pushManager.subscribe(event.oldSubscription.options);
            const usernameClients = await self.clients.matchAll({ type: "window" });
            // pwa.js keeps the username in localStorage, which a service worker can't read
            // directly — ask any open page to do the actual re-subscribe POST instead.
            for (const client of usernameClients) {
                client.postMessage({ type: "resubscribe", subscription: newSub.toJSON() });
            }
        } catch (err) {
            // Nothing more we can do from here without an open page — pwa.js also re-checks the
            // subscription on every page load as a backstop (see ensurePushRegistered).
        }
    })());
});
