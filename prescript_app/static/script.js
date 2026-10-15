// The Will of The City — client script, loaded on every page (see templates/base.html).
//
// Top-level function declarations stay global on purpose: pwa.js calls getStoredName(),
// loadInbox() and ensurePushRegistered() across files. Each page section no-ops when its elements
// aren't on the page.

"use strict";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const PRESCRIPT_TIME_LIMIT_MS = 40 * 60 * 1000; // mirrors PRESCRIPT_TIME_LIMIT in views.py; only a
                                                 // fallback for items the server sent without expires_at
const INBOX_POLL_MS = 20000; // catches a scheduled push arriving while the page is open even if the
                             // service-worker "new-prescript" message (see pwa.js) is missed

const $ = (id) => document.getElementById(id);

// ---- Requests --------------------------------------------------------------------------------

function getCookie(name) { // Django's csrftoken cookie, sent back as X-CSRFToken on every POST.
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
    return "";
}

function postForm(url, bodyString) {
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRFToken": getCookie("csrftoken"),
        },
        body: bodyString,
    });
}

function postWithName(url) {
    return postForm(url, `username=${encodeURIComponent(getStoredName().trim())}`).then(r => r.json());
}

// ---- Identity --------------------------------------------------------------------------------

function getStoredName() {
    try {
        return localStorage.getItem("prescript_username") || "";
    } catch (err) {
        return "";
    }
}

function setStoredName(name) {
    try { localStorage.setItem("prescript_username", name); } catch (err) { /* private mode */ }
    postForm("/update/", `username=${encodeURIComponent(name)}`);
    updateNameUI();
}

function displayName() {
    return getStoredName().trim() || "Citizen";
}

function updateNameUI() {
    const name = displayName();
    const page = document.body.dataset.page;

    const greeting = $("userGreeting");
    if (greeting) greeting.textContent = page === "role" ? `--user ${name.toLowerCase()}` : name.toUpperCase();

    const recordOwner = $("recordOwner");
    if (recordOwner) recordOwner.textContent = name.toLowerCase();

    const mailRecipient = $("mailRecipient");
    if (mailRecipient) mailRecipient.textContent = name;

    const identityState = $("identityState");
    if (identityState) identityState.textContent = getStoredName().trim() ? "REGISTERED" : "UNREGISTERED";

    const input = $("usernameInput");
    if (input && document.activeElement !== input) input.value = getStoredName().trim();
}

// ---- Sound & haptics -------------------------------------------------------------------------

function isMuted() {
    try { return localStorage.getItem("wotc_sound") === "off"; } catch (err) { return false; }
}

function playAudio() { // Rewinds first so rapid repeats retrigger instead of waiting for the clip to end.
    if (isMuted()) return;
    const beep = $("beep");
    if (!beep) return;
    beep.currentTime = 0;
    beep.volume = 0.4;
    beep.play().catch(() => { /* autoplay blocked until the first user gesture — expected */ });
}

function buzz(pattern) {
    if (navigator.vibrate) {
        try { navigator.vibrate(pattern); } catch (err) { /* unsupported */ }
    }
}

function initSoundToggle() {
    const btn = $("soundToggle");
    if (!btn) return;
    const sync = () => {
        const on = !isMuted();
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        $("soundState").textContent = on ? "ON" : "OFF";
    };
    sync();
    btn.addEventListener("click", () => {
        try { localStorage.setItem("wotc_sound", isMuted() ? "on" : "off"); } catch (err) { /* ignore */ }
        sync();
        if (!isMuted()) playAudio();
    });
}

// ---- Small helpers ---------------------------------------------------------------------------

function toast(message, kind) {
    const host = $("toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast" + (kind === "fail" ? " toast--fail" : "");
    el.textContent = message;
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => {
        el.classList.add("is-leaving");
        setTimeout(() => el.remove(), 320);
    }, 2600);
}

const DECODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*/<>";

function decodeTextInto(el, newText, speed = 30) { // Character-scramble reveal. Restarting on the same
    if (!el) return;                                // element cancels the previous run.
    const target = newText || "";
    const runId = (el._decodeRun || 0) + 1;
    el._decodeRun = runId;
    el.textContent = target;
    if (!target || REDUCED_MOTION) return;

    const revealed = Array.from(target, ch => ch === " ");
    const step = () => {
        if (el._decodeRun !== runId) return;
        let output = "";
        let pending = false;
        for (let i = 0; i < target.length; i++) {
            if (revealed[i]) {
                output += target[i];
            } else {
                pending = true;
                output += DECODE_CHARS[Math.floor(Math.random() * DECODE_CHARS.length)];
                if (Math.random() < 0.08) revealed[i] = true;
            }
        }
        el.textContent = output;
        if (pending) setTimeout(step, speed);
        else el.textContent = target;
    };
    step();
}

