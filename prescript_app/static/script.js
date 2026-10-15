// The Will of The City — client script, loaded on every page (see templates/base.html).
//
// Top-level function declarations stay global on purpose: pwa.js calls getStoredName() and
// loadInbox() directly. Each page section below no-ops when its elements aren't on the page.

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
    if (greeting) greeting.textContent = page === "role" ? `${name}'s standing` : name;

    const historyHeader = $("historyHeader");
    if (historyHeader) historyHeader.textContent = `${name}'s procurations`;

    const recordOwner = $("recordOwner");
    if (recordOwner) recordOwner.textContent = name.toUpperCase();

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

    const pager = $("pager");
    if (pager) {
        pager.classList.remove("is-beeping");
        void pager.offsetWidth;
        pager.classList.add("is-beeping");
    }
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
        btn.setAttribute("aria-label", on ? "Sound on" : "Sound off");
    };
    sync();
    btn.addEventListener("click", () => {
        try { localStorage.setItem("wotc_sound", isMuted() ? "on" : "off"); } catch (err) { /* ignore */ }
        sync();
        if (!isMuted()) playAudio();
        toast(isMuted() ? "Sound muted" : "Sound on");
    });
}

// ---- Small UI helpers ------------------------------------------------------------------------

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

function stableHash(seed) {
    return Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
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

// Minimum grace for each tier. Proxy and Messenger share a tier; which one a user gets is picked
// deterministically from their name, so it never flips between page loads.
const ROLE_THRESHOLDS = { Turncoat: -Infinity, Civilian: 0, Proselyte: 51, Proxy: 126, Messenger: 126, Weaver: 201 };

function stablePick(seed, options) {
    const hash = Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    return options[hash % options.length];
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
    else if (n <= 200) name = stablePick(getStoredName().trim() || "__anon__", ["Proxy", "Messenger"]);
    else name = "Weaver";
    return { name, ...ROLE_INFO[name] };
}

// Where the user sits relative to the next rank: { role, nextName, nextAt, pct (0..1), toNext }.
function rankProgress(grace) {
    const n = toNumber(grace) || 0;
    const role = getRoleForGrace(n);
    const pair = stablePick(getStoredName().trim() || "__anon__", ["Proxy", "Messenger"]);
    const clamp = (v) => Math.max(0, Math.min(1, v));

    if (n < 0) return { role, nextName: "Civilian", nextAt: 0, pct: clamp(1 + n / 50), toNext: -n };
    if (n <= 50) return { role, nextName: "Proselyte", nextAt: 51, pct: clamp(n / 51), toNext: 51 - n };
    if (n <= 125) return { role, nextName: pair, nextAt: 126, pct: clamp((n - 51) / 75), toNext: 126 - n };
    if (n <= 200) return { role, nextName: "Weaver", nextAt: 201, pct: clamp((n - 126) / 75), toNext: 201 - n };
    return { role, nextName: null, nextAt: null, pct: 1, toNext: 0 };
}

// Ladder position (0..100%) — piecewise so every tier gets an equal stretch of track.
function ladderPosition(grace) {
    const n = toNumber(grace) || 0;
    if (n < 0) return Math.max(0, 25 + (n / 50) * 25);
    if (n <= 50) return 25 + (n / 51) * 25;
    if (n <= 125) return 50 + ((n - 51) / 75) * 25;
    if (n <= 200) return 75 + ((n - 126) / 75) * 25;
    return 100;
}

// ---- Grace (shared by every page) -------------------------------------------------------------

let currentGrace = null;

function setGrace(value, { animate = true } = {}) {
    const next = toNumber(value);
    if (Number.isNaN(next)) return;
    const prev = currentGrace;
    currentGrace = next;
    const from = prev === null ? 0 : prev;
    const delta = prev === null ? 0 : next - prev;

    const graceEl = $("grace");
    if (graceEl) {
        animateNumber(graceEl, animate ? from : next, next, prev === null ? 1100 : 800);
        if (delta) {
            graceEl.classList.remove("is-up", "is-down");
            restartClass(graceEl, delta > 0 ? "is-up" : "is-down", 1300);
            const deltaEl = $("graceDelta");
            if (deltaEl) {
                deltaEl.textContent = (delta > 0 ? "+" : "−") + Math.abs(delta);
                deltaEl.classList.remove("is-up", "is-down");
                restartClass(deltaEl, delta > 0 ? "is-up" : "is-down", 1500);
            }
        }
    }

    const chip = $("graceChip");
    if (chip) {
        animateNumber(chip, animate ? from : next, next, 800);
        const link = chip.closest(".grace-chip");
        if (delta && link) restartClass(link, "is-bump", 700);
    }

    updateRankProgress(next);
    if ($("roleName")) updateRoleUI(next);
    return delta;
}

function updateRankProgress(grace) {
    const nameEl = $("rankName");
    if (!nameEl) return;
    const p = rankProgress(grace);
    nameEl.textContent = p.role.name;
    $("rankNext").textContent = p.nextName ? `${p.toNext} to ${p.nextName}` : "Apex reached";
    $("rankBar").style.width = `${Math.round(p.pct * 100)}%`;
}

function loadScore() {
    return postWithName("/get_score/")
        .then(data => setGrace(Number(data.score)))
        .catch(() => { /* offline — keep server-rendered value */ });
}

// =============================================================================================
// HOME — the Index device
// =============================================================================================

const device = {
    items: [],              // unresolved prescripts, newest first: {token, text, sent_at, expires_at, reward, punishment}
    index: 0,               // which one is on screen
    known: new Set(),       // every token seen this page load, to detect genuinely new arrivals
    resolved: new Set(),    // tokens resolved here, so a racing poll can't bring them back
    decoded: new Set(),     // tokens whose reveal animation already played
    accepting: true,
    loadedOnce: false,
    busy: false,
    outcome: false,         // CLEAR/FAILED takeover currently on screen
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

// ---- Device log (persists across page loads within the session) ----

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
    list.innerHTML = lines.map(l =>
        `<li><time>${escapeHTML(l.t)}</time><span class="${escapeHTML(l.c)}">${escapeHTML(l.m)}</span></li>`
    ).join("");
}

// ---- Rendering ----

function renderScreen(force) {
    const body = $("screenBody");
    if (!body) return;

    const pager = $("pager");
    const name = getStoredName().trim();
    const item = currentItem();
    const count = device.items.length;

    pager.classList.toggle("is-standby", !device.accepting);
    pager.classList.toggle("has-msg", count > 0 && device.accepting);
    pager.classList.toggle("is-linked", !!name);

    $("screenCounter").textContent = `MSG ${pad2(count ? device.index + 1 : 0)}/${pad2(count)}`;
    $("screenState").textContent = !name ? "○ UNLINKED" : !device.accepting ? "■ STANDBY" : count ? "● INCOMING" : "● LINKED";

    const keyPrev = $("keyPrev"), keyNext = $("keyNext");
    keyPrev.disabled = count < 2;
    keyNext.disabled = count < 2;
    $("keyComplete").disabled = !item || device.busy || device.outcome;
    $("keyIgnore").disabled = !item || device.busy || device.outcome;

    renderQueueDots();

    if (device.outcome) return; // the takeover owns the screen until it finishes

    const view = !name ? "noname" : item ? `item:${item.token}` : device.accepting ? "idle" : "standby";
    if (view === device.view && !force) return;
    device.view = view;

    if (!item) {
        $("screenStakes").innerHTML = "";
        $("screenTimer").textContent = "";
        renderSegbar(0, false);
    }

    if (view === "noname") {
        body.innerHTML = `
            <div class="scr-view scr-idle">
                <div class="scr-emblem"><img src="/static/index_logo.webp" alt=""></div>
                <div class="scr-msg">No designation</div>
                <p class="scr-sub">Register a name in the <a href="/menu/">Terminal</a> to link this device.</p>
            </div>`;
        return;
    }

    if (view === "idle" || view === "standby") {
        const standby = view === "standby";
        body.innerHTML = `
            <div class="scr-view scr-idle">
                <div class="scr-emblem"><img src="/static/index_logo.webp" alt=""></div>
                <div class="scr-msg">${standby ? "Device on standby" : "Awaiting prescript"}<span class="cursor"></span></div>
                <p class="scr-sub">${standby ? "Flip the switch to resume receiving." : "Press Receive, or wait for the City to speak."}</p>
            </div>`;
        return;
    }

    body.innerHTML = `
        <div class="scr-view">
            <span class="scr-serial">PRESCRIPT № ${serialFor(item.token)}</span>
            <p class="scr-text" id="scrText"></p>
        </div>`;
    const textEl = $("scrText");
    if (device.decoded.has(item.token)) {
        textEl.textContent = item.text;
    } else {
        device.decoded.add(item.token);
        decodeTextInto(textEl, item.text, 26);
    }

    const stakes = $("screenStakes");
    if (typeof item.reward === "number") {
        stakes.innerHTML = `<span class="up">▲ +${item.reward}</span><span class="down">▼ −${item.punishment}</span>`;
    } else {
        stakes.innerHTML = "";
    }
    tickTimer();
}

function renderQueueDots() {
    const host = $("queueDots");
    if (!host) return;
    const now = Date.now();
    host.innerHTML = device.items.slice(0, 24).map((item, i) => {
        const urgent = itemExpiry(item) - now < 5 * 60 * 1000;
        return `<i class="${i === device.index ? "is-current" : ""}${urgent ? " is-urgent" : ""}"></i>`;
    }).join("");
}

function renderSegbar(fraction, urgent) {
    const bar = $("segbar");
    if (!bar) return;
    if (!bar.children.length) bar.innerHTML = "<i></i>".repeat(24);
    const on = Math.ceil(fraction * 24);
    Array.from(bar.children).forEach((seg, i) => seg.classList.toggle("on", i < on));
    bar.classList.toggle("is-urgent", !!urgent);
}

function tickTimer() {
    const timerEl = $("screenTimer");
    if (!timerEl) return;
    const item = currentItem();
    if (!item || device.outcome) return;

    const remaining = Math.max(0, itemExpiry(item) - Date.now());
    const urgent = remaining < 5 * 60 * 1000;
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `⏱ ${pad2(mins)}:${pad2(secs)}`;
    timerEl.classList.toggle("is-urgent", urgent);
    renderSegbar(remaining / PRESCRIPT_TIME_LIMIT_MS, urgent);
}

function deviceTick() {
    const clock = $("deviceClock");
    if (clock) clock.textContent = hhmmss(new Date());

    // Drop anything past its time limit — the server auto-files it as ignored on its next sweep,
    // and a tap now would just get a 410, so it shouldn't sit there looking actionable.
    const now = Date.now();
    const before = device.items.length;
    const keep = device.items.filter(item => itemExpiry(item) > now);
    if (keep.length !== before) {
        const current = currentItem();
        device.items = keep;
        device.index = Math.max(0, Math.min(keep.indexOf(current), keep.length - 1));
        addLog(`PRESCRIPT LAPSED`, "is-fail");
        renderScreen();
    }
    tickTimer();
}

// ---- Inbox data ----

function loadInbox() { // Called on load, on a poll, on focus, and when the SW signals a push (pwa.js).
    if (!$("screenBody")) return;
    const name = getStoredName().trim();
    if (!name) {
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
            if (!device.loadedOnce && incoming.length) addLog(`${incoming.length} PENDING IN QUEUE`);
            device.loadedOnce = true;
            renderScreen();
        })
        .catch(() => { /* offline — keep what's on screen */ });
}

