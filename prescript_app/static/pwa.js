// PWA install + Web Push wiring, included on every page (like script.js). Registering the
// service worker happens everywhere; the actual "Enable Notifications" / install UI only exists
// on menu.html, so most of the DOM-touching functions here are no-ops elsewhere (see the
// `if (!el) return` guards in updateNotifyUI).

const NOTIFY_SUPPORTED = "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";

let swRegistration = null;

function urlBase64ToUint8Array(base64String) {   // PushManager wants the VAPID key as a Uint8Array,
    const padding = "=".repeat((4 - base64String.length % 4) % 4);  // but the server hands it over as the
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");  // URL-safe base64 string
    const rawData = atob(base64);                                                    // web-push libraries use.
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function isStandalone() {                       // True once the site is actually running as an installed PWA
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
        swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        navigator.serviceWorker.addEventListener("message", handleSWMessage);
        return swRegistration;
    } catch (err) {
        console.error("Service worker registration failed:", err);
        return null;
    }
}

function handleSWMessage(event) {   // Handles messages forwarded from sw.js.
    if (!event.data) return;

    if (event.data.type === "resubscribe") {          // pushsubscriptionchange — the service worker can't read
        postSubscription(event.data.subscription);     // localStorage for the username, so it asks an open page to do it.
    }

    if (event.data.type === "new-prescript") {         // A push just arrived — refresh the inbox immediately instead of
        if (typeof loadInbox === "function") {         // waiting for its next poll (see loadInbox in script.js). Guarded
            loadInbox();                               // since pwa.js loads on every page, not just the one with an inbox.
        }
    }
}

async function postSubscription(subscriptionJSON) {
    const username = getStoredName().trim();
    if (!username) return;
    try {
        await fetch("/push/subscribe/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, subscription: subscriptionJSON }),
        });
    } catch (err) {
        console.error("Failed to register push subscription:", err);
    }
}

async function deleteSubscriptionOnServer(endpoint) {
    try {
        await fetch("/push/unsubscribe/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint }),
        });
    } catch (err) {
        console.error("Failed to remove push subscription:", err);
    }
}

async function subscribeToPush() {
    if (!swRegistration) return null;
    const existing = await swRegistration.pushManager.getSubscription();
    if (existing) {
        await postSubscription(existing.toJSON());
        return existing;
    }

    const res = await fetch("/push/vapid-public-key/");
    const data = await res.json();
    if (!data.publicKey) throw new Error("VAPID public key not available");

    const sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    });
    await postSubscription(sub.toJSON());
    return sub;
}

async function ensurePushRegistered() {  // Backstop, called on every page load: if permission's already
    if (!swRegistration || !NOTIFY_SUPPORTED) return;  // granted, make sure the server still has this
    if (Notification.permission !== "granted") return;  // browser's subscription (covers a stale/missing
    const existing = await swRegistration.pushManager.getSubscription();  // row after a name change, etc).
    if (existing) {
        await postSubscription(existing.toJSON());
    } else {
        try { await subscribeToPush(); } catch (err) { console.error(err); }
    }
}

function updateNotifyUI() {
    const banner = document.getElementById("installBanner");
    const enableBtn = document.getElementById("enableNotifyBtn");
    const statusEl = document.getElementById("notifyStatus");
    if (!banner && !enableBtn && !statusEl) return;  // these only exist on menu.html

    const standalone = isStandalone();

    if (banner) {
        // Only iOS needs the manual "Add to Home Screen" nudge — Android/desktop Chrome get a
        // native install prompt instead (see beforeinstallprompt below), and once installed
        // (standalone) there's nothing left to nudge toward.
        banner.style.display = (isIOS() && !standalone) ? "block" : "none";
    }

    if (enableBtn) {
        if (!NOTIFY_SUPPORTED || (isIOS() && !standalone)) {
            // iOS refuses Notification.requestPermission() from a plain Safari tab — hide the
            // button entirely rather than show something that would just silently fail.
            enableBtn.style.display = "none";
        } else {
            enableBtn.style.display = "inline-block";
            const granted = Notification.permission === "granted";
            enableBtn.textContent = granted ? "Notifications Enabled" : "Enable Notifications";
            enableBtn.disabled = granted;
        }
    }

    if (statusEl) {
        if (!NOTIFY_SUPPORTED) {
            statusEl.textContent = "Push notifications aren't supported in this browser.";
        } else if (isIOS() && !standalone) {
            statusEl.textContent = "Add this to your Home Screen first — iOS only allows notifications from an installed app.";
        } else if (Notification.permission === "denied") {
            statusEl.textContent = "Notifications are blocked — re-enable them in your browser/device settings.";
        } else if (Notification.permission === "granted") {
            statusEl.textContent = "Notifications are enabled on this device.";
        } else {
            statusEl.textContent = "";
        }
    }
}

async function handleEnableNotifyClick() {
    const btn = document.getElementById("enableNotifyBtn");
    if (btn) btn.disabled = true;
    try {
        // requestPermission() must be called directly from a user gesture (this click handler) —
        // iOS in particular will silently refuse it if called from anywhere else, e.g. on load.
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
            await subscribeToPush();
        }
    } catch (err) {
        console.error("Failed to enable notifications:", err);
    } finally {
        updateNotifyUI();
    }
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {  // Android/desktop Chrome only — iOS has
    event.preventDefault();                                   // no equivalent, hence the manual banner above.
    deferredInstallPrompt = event;
    const installBtn = document.getElementById("installAppBtn");
    if (installBtn) installBtn.style.display = "inline-block";
});

async function handleInstallClick() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    const installBtn = document.getElementById("installAppBtn");
    if (installBtn) installBtn.style.display = "none";
}

async function initPWA() {
    await registerServiceWorker();
    await ensurePushRegistered();
    updateNotifyUI();

    const enableBtn = document.getElementById("enableNotifyBtn");
    if (enableBtn) enableBtn.addEventListener("click", handleEnableNotifyClick);

    const installBtn = document.getElementById("installAppBtn");
    if (installBtn) installBtn.addEventListener("click", handleInstallClick);

    window.addEventListener("focus", updateNotifyUI);  // catches permission changes made from browser settings
}

initPWA();