function typeInto(el, text, speed = 16) { // Plain typewriter; resolves when done.
    return new Promise(resolve => {
        if (!el) return resolve();
        if (REDUCED_MOTION) {
            el.textContent = text;
            return resolve();
        }
        const runId = (el._typeRun || 0) + 1;
        el._typeRun = runId;
        let i = 0;
        const step = () => {
            if (el._typeRun !== runId) return resolve();
            i += 1;
            el.textContent = text.slice(0, i);
            if (i < text.length) setTimeout(step, speed);
            else resolve();
        };
        step();
    });
}

function animateNumber(el, from, to, duration = 900) {
    if (!el) return;
    if (REDUCED_MOTION || from === to) {
        el.textContent = String(to);
        return;
    }
    const start = performance.now();
    const runId = (el._numRun || 0) + 1;
    el._numRun = runId;
    const frame = (now) => {
        if (el._numRun !== runId) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = String(Math.round(from + (to - from) * eased));
        if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

function restartClass(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    if (ms) setTimeout(() => el.classList.remove(cls), ms);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function hhmmss(date) { return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`; }

function hhmm(date) { return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`; }

function stableHash(seed) {
    return Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// Width of one monospace character in the page font, for sizing [####---] bars to their line.
let charWidth = 0;
function measureChar() {
    if (charWidth) return charWidth;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
    probe.textContent = "0".repeat(40);
    document.body.appendChild(probe);
    charWidth = probe.getBoundingClientRect().width / 40 || 8.25;
    probe.remove();
    return charWidth;
}

// Renders [######------] into `el`, sized to fill the line. `suffix` sits after the bar.
function renderTextbar(el, fraction, { suffix = "", urgent = false } = {}) {
    if (!el) return;
    const width = el.clientWidth || el.parentElement.clientWidth;
    const cells = Math.max(10, Math.min(56, Math.floor(width / measureChar()) - 3 - suffix.length));
    const on = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
    el.innerHTML = `[<span class="on">${"#".repeat(on)}</span><span class="off">${"-".repeat(cells - on)}</span>]${escapeHTML(suffix)}`;
    el.classList.toggle("is-urgent", urgent);
}

// ---- Screen printing -------------------------------------------------------------------------
// Every page arrives the way the boot sequence does: the command line types itself, then each line
// of output prints in order. Any tap or key finishes it instantly.

function printScreen() {
    const main = $("main");
    if (!main || REDUCED_MOTION) return;

    const cmd = main.querySelector(".cmdline");
    const lines = Array.from(main.querySelectorAll(".block > *, .screen > .filter, .levels tbody tr, .entries > *"));
    let finished = false;

    const finish = () => {
        if (finished) return;
        finished = true;
        lines.forEach(el => el.style.removeProperty("--d"));
        if (cmd && cmd._html !== undefined) {
            cmd._typeRun = (cmd._typeRun || 0) + 1;
            cmd.innerHTML = cmd._html;
        }
        document.removeEventListener("pointerdown", finish);
        document.removeEventListener("keydown", finish);
    };
    document.addEventListener("pointerdown", finish, { once: true });
    document.addEventListener("keydown", finish, { once: true });

    let start = 60;
    if (cmd) {
        cmd._html = cmd.innerHTML;
        const text = cmd.textContent.replace(/\s+/g, " ").trim();
        cmd.textContent = "";
        start += Math.min(text.length * 14, 500);
        setTimeout(() => {
            typeInto(cmd, text, 14).then(() => { if (!finished) cmd.innerHTML = cmd._html; });
        }, 60);
    }

    const step = Math.max(18, Math.min(40, 700 / Math.max(lines.length, 1)));
    lines.forEach((el, i) => {
        el.style.setProperty("--d", `${Math.round(start + i * step)}ms`);
        el.classList.add("pl");
    });
    setTimeout(finish, start + lines.length * step + 200);
}

// Cut to black before following an internal link, so the next page prints onto a dark screen.
function initPageTransitions() {
    const go = (href) => {
        if (REDUCED_MOTION) {
            location.href = href;
            return;
        }
        document.body.classList.add("is-leaving");
        setTimeout(() => { location.href = href; }, 130);
    };

    document.addEventListener("click", (event) => {
        const link = event.target.closest("a[href]");
        if (!link || event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;
        const url = new URL(link.href, location.href);
        if (url.origin !== location.origin || url.hash) return;
        if (url.pathname === location.pathname) return;
        event.preventDefault();
        go(url.href);
    });

    // [1]-[5] jump between sections, like a terminal menu.
    document.addEventListener("keydown", (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (isTyping(event.target)) return;
        const link = document.querySelector(`.nav__link[data-key="${event.key}"]`);
        if (link && !link.classList.contains("is-active")) {
            event.preventDefault();
            go(link.href);
        }
    });

    // Back/forward cache restores the page as it was left (blacked out) — undo that.
    window.addEventListener("pageshow", () => document.body.classList.remove("is-leaving"));
}

function isTyping(target) {
    const tag = (target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || target.isContentEditable;
}

function initClock() {
    const el = $("statusClock");
    if (!el) return;
    const tick = () => { el.textContent = hhmmss(new Date()); };
    tick();
    setInterval(() => { if (!document.hidden) tick(); }, 1000);
}

// ---- Roles -----------------------------------------------------------------------------------

const ROLE_INFO = {
    Turncoat: { description: "Your alignment has tipped away from the City’s movement.", image: "/static/role_turncoat.svg" },
    Civilian: { description: "You are still forming your cadence within the City.", image: "/static/role_civilian.svg" },
    Proselyte: { description: "You are learning to listen and respond to the City’s rhythms.", image: "/static/role_proselyte.svg" },
    Proxy: { description: "You act as a conduit to move the City’s motion along.", image: "/static/role_proxy.svg" },
    Messenger: { description: "You carry messages through the City’s channels.", image: "/static/role_messenger.svg" },
    Weaver: { description: "You shape the pattern the City follows.", image: "/static/role_weaver.svg" },
};

// Minimum grace for each rank. Proxy and Messenger share a level; which one a user gets is picked
// deterministically from their name, so it never flips between page loads.
const ROLE_THRESHOLDS = { Turncoat: -Infinity, Civilian: 0, Proselyte: 51, Proxy: 126, Messenger: 126, Weaver: 201 };

function stablePick(seed, options) {
    const hash = Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    return options[hash % options.length];
}

function pairedRole() {
    return stablePick(getStoredName().trim() || "__anon__", ["Proxy", "Messenger"]);
}

function toNumber(grace) {
    if (typeof grace === "string") {
        const stripped = grace.replace(/[^0-9\-]/g, "").trim();
        return stripped === "" ? NaN : Number(stripped);
    }
    return Number(grace);
}

function getRoleForGrace(grace) {
    const n = toNumber(grace);
    if (Number.isNaN(n)) return { name: "Unknown", description: "Unable to determine role.", image: "/static/role_placeholder.svg" };

    let name;
    if (n <= -1) name = "Turncoat";
    else if (n <= 50) name = "Civilian";
    else if (n <= 125) name = "Proselyte";
    else if (n <= 200) name = pairedRole();
    else name = "Weaver";
    return { name, ...ROLE_INFO[name] };
}

// Where the user sits relative to the next rank: { role, nextName, pct (0..1), toNext }.
function rankProgress(grace) {
    const n = toNumber(grace) || 0;
    const role = getRoleForGrace(n);
    const clamp = (v) => Math.max(0, Math.min(1, v));

    if (n < 0) return { role, nextName: "Civilian", pct: clamp(1 + n / 50), toNext: -n };
    if (n <= 50) return { role, nextName: "Proselyte", pct: clamp(n / 51), toNext: 51 - n };
    if (n <= 125) return { role, nextName: pairedRole(), pct: clamp((n - 51) / 75), toNext: 126 - n };
    if (n <= 200) return { role, nextName: "Weaver", pct: clamp((n - 126) / 75), toNext: 201 - n };
    return { role, nextName: null, pct: 1, toNext: 0 };
}

// ---- Grace (shared by every page) -------------------------------------------------------------

let currentGrace = null;

function setGrace(value) {
    const next = toNumber(value);
    if (Number.isNaN(next)) return 0;
    const prev = currentGrace;
    currentGrace = next;
    const from = prev === null ? next : prev;
    const delta = prev === null ? 0 : next - prev;

    const graceEl = $("grace");
    if (graceEl) {
        animateNumber(graceEl, from, next, 700);
        if (delta) {
            graceEl.classList.remove("is-up", "is-down");
            restartClass(graceEl, delta > 0 ? "is-up" : "is-down", 1200);
            const deltaEl = $("graceDelta");
            if (deltaEl) {
                deltaEl.textContent = `(${delta > 0 ? "+" : "−"}${Math.abs(delta)})`;
                deltaEl.className = `delta ${delta > 0 ? "is-up" : "is-down"}`;
                clearTimeout(deltaEl._fade);
                deltaEl._fade = setTimeout(() => deltaEl.classList.add("is-fading"), 2400);
            }
        }
    }

    animateNumber($("graceChip"), from, next, 700);
    updateRankProgress(next);
    if ($("roleName")) updateRoleUI(next);
    return delta;
}

function updateRankProgress(grace) {
    const nameEl = $("rankName");
    if (!nameEl) return;
    const p = rankProgress(grace);
    nameEl.textContent = p.role.name.toUpperCase();
    $("rankNext").textContent = p.nextName ? `· ${p.toNext} to ${p.nextName.toLowerCase()}` : "· apex";
}

function loadScore() {
    return postWithName("/get_score/")
        .then(data => setGrace(Number(data.score)))
        .catch(() => { /* offline — keep server-rendered value */ });
}

// =============================================================================================
// HOME — the prescript queue
// =============================================================================================

const device = {
    items: [],              // unresolved prescripts, newest first: {token, text, sent_at, expires_at, reward, punishment}
    index: 0,               // which one is on screen
    known: new Set(),       // every token seen this page load, to detect genuinely new arrivals
    resolved: new Set(),    // tokens resolved here, so a racing poll can't bring them back
    decoded: new Set(),     // tokens whose decode reveal already played
    accepting: true,
    loadedOnce: false,
    busy: false,
    outcome: false,         // an outcome printout currently owns the queue area
    view: "",               // signature of what's rendered, so ticks don't re-render needlessly
};

function itemExpiry(item) {
    const explicit = Date.parse(item.expires_at || "");
    if (!Number.isNaN(explicit)) return explicit;
    return Date.parse(item.sent_at) + PRESCRIPT_TIME_LIMIT_MS;
}

function serialFor(token) {
    const h = stableHash(token).toString(16).toUpperCase().padStart(8, "0");
    return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

function currentItem() {
    return device.items[device.index] || null;
}

// ---- Log (persists across page loads within the session) ----

function addLog(message, cls) {
    let lines = [];
    try { lines = JSON.parse(sessionStorage.getItem("wotc_log") || "[]"); } catch (err) { lines = []; }
    lines.unshift({ t: hhmmss(new Date()), m: message, c: cls || "" });
    lines = lines.slice(0, 6);
    try { sessionStorage.setItem("wotc_log", JSON.stringify(lines)); } catch (err) { /* ignore */ }
    renderLog(lines);
}

function renderLog(lines) {
    const list = $("deviceLog");
    if (!list) return;
    if (!lines) {
        try { lines = JSON.parse(sessionStorage.getItem("wotc_log") || "[]"); } catch (err) { lines = []; }
    }
    if (!lines.length) {
        list.innerHTML = `<li><span class="dim">no events this session</span></li>`;
        return;
    }
    list.innerHTML = lines.map(l =>
        `<li><time>${escapeHTML(l.t)}</time><span class="${escapeHTML(l.c)}">${escapeHTML(l.m)}</span></li>`
    ).join("");
}

// ---- Rendering ----

function renderScreen(force) {
    const body = $("queueBody");
    if (!body) return;

    const name = getStoredName().trim();
    const item = currentItem();
    const count = device.items.length;

    $("screenCounter").textContent = `${pad2(count ? device.index + 1 : 0)}/${pad2(count)}`;
    $("keyPrev").disabled = count < 2 || device.outcome;
    $("keyNext").disabled = count < 2 || device.outcome;
    $("keyComplete").disabled = !item || device.busy || device.outcome;
    $("keyIgnore").disabled = !item || device.busy || device.outcome;

    if (device.outcome) return; // the outcome printout owns the area until it finishes

    const view = !name ? "noname" : item ? `item:${item.token}` : device.accepting ? "idle" : "standby";
    if (view === device.view && !force) return;
    device.view = view;

    if (view === "noname") {
        body.innerHTML = `
            <p class="fail">no designation registered.</p>
            <p class="dim">register one in the <a href="/menu/" class="bright">terminal</a> [5] to link this device.</p>`;
        return;
    }

    if (view === "idle") {
        body.innerHTML = `
            <p class="dim">queue empty.</p>
            <p>awaiting the will of the city<span class="cursor"></span></p>`;
        return;
    }

    if (view === "standby") {
        body.innerHTML = `
            <p class="fail">device on standby. new prescripts are not being accepted.</p>
            <p class="dim">select the device status above to resume.</p>`;
        return;
    }

    const issued = new Date(item.sent_at);
    const stakes = typeof item.reward === "number"
        ? `<span>reward <b>+${item.reward}</b></span><span>penalty <b class="fail">−${item.punishment}</b></span>`
        : "";
    body.innerHTML = `
        <div class="pres-head">
            <span>PRESCRIPT № ${serialFor(item.token)}</span>
            <span>ISSUED ${Number.isNaN(issued.getTime()) ? "--:--" : hhmm(issued)}</span>
        </div>
        <p class="pres-text" id="scrText"></p>
        <div class="pres-meta">${stakes}<span class="timer" id="screenTimer"></span></div>
        <div class="textbar" id="segbar" aria-hidden="true"></div>`;

    const textEl = $("scrText");
    if (device.decoded.has(item.token)) {
        textEl.textContent = item.text;
    } else {
        device.decoded.add(item.token);
        decodeTextInto(textEl, item.text, 24);
    }
    tickTimer();
}

function tickTimer() {
    const timerEl = $("screenTimer");
    const item = currentItem();
    if (!timerEl || !item || device.outcome) return;

    const remaining = Math.max(0, itemExpiry(item) - Date.now());
    const urgent = remaining < 5 * 60 * 1000;
    timerEl.textContent = `expires ${pad2(Math.floor(remaining / 60000))}:${pad2(Math.floor((remaining % 60000) / 1000))}`;
    timerEl.classList.toggle("is-urgent", urgent);
    renderTextbar($("segbar"), remaining / PRESCRIPT_TIME_LIMIT_MS, { urgent });
}

function deviceTick() {
    // Drop anything past its time limit — the server auto-files it as ignored on its next sweep,
    // and a tap now would just get a 410, so it shouldn't sit there looking actionable.
    const now = Date.now();
    const keep = device.items.filter(item => itemExpiry(item) > now);
    if (keep.length !== device.items.length) {
        const current = currentItem();
        device.items = keep;
        device.index = Math.max(0, Math.min(keep.indexOf(current), keep.length - 1));
        addLog("prescript lapsed", "is-fail");
        renderScreen();
    }
    tickTimer();
}

// ---- Inbox data ----

function loadInbox() { // Called on load, on a poll, on focus, and when the SW signals a push (pwa.js).
    if (!$("queueBody")) return;
    if (!getStoredName().trim()) {
        renderScreen();
        return;
    }

    postWithName("/get_inbox/")
        .then(data => {
            const now = Date.now();
            const incoming = (data.inbox || []).filter(item => !device.resolved.has(item.token) && itemExpiry(item) > now);
            const fresh = incoming.filter(item => !device.known.has(item.token));
            incoming.forEach(item => device.known.add(item.token));

            const current = currentItem();
            device.items = incoming;

            if (fresh.length && device.loadedOnce) {
                device.index = 0; // newest first — jump to what just arrived
                announceArrival(fresh.length);
            } else {
                const keepIdx = current ? incoming.findIndex(i => i.token === current.token) : -1;
                device.index = keepIdx >= 0 ? keepIdx : 0;
            }
            if (!device.loadedOnce && incoming.length) addLog(`${incoming.length} pending in queue`);
            device.loadedOnce = true;
            renderScreen();
        })
        .catch(() => { /* offline — keep what's on screen */ });
}

function announceArrival(count) {
    playAudio();
    buzz([70, 50, 70]);
    restartClass(document.body, "is-signal", 450);
    addLog(count > 1 ? `${count} prescripts received` : "prescript received", "is-clear");
}

function requestPrescript() {
    if (!getStoredName().trim()) {
        toast("no designation registered", "fail");
        return;
    }
    if (!device.accepting) {
        toast("device on standby", "fail");
        return;
    }

    const btn = $("requestPrescriptBtn");
    btn.disabled = true;
    btn.classList.add("is-busy");

    // A short floor on the "receiving" state so it reads as a transmission, not a flicker.
    const minDelay = new Promise(resolve => setTimeout(resolve, REDUCED_MOTION ? 0 : 450));

    Promise.all([postWithName("/request_prescript/"), minDelay])
        .then(([data]) => {
            if (data.status === "success" && data.item) {
                device.known.add(data.item.token);
                device.items.unshift(data.item);
                device.index = 0;
                announceArrival(1);
                renderScreen();
            } else if (data.status === "standby") {
                setDeviceUI(false);
                toast("device on standby", "fail");
            }
        })
        .catch(() => toast("no signal. try again", "fail"))
        .finally(() => {
            btn.disabled = false;
            btn.classList.remove("is-busy");
        });
}

function resolveCurrent(action) { // Same token-based /complete/ and /ignore/ endpoints a notification's
    const item = currentItem();    // action buttons hit, so scoring, history and the ignore-streak alarm
    if (!item || device.busy || device.outcome) return; // behave identically from either place.

    const base = action === "complete" ? "/complete/" : "/ignore/";
    const username = getStoredName().trim();
    const usernameQs = username ? `&username=${encodeURIComponent(username)}` : "";
    const url = `${base}?p=${encodeURIComponent(item.token)}${usernameQs}`;
    const before = currentGrace;

    device.busy = true;
    renderScreen();

    fetch(url)
        .then(response => response.json().then(data => ({ status: response.status, data })))
        .then(({ status, data }) => {
            device.busy = false;
            device.resolved.add(item.token);
            device.items = device.items.filter(i => i.token !== item.token);
            device.index = Math.min(device.index, Math.max(0, device.items.length - 1));

            // 200 = resolved here; 409/410 = already resolved elsewhere (a notification tap, or the
            // auto-expiry sweep) — either way it's no longer pending, so it leaves the queue.
            if (status === 200) {
                const delta = typeof data.grace !== "undefined" ? setGrace(data.grace) : 0;
                showOutcome(action, item, before, delta);
            } else {
                addLog("already filed");
                toast("that prescript was already filed");
                renderScreen();
            }
        })
        .catch(() => {
            device.busy = false;
            toast("no signal. try again", "fail");
            renderScreen();
        });
}

// Prints the result as terminal output in place of the prescript, then returns to the queue.
function showOutcome(action, item, before, delta) {
    const clear = action === "complete";
    const body = $("queueBody");
    device.outcome = true;
    device.view = "";
    renderScreen();

    const after = currentGrace;
    const sign = delta > 0 ? "+" : "−";
    const lines = [
        { text: `> ${action} ${serialFor(item.token)}`, cls: "dim" },
        { html: `  status ....... <span class="tag${clear ? "" : " tag--fail"}">${clear ? "CLEAR" : "FAILED"}</span>` },
        { text: delta ? `  grace ........ ${before ?? after - delta} -> ${after} (${sign}${Math.abs(delta)})` : "  grace ........ unchanged", cls: clear ? "bright" : "fail" },
        { text: "  filed to record.", cls: "dim" },
    ];
    body.innerHTML = lines.map(() => `<p class="out-line"></p>`).join("");
    const els = body.querySelectorAll(".out-line");

    const status = $("status");
    if (status) status.textContent = `${clear ? "Clear" : "Failed"}. ${delta ? `${sign}${Math.abs(delta)} grace.` : ""}`;

    playAudio();
    buzz(clear ? 40 : [90, 60, 90]);
    addLog(`${clear ? "cleared" : "failed"}${delta ? ` ${sign}${Math.abs(delta)}` : ""}`, clear ? "is-clear" : "is-fail");

    (async () => {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.cls) els[i].className = `out-line ${line.cls}`;
            if (line.html) {
                els[i].innerHTML = line.html;
                if (!REDUCED_MOTION) await new Promise(r => setTimeout(r, 160));
            } else {
                await typeInto(els[i], line.text, 10);
            }
        }
        await new Promise(r => setTimeout(r, REDUCED_MOTION ? 700 : 1300));
        device.outcome = false;
        renderScreen(true);
    })();
}

function moveIndex(step) {
    const count = device.items.length;
    if (count < 2 || device.outcome) return;
    device.index = (device.index + step + count) % count;
    renderScreen();
}

// ---- Index Device toggle ----
// Reflects and flips this username's accepting_prescripts flag (toggle_device / get_device_status in
// views.py). Standby only stops *new* prescripts — anything already queued still resolves normally.

function setDeviceUI(accepting) {
    device.accepting = accepting;
    const btn = $("terminal");
    if (btn) {
        btn.classList.toggle("standby", !accepting);
        btn.setAttribute("aria-pressed", accepting ? "true" : "false");
    }
    decodeTextInto($("deviceStatusText"), accepting ? "OPERATIONAL" : "STANDBY");
    renderScreen();
}

function loadDeviceStatus() {
    return postWithName("/device/status/")
        .then(data => setDeviceUI(data.accepting !== false))
        .catch(() => { /* offline */ });
}

function toggleDevice() {
    if (!getStoredName().trim()) {
        toast("no designation registered", "fail");
        return;
    }
    const btn = $("terminal");
    btn.disabled = true;

    postForm("/device/toggle/", `username=${encodeURIComponent(getStoredName().trim())}`)
        .then(r => r.json())
        .then(data => {
            if (data.status === "success") {
                setDeviceUI(data.accepting);
                playAudio();
                addLog(data.accepting ? "device operational" : "standby engaged", data.accepting ? "is-clear" : "is-fail");
            }
        })
        .catch(() => toast("no signal. try again", "fail"))
        .finally(() => { btn.disabled = false; });
}

// ---- Input: keyboard shortcuts, swipe ----

function pressKey(id) {
    const key = $(id);
    if (!key || key.disabled) return false;
    restartClass(key, "is-pressed", 140);
    return true;
}

function initDeviceInput() {
    $("keyPrev").addEventListener("click", () => moveIndex(-1));
    $("keyNext").addEventListener("click", () => moveIndex(1));
    $("keyComplete").addEventListener("click", () => resolveCurrent("complete"));
    $("keyIgnore").addEventListener("click", () => resolveCurrent("ignore"));
    $("requestPrescriptBtn").addEventListener("click", requestPrescript);
    $("terminal").addEventListener("click", toggleDevice);

    document.addEventListener("keydown", (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
        const boot = $("boot");
        if (boot && !boot.hidden && !boot.classList.contains("is-done")) return;

        const key = event.key.toLowerCase();
        if (key === "arrowleft" && pressKey("keyPrev")) moveIndex(-1);
        else if (key === "arrowright" && pressKey("keyNext")) moveIndex(1);
        else if (key === "c" && pressKey("keyComplete")) resolveCurrent("complete");
        else if (key === "i" && pressKey("keyIgnore")) resolveCurrent("ignore");
        else if (key === "r" && pressKey("requestPrescriptBtn")) requestPrescript();
        else return;
        event.preventDefault();
    });

    // Swipe the queue left/right on phones.
    const queue = $("queue");
    let startX = null, startY = null;
    queue.addEventListener("touchstart", (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });
    queue.addEventListener("touchend", (e) => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        startX = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) moveIndex(dx < 0 ? 1 : -1);
    }, { passive: true });
}

// ---- Boot sequence (first visit per session) ----
// Returns true if it's running; onDone fires once it has cleared (straight away if it didn't run).

function runBoot(onDone) {
    const boot = $("boot");
    let seen = false;
    try { seen = sessionStorage.getItem("wotc_booted") === "1"; } catch (err) { seen = true; }
    if (!boot || seen || REDUCED_MOTION) {
        onDone();
        return false;
    }
    try { sessionStorage.setItem("wotc_booted", "1"); } catch (err) { /* ignore */ }

    const name = getStoredName().trim();
    const destination = {
        role: "> opening standing record_",
        history: "> opening procuration record_",
        about: "> decrypting transmission_",
        menu: "> opening terminal_",
    }[document.body.dataset.page] || "> awaiting the will of the City_";
    const lines = [
        "INDEX PRESCRIPT DEVICE  rev.3",
        "",
        "> linking to the City ........ OK",
        `> designation ............... ${name ? name.toUpperCase() : "NONE"}`,
        "> grace ledger .............. SYNCED",
        destination,
    ];
    const full = lines.join("\n");
    const out = $("bootLines");
    boot.hidden = false;
    document.body.classList.add("is-booting");

    let i = 0;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        out.textContent = full;
        boot.classList.add("is-done");
        setTimeout(() => { boot.hidden = true; }, 450);
        addLog("device linked", "is-clear");
        document.body.classList.remove("is-booting");
        onDone();
    };

    const type = () => {
        if (finished) return;
        i += 2;
        out.textContent = full.slice(0, i);
        if (i < full.length) setTimeout(type, 14);
        else setTimeout(finish, 420);
    };
    setTimeout(type, 450);

    boot.addEventListener("click", finish);
    document.addEventListener("keydown", finish, { once: true });
    return true;
}

function initHome() {
    if (!$("queueBody")) return;
    renderLog();
    initDeviceInput();
    renderScreen(true);
    setInterval(() => { if (!document.hidden) deviceTick(); }, 1000);

    loadDeviceStatus();
    loadInbox();
    setInterval(() => { if (!document.hidden) loadInbox(); }, INBOX_POLL_MS);
    window.addEventListener("focus", loadInbox);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) loadInbox(); });
}