function announceArrival(count) {
    playAudio();
    buzz([70, 50, 70]);
    restartClass($("pager"), "is-shaking", 600);
    restartClass($("screenFlash"), "flash-new", 520);
    addLog(count > 1 ? `${count} PRESCRIPTS RECEIVED` : "PRESCRIPT RECEIVED");
}

function requestPrescript() {
    const name = getStoredName().trim();
    if (!name) {
        toast("Register a designation in the Terminal first", "fail");
        return;
    }
    if (!device.accepting) {
        toast("Device on standby — flip the switch to receive", "fail");
        restartClass($("pager"), "is-shaking", 600);
        return;
    }

    const btn = $("requestPrescriptBtn");
    btn.disabled = true;
    btn.classList.add("is-busy");

    // A short floor on the "receiving" state so the scan animation reads as intentional rather
    // than a flicker on a fast connection.
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
                toast("Device on standby", "fail");
            }
        })
        .catch(() => toast("No signal — try again", "fail"))
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
                showOutcome(action, delta);
            } else {
                addLog("ALREADY FILED");
                toast("That prescript was already filed");
                renderScreen();
            }
        })
        .catch(() => {
            device.busy = false;
            toast("No signal — try again", "fail");
            renderScreen();
        });
}

function showOutcome(action, delta) {
    const clear = action === "complete";
    const word = clear ? "CLEAR" : "FAILED";
    const body = $("screenBody");

    device.outcome = true;
    device.view = "";
    $("screenStakes").innerHTML = "";
    $("screenTimer").textContent = "";
    renderSegbar(0, false);

    const deltaText = delta ? `${delta > 0 ? "+" : "−"}${Math.abs(delta)} GRACE` : "";
    body.innerHTML = `
        <div class="scr-view scr-outcome${clear ? "" : " scr-outcome--fail"}">
            <div class="scr-outcome__word" data-text="${word}">${word}</div>
            <div class="scr-outcome__delta">${deltaText}</div>
        </div>`;

    const status = $("status");
    if (status) status.textContent = `${word}. ${deltaText}`;

    playAudio();
    buzz(clear ? 40 : [90, 60, 90]);
    restartClass($("screenFlash"), clear ? "flash-clear" : "flash-fail", 720);
    if (!clear) restartClass($("pager"), "is-shaking", 600);
    addLog(`${clear ? "CLEARED" : "FAILED"}${deltaText ? " " + deltaText.replace(" GRACE", "") : ""}`, clear ? "is-clear" : "is-fail");

    renderScreen();
    setTimeout(() => {
        device.outcome = false;
        renderScreen(true);
    }, REDUCED_MOTION ? 900 : 1500);
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
    decodeTextInto($("deviceStatusText"), accepting ? "Operational" : "Standby");
    renderScreen();
}

