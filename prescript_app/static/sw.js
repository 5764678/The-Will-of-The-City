// Service worker for The Will of The City.
//
// Served at /sw.js (see views.service_worker) rather than /static/sw.js on purpose — a service
// worker's default max scope is the directory it's served from, and this one needs to cover the
// whole app ("/") so it can intercept navigations to /home/, /menu/, /history/, etc. and receive
// push events no matter which page (or no page) is currently open.

const CACHE_NAME = "wotc-shell-v1";

// A small, deliberately conservative app-shell cache — just enough that the terminal UI itself
// still renders if you're offline or the network hiccups. Prescript/grace/history data always
// comes from the network (never cached) since it has to stay live.
const SHELL_ASSETS = [
    "/static/style.css",
    "/static/script.js",
    "/static/pwa.js",
    "/static/detailed_index_logo.webp",
    "/static/limbus_index_beeper.mp3",
    "/static/manifest.webmanifest",
];

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

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;  // never intercept POSTs (complete/ignore/subscribe/etc.)

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // App-shell assets: cache-first, so the UI itself still loads offline.
    if (SHELL_ASSETS.includes(url.pathname)) {
        event.respondWith(
            caches.match(request).then((cached) => cached || fetch(request))
        );
        return;
    }

    // Everything else (page navigations, /get_score/, /get_history/, etc.): network-first, no
    // caching — this data has to stay live. A failed navigation gets a minimal inline offline
    // notice instead of the browser's own error page (no full-page cache to fall back to here).
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() => new Response(
                "<!DOCTYPE html><meta charset='utf-8'><title>Offline</title>" +
                "<body style='background:#000;color:#86bada;font-family:monospace;padding:2rem'>" +
                "No connection. The City is still recording — try again once you're back online.</body>",
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

    event.waitUntil(self.registration.showNotification(payload.title || "PRESCRIPT ISSUED", options));
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