// =============================================================================================
// ROLE
// =============================================================================================

function showSeal(image, caption, sealed) {
    const img = $("roleImage");
    if (!img) return;
    if (!img.src.endsWith(image)) img.src = image;
    $("sealCaption").textContent = caption;
    $("sealFrame").classList.toggle("is-sealed", !!sealed);
}

function updateRoleUI(score) {
    const roleInfo = getRoleForGrace(score);
    const progress = rankProgress(score);
    const n = toNumber(score);

    const roleNameEl = $("roleName");
    if (roleNameEl && roleNameEl.textContent !== roleInfo.name.toUpperCase()) decodeTextInto(roleNameEl, roleInfo.name.toUpperCase());

    $("roleScore").textContent = String(score);
    $("roleDescription").textContent = roleInfo.description;
    $("roleNext").textContent = progress.nextName ? `${progress.nextName.toUpperCase()} in ${progress.toNext}` : "none. apex reached";
    renderTextbar($("roleBar"), progress.pct, { suffix: ` ${pad2(Math.round(progress.pct * 100))}%` });

    showSeal(roleInfo.image, `CURRENT · ${roleInfo.name.toUpperCase()}`);
    $("roleImage").alt = `${roleInfo.name} seal`;

    document.querySelectorAll(".role-card").forEach(row => {
        const role = row.dataset.role;
        const threshold = ROLE_THRESHOLDS[role] ?? Infinity;
        // Turncoat is a state you fall into rather than a rank you earn — it only "unlocks" while
        // you're actually in it.
        const unlocked = role === "Turncoat" ? n <= -1 : n >= threshold;
        const active = role === roleInfo.name;
        row.classList.toggle("unlocked", unlocked);
        row.classList.toggle("locked", !unlocked);
        row.classList.toggle("active", active);
        row.querySelector(".levels__status").textContent = active ? "◀ CURRENT" : unlocked ? "CLEARED" : role === "Turncoat" ? "SEALED" : "LOCKED";
    });
}