function loadDeviceStatus() {
    return postWithName("/device/status/")
        .then(data => {
            device.accepting = data.accepting !== false;
            setDeviceUI(device.accepting);
        })
        .catch(() => { /* offline */ });
}

function toggleDevice() {
    if (!getStoredName().trim()) {
        toast("Register a designation in the Terminal first", "fail");
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
                addLog(data.accepting ? "DEVICE OPERATIONAL" : "STANDBY ENGAGED", data.accepting ? "is-clear" : "is-fail");
            }
        })
        .catch(() => toast("No signal — try again", "fail"))
        .finally(() => { btn.disabled = false; });
}

// ---- Input: keys, keyboard shortcuts, swipe ----

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
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const tag = (event.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || event.target.isContentEditable) return;
        if (!$("boot").hidden && !$("boot").classList.contains("is-done")) return;

        const key = event.key.toLowerCase();
        if (key === "arrowleft" && pressKey("keyPrev")) moveIndex(-1);
        else if (key === "arrowright" && pressKey("keyNext")) moveIndex(1);
        else if (key === "c" && pressKey("keyComplete")) resolveCurrent("complete");
        else if (key === "i" && pressKey("keyIgnore")) resolveCurrent("ignore");
        else if (key === "r" && pressKey("requestPrescriptBtn")) requestPrescript();
        else return;
        event.preventDefault();
    });

    // Swipe the screen left/right to page through the queue on phones.
    const screen = $("screen");
    let startX = null, startY = null;
    screen.addEventListener("touchstart", (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });
    screen.addEventListener("touchend", (e) => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        startX = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) moveIndex(dx < 0 ? 1 : -1);
    }, { passive: true });
}