function initRolePreview() {
    const rows = document.querySelectorAll(".role-card");
    if (!rows.length) return;
    const restore = () => {
        const info = getRoleForGrace(currentGrace ?? 0);
        showSeal(info.image, `CURRENT · ${info.name.toUpperCase()}`);
    };
    rows.forEach(row => {
        const preview = () => {
            const name = row.dataset.role.toUpperCase();
            if (row.classList.contains("unlocked")) showSeal(row.dataset.img, `PREVIEW · ${name}`);
            else showSeal(row.dataset.img, `${name} · LOCKED`, true);
        };
        row.addEventListener("pointerenter", preview);
        row.addEventListener("focus", preview);
        row.addEventListener("pointerleave", restore);
        row.addEventListener("blur", restore);
    });
}

// =============================================================================================
// HISTORY
// =============================================================================================

const historyState = { items: [], filter: "all" };

function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "TODAY";
    if (date.toDateString() === yesterday.toDateString()) return "YESTERDAY";
    return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

function renderHistory() {
    const host = $("history");
    if (!host) return;
    const name = getStoredName().trim();
    const items = historyState.items.filter(item => historyState.filter === "all" || item.action === historyState.filter);

    if (!items.length) {
        const message = !name
            ? 'no designation on record. register one in the <a href="/menu/" class="bright">terminal</a> [5].'
            : historyState.items.length
                ? "no entries match this filter."
                : "record empty. complete or ignore a prescript to begin it.";
        host.innerHTML = `<p class="dim">${message}</p>`;
        return;
    }

    let html = "";
    let lastDay = "";
    items.forEach(item => {
        const date = new Date(item.created_at);
        const valid = !Number.isNaN(date.getTime());
        const day = valid ? dayLabel(date) : "UNDATED";
        if (day !== lastDay) {
            html += `<div class="rule"><span>${escapeHTML(day)}</span></div>`;
            lastDay = day;
        }
        const completed = item.action === "completed";
        html += `
            <div class="entry entry--${completed ? "completed" : "ignored"}">
                <span class="entry__time">${valid ? hhmm(date) : "--:--"}</span>
                <span class="entry__tag">${completed ? "[CLR]" : "[IGN]"}</span>
                <span class="entry__text">${escapeHTML(item.text)}</span>
            </div>`;
    });
    host.innerHTML = html;

    if (!REDUCED_MOTION) {
        Array.from(host.children).forEach((el, i) => {
            el.style.setProperty("--d", `${Math.min(i * 22, 600)}ms`);
            el.classList.add("pl");
        });
    }
}