// ---- Boot sequence (first visit per session) ----

function runBoot() {
    const boot = $("boot");
    let seen = false;
    try { seen = sessionStorage.getItem("wotc_booted") === "1"; } catch (err) { seen = true; }
    if (!boot || seen || REDUCED_MOTION) return;
    try { sessionStorage.setItem("wotc_booted", "1"); } catch (err) { /* ignore */ }

    const name = getStoredName().trim();
    const lines = [
        "INDEX PRESCRIPT DEVICE  rev.3",
        "",
        "> linking to the City ........ OK",
        `> designation ............... ${name ? name.toUpperCase() : "NONE"}`,
        "> grace ledger .............. SYNCED",
        "> awaiting the will of the City_",
    ];
    const full = lines.join("\n");
    const out = $("bootLines");
    boot.hidden = false;

    let i = 0;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        out.textContent = full;
        boot.classList.add("is-done");
        setTimeout(() => { boot.hidden = true; }, 500);
        addLog("DEVICE LINKED", "is-clear");
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
}

function initHome() {
    if (!$("pager")) return;
    runBoot();
    renderLog();
    initDeviceInput();
    renderScreen(true);
    deviceTick();
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

const LADDER_NODES = [
    { label: "Turncoat", at: "< 0", pos: 0, min: -Infinity },
    { label: "Civilian", at: "0", pos: 25, min: 0 },
    { label: "Proselyte", at: "51", pos: 50, min: 51 },
    { label: "Proxy · Messenger", at: "126", pos: 75, min: 126 },
    { label: "Weaver", at: "201", pos: 100, min: 201 },
];

function renderLadder(grace) {
    const nodes = $("ladderNodes");
    if (!nodes) return;
    const n = toNumber(grace) || 0;
    if (!nodes.children.length) {
        nodes.innerHTML = LADDER_NODES.map(node =>
            `<li class="ladder__node" style="left:${node.pos}%"><b>${node.at}</b><span>${node.label}</span></li>`
        ).join("");
    }
    Array.from(nodes.children).forEach((li, i) => li.classList.toggle("is-reached", n >= LADDER_NODES[i].min));

    const pos = ladderPosition(n);
    // Let the first paint land at 0 so the fill visibly sweeps up to the real value.
    requestAnimationFrame(() => {
        $("ladderFill").style.width = `${pos}%`;
        $("ladderMarker").style.left = `${pos}%`;
    });
    $("ladderMarkerLabel").textContent = String(n);
}

function updateRoleUI(score) {
    const roleInfo = getRoleForGrace(score);
    const progress = rankProgress(score);

    const roleNameEl = $("roleName");
    if (roleNameEl && roleNameEl.textContent !== roleInfo.name) decodeTextInto(roleNameEl, roleInfo.name);

    const roleScoreEl = $("roleScore");
    if (roleScoreEl) roleScoreEl.textContent = String(score);

    const roleDescEl = $("roleDescription");
    if (roleDescEl) roleDescEl.textContent = roleInfo.description;

    const roleImageEl = $("roleImage");
    if (roleImageEl && !roleImageEl.src.endsWith(roleInfo.image)) {
        roleImageEl.src = roleInfo.image;
        roleImageEl.alt = `${roleInfo.name} seal`;
    }

    const roleNext = $("roleNext");
    if (roleNext) roleNext.textContent = progress.nextName ? `${progress.nextName} · ${progress.toNext} to go` : "Apex reached";

    renderLadder(score);

    const n = toNumber(score);
    document.querySelectorAll(".role-card").forEach((card, i) => {
        const role = card.dataset.role;
        const threshold = ROLE_THRESHOLDS[role] ?? Infinity;
        // Turncoat is a state you fall into rather than a rank you earn — it only "unlocks" while
        // you're actually in it.
        const unlocked = role === "Turncoat" ? n <= -1 : n >= threshold;
        card.classList.toggle("unlocked", unlocked);
        card.classList.toggle("locked", !unlocked);
        card.classList.toggle("active", role === roleInfo.name);
        card.style.setProperty("--i", i);
        const label = card.querySelector(".role-card__lock-label");
        if (label) label.textContent = role === "Turncoat" ? "Sealed" : `Requires ${threshold} grace`;
    });
}

function initRoleTilt() {
    if (REDUCED_MOTION || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    document.querySelectorAll(".role-card").forEach(card => {
        card.addEventListener("pointermove", (e) => {
            const r = card.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width;
            const y = (e.clientY - r.top) / r.height;
            card.style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
            card.style.setProperty("--rx", `${(0.5 - y) * 10}deg`);
            card.style.setProperty("--gx", `${x * 100}%`);
            card.style.setProperty("--gy", `${y * 100}%`);
        });
        card.addEventListener("pointerleave", () => {
            card.style.setProperty("--rx", "0deg");
            card.style.setProperty("--ry", "0deg");
        });
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
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function renderHistory() {
    const host = $("history");
    if (!host) return;
    const name = getStoredName().trim();
    const items = historyState.items.filter(item => historyState.filter === "all" || item.action === historyState.filter);

    if (!items.length) {
        const message = !name
            ? 'No designation on record. Register one in the <a href="/menu/">Terminal</a>.'
            : historyState.items.length
                ? "Nothing matches this filter."
                : "The record is empty. Complete or ignore a prescript to begin it.";
        host.innerHTML = `<div class="empty-state is-static"><span class="empty-state__ring" aria-hidden="true"></span><p>${message}</p></div>`;
        return;
    }

    let html = "";
    let lastDay = "";
    items.forEach((item, i) => {
        const date = new Date(item.created_at);
        const valid = !Number.isNaN(date.getTime());
        const day = valid ? dayLabel(date) : "Undated";
        if (day !== lastDay) {
            html += `<div class="timeline__day">${escapeHTML(day)}</div>`;
            lastDay = day;
        }
        const time = valid ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "--:--";
        const completed = item.action === "completed";
        html += `
            <div class="entry entry--${completed ? "completed" : "ignored"}" style="--i:${Math.min(i, 20)}">
                <span class="entry__time">${time}</span>
                <span class="entry__tag">${completed ? "CLR" : "IGN"}</span>
                <span class="entry__text">${escapeHTML(item.text)}</span>
            </div>`;
    });
    host.innerHTML = html;
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

    animateNumber($("statTotal"), 0, total);
    animateNumber($("statCompleted"), 0, completed);
    animateNumber($("statIgnored"), 0, ignored);
    animateNumber($("statRate"), 0, rate);
    animateNumber($("statStreak"), 0, streak);

    const ring = $("statRateRing");
    if (ring) requestAnimationFrame(() => { ring.style.strokeDashoffset = String(113.1 * (1 - rate / 100)); });

    const count = $("recordCount");
    if (count) count.textContent = `${total} ${total === 1 ? "ENTRY" : "ENTRIES"}`;
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
            $("history").innerHTML = '<div class="empty-state is-static"><span class="empty-state__ring"></span><p>No signal. The record could not be read.</p></div>';
        });
}

// =============================================================================================
// ABOUT
// =============================================================================================

function initAbout() {
    const tabs = document.querySelectorAll(".tabs__btn");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => {
                const active = t === tab;
                t.classList.toggle("is-active", active);
                t.setAttribute("aria-selected", active ? "true" : "false");
                const panel = $(t.getAttribute("aria-controls"));
                if (panel) panel.hidden = !active;
            });
        });
    });

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
    }, { rootMargin: "0px 0px -8% 0px" });
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
            toast("Enter a designation first", "fail");
            input.focus();
            return;
        }
        const changed = name !== getStoredName().trim();
        setStoredName(name);
        restartClass(input.closest(".field-row"), "is-saved", 900);
        playAudio();
        toast(changed ? `Designation registered: ${name}` : "Designation unchanged");
        // Re-file this browser's push subscription under the new name (pwa.js).
        if (changed && typeof ensurePushRegistered === "function") ensurePushRegistered();
    });
}

// =============================================================================================
// Global
// =============================================================================================

function initBackdrop() {
    if (REDUCED_MOTION || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let queued = false, x = 0, y = 0;
    window.addEventListener("pointermove", (e) => {
        x = e.clientX; y = e.clientY;
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            document.documentElement.style.setProperty("--mx", `${x}px`);
            document.documentElement.style.setProperty("--my", `${y}px`);
            queued = false;
        });
    }, { passive: true });
}

function initPage() {
    updateNameUI();
    document.querySelectorAll("[data-decode]").forEach(el => decodeTextInto(el, el.textContent.trim(), 34));

    initBackdrop();
    initSoundToggle();
    initHome();
    initRoleTilt();
    loadHistory();
    initAbout();
    initTerminal();
    loadScore();
}

initPage();