function renderHistoryStats(totals) {
    const items = historyState.items;
    const completed = totals ? totals.completed : items.filter(i => i.action === "completed").length;
    const ignored = totals ? totals.ignored : items.filter(i => i.action === "ignored").length;
    const total = completed + ignored;
    const rate = total ? Math.round((completed / total) * 100) : 0;

    let streak = 0;
    for (const item of items) {
        if (item.action !== "completed") break;
        streak++;
    }

    animateNumber($("statTotal"), 0, total, 600);
    animateNumber($("statCompleted"), 0, completed, 600);
    animateNumber($("statIgnored"), 0, ignored, 600);
    animateNumber($("statRate"), 0, rate, 600);
    animateNumber($("statStreak"), 0, streak, 600);
    renderTextbar($("rateBar"), rate / 100);
    $("recordCount").textContent = String(total);
}

function loadHistory() {
    if (!$("history")) return;

    document.querySelectorAll(".segmented__btn").forEach(btn => {
        btn.addEventListener("click", () => {
            historyState.filter = btn.dataset.filter;
            document.querySelectorAll(".segmented__btn").forEach(b => {
                const active = b === btn;
                b.classList.toggle("is-active", active);
                b.setAttribute("aria-selected", active ? "true" : "false");
            });
            renderHistory();
        });
    });

    if (!getStoredName().trim()) {
        renderHistory();
        renderHistoryStats();
        return;
    }

    postWithName("/get_history/")
        .then(data => {
            historyState.items = data.history || [];
            renderHistoryStats(data.totals);
            renderHistory();
        })
        .catch(() => {
            $("history").innerHTML = '<p class="fail">no signal. the record could not be read.</p>';
        });
}

// =============================================================================================
// ABOUT
// =============================================================================================

function initAbout() {
    const tabs = document.querySelectorAll(".tabs__btn");
    const select = (tab) => {
        tabs.forEach(t => {
            const active = t === tab;
            t.classList.toggle("is-active", active);
            t.setAttribute("aria-selected", active ? "true" : "false");
            const panel = $(t.getAttribute("aria-controls"));
            if (panel) panel.hidden = !active;
        });
    };
    tabs.forEach(tab => tab.addEventListener("click", () => select(tab)));
    if (tabs.length) {
        document.addEventListener("keydown", (event) => {
            if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === "a") select(tabs[0]);
            if (event.key === "b" && tabs[1]) select(tabs[1]);
        });
    }

    const reveals = document.querySelectorAll(".reveal");
    if (!reveals.length) return;
    if (!("IntersectionObserver" in window) || REDUCED_MOTION) {
        reveals.forEach(el => el.classList.add("is-visible"));
        return;
    }
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
        });
    }, { rootMargin: "0px 0px -6% 0px" });
    reveals.forEach(el => observer.observe(el));
}

// =============================================================================================
// TERMINAL (menu)
// =============================================================================================

function initTerminal() {
    const form = $("nameForm");
    if (!form) return;
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = $("usernameInput");
        const name = input.value.trim();
        if (!name) {
            toast("enter a designation first", "fail");
            input.focus();
            return;
        }
        const changed = name !== getStoredName().trim();
        setStoredName(name);
        restartClass(form, "is-saved", 700);
        playAudio();
        toast(changed ? `designation registered: ${name}` : "designation unchanged");
        // Re-file this browser's push subscription under the new name (pwa.js).
        if (changed && typeof ensurePushRegistered === "function") ensurePushRegistered();
    });
}

// =============================================================================================

function initPage() {
    updateNameUI();
    initPageTransitions();
    initClock();
    initSoundToggle();
    initHome();
    initRolePreview();
    loadHistory();
    initAbout();
    initTerminal();
    loadScore();

    // On the first visit of a session the boot sequence plays first; the screen prints after it.
    runBoot(printScreen);
}

initPage();
