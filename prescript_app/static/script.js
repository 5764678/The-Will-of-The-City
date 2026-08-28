
function getCookie(name) {                 // Reads a cookie value by name (used to grab Django's csrftoken cookie so
    const value = `; ${document.cookie}`;  // POST requests can carry it in the X-CSRFToken header, as required now
    const parts = value.split(`; ${name}=`); // that CsrfViewMiddleware is enabled).
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
    return "";
}

function postForm(url, bodyString) {   // Wrapper around fetch() for POST requests that attaches the CSRF token
    return fetch(url, {                // header Django requires for unsafe (state-changing) methods.
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRFToken": getCookie("csrftoken"),
        },
        body: bodyString
    });
}

function animateStatus(message, statusClass) {          // This function creates a "decode-style" animation effect for the status message, where random characters are rapidly replaced
    const statusEl = document.getElementById("status"); // by the actual message characters over a short duration. It also plays a sound effect to enhance the experience.
                                                          // statusClass ("clear"/"failed") tints the text green/red via CSS — see #status.clear/.failed in style.css.
    let symbols = "!@#$%^&*ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
    let current = Array(message.length).fill("");
    playAudio();
    let frame = 0;

    statusEl.classList.remove("clear", "failed");
    if (statusClass) {
        statusEl.classList.add(statusClass);
    }

    let interval = setInterval(() => {
        for (let i = 0; i < message.length; i++) {
            if (Math.random() < frame / 20) {
                current[i] = message[i];
            } else {
                current[i] = symbols[Math.floor(Math.random() * symbols.length)];
            }
        }

        statusEl.innerText = ".-" + current.join("") + "-.";

        frame++;

        if (frame > 20) {
            clearInterval(interval);
            statusEl.innerText = ".-" + message + "-.";

            // Scheduled only once, after the reveal finishes — previously this setTimeout was
            // inside the interval callback, so it fired once per 100ms tick (~20 redundant timers
            // stacked up for one status message, all doing the same idempotent clear).
            setTimeout(() => {
                statusEl.innerText = "";
                statusEl.classList.remove("clear", "failed");
            }, 4000);
        }
    }, 100);
}

// ---- Inbox (home page) ----------------------------------------------------------------------
// The home page shows every unresolved prescript as its own card (get_inbox), newest on top.
// A card disappears the moment its own Complete/Ignore resolves — nothing here assumes there's
// only one prescript at a time the way the old single-slot #prescript/completeBtn/ignoreBtn setup
// did. shownInboxTokens tracks which tokens are already rendered so polling/live-push updates
// only ever add what's actually new, never duplicate a card.

const shownInboxTokens = new Set();
const INBOX_POLL_MS = 20000; // catches a scheduled push arriving while the page is open even if
                              // the service-worker "new-prescript" message (see pwa.js) is missed

function decodeTextInto(el, newText) { // Generalized version of the old decodeText(): reveals `newText` into
    if (!el) return;                   // an arbitrary element with the same "decode" character-scramble animation.
    const target = newText || "";
    el.dataset.text = target;
    el.textContent = target; // ensure immediate readability even before the animation starts

    if (!target) return;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";
    let revealed = Array(target.length).fill(false);

    function decode() {
        let output = "";
        for (let i = 0; i < target.length; i++) {
            if (revealed[i] || target[i] === " ") {
                revealed[i] = true;
                output += target[i];
            } else {
                output += chars[Math.floor(Math.random() * chars.length)];
                if (Math.random() < 0.08) {
                    revealed[i] = true;
                }
            }
        }

        el.textContent = output;
        if (revealed.includes(false)) {
            setTimeout(decode, 30);
        } else {
            el.textContent = target;
        }
    }

    decode();
}

function resolveInboxItem(token, action, card) { // Tapping Complete/Ignore on one specific inbox card. Reuses the
    const username = getStoredName().trim();     // existing token-based /complete//ignore/ endpoints (the same ones a
    const base = action === "complete" ? "/complete/" : "/ignore/"; // notification's own action buttons hit) — so scoring,
    const usernameQs = username ? `&username=${encodeURIComponent(username)}` : "";             // history, and the ignore-streak alarm all work identically
    const url = `${base}?p=${encodeURIComponent(token)}${usernameQs}`;                          // whether the tap came from the phone or from here.

    const buttons = card.querySelectorAll("button");
    buttons.forEach(b => b.disabled = true);

    fetch(url)
        .then(response => response.json().then(data => ({ ok: response.ok, status: response.status, data })))
        .then(({ status, data }) => {
            if (typeof data.grace !== "undefined") {
                const graceEl = document.getElementById("grace");
                if (graceEl) graceEl.innerText = "Grace: " + data.grace;
                const roleScoreEl = document.getElementById("roleScore");
                if (roleScoreEl) updateRoleUI(data.grace);
                funcUpdateScore(data.grace);
            }

            // 200 = just resolved here; 409/410 = someone/something else already resolved it
            // (a notification tap, or the 40-minute auto-expiry sweep) — either way it's no
            // longer pending, so the card comes off the list rather than sitting there dead.
            if (status === 200) {
                animateStatus(action === "complete" ? "Clear" : "Failed", action === "complete" ? "clear" : "failed");
            }
            removeInboxItem(token);
        })
        .catch(() => {
            buttons.forEach(b => b.disabled = false); // network hiccup — leave the card so they can retry
        });
}

function renderInboxCard(item) {
    const card = document.createElement("div");
    card.className = "inbox-item";
    card.dataset.token = item.token;

    const textEl = document.createElement("div");
    textEl.className = "inbox-item__text";
    card.appendChild(textEl);

    const actions = document.createElement("div");
    actions.className = "inbox-item__actions";

    const completeBtn = document.createElement("button");
    completeBtn.textContent = "Complete";
    completeBtn.addEventListener("click", () => resolveInboxItem(item.token, "complete", card));

    const ignoreBtn = document.createElement("button");
    ignoreBtn.textContent = "Ignore";
    ignoreBtn.addEventListener("click", () => resolveInboxItem(item.token, "ignore", card));

    actions.appendChild(completeBtn);
    actions.appendChild(ignoreBtn);
    card.appendChild(actions);

    return { card, textEl };
}

function updateInboxEmptyState() {
    const inboxEl = document.getElementById("inbox");
    if (!inboxEl) return;

    const hasCards = inboxEl.querySelector(".inbox-item") !== null;
    const existingEmpty = document.getElementById("inboxEmpty");

    if (hasCards) {
        if (existingEmpty) existingEmpty.remove();
        return;
    }
    if (existingEmpty) return;

    const name = getStoredName().trim();
    const empty = document.createElement("div");
    empty.id = "inboxEmpty";
    empty.className = "inbox-empty";
    empty.textContent = name
        ? "Inbox is empty. Tap Request Prescript to receive one."
        : "Save a name from the Menu to start receiving prescripts.";
    inboxEl.appendChild(empty);
}

function prependInboxItem(item) { // Inserts one new card at the top ("stacks over" existing ones) and plays
    if (shownInboxTokens.has(item.token)) return; // its decode-reveal animation. No-ops on a token already shown, so
    const inboxEl = document.getElementById("inbox");                     // polling/live-push updates never create duplicate cards.
    if (!inboxEl) return;

    shownInboxTokens.add(item.token);
    const { card, textEl } = renderInboxCard(item);
    inboxEl.insertBefore(card, inboxEl.firstChild);
    decodeTextInto(textEl, item.text);
    updateInboxEmptyState();
}

function removeInboxItem(token) {
    shownInboxTokens.delete(token);
    const inboxEl = document.getElementById("inbox");
    if (!inboxEl) return;
    const card = Array.from(inboxEl.children).find(c => c.dataset.token === token);
    if (card) card.remove();
    updateInboxEmptyState();
}

function loadInbox() { // Fetches the current unresolved-prescript list and adds whatever isn't already shown —
    const inboxEl = document.getElementById("inbox"); // called on page load, on a poll interval, on window focus, and
    if (!inboxEl) return;                              // immediately when the service worker signals a push arrived (see pwa.js).

    const name = getStoredName().trim();
    if (!name) {
        updateInboxEmptyState();
        return;
    }

    postForm("/get_inbox/", `username=${encodeURIComponent(name)}`)
        .then(response => response.json())
        .then(data => {
            const items = (data.inbox || []).filter(item => !shownInboxTokens.has(item.token));
            // Server returns newest-first; reverse so prepending oldest-of-the-new-batch first
            // leaves the actual newest item on top once all of them are inserted.
            items.reverse().forEach(item => prependInboxItem(item));
            if (items.length === 0) updateInboxEmptyState();
        });
}

function requestPrescript() { // The inbox's "Request Prescript" button — generates one on demand instead of
    const name = getStoredName().trim(); // waiting for the next scheduled push. See request_prescript in views.py.
    if (!name) {
        animateStatus("Save a name first");
        return;
    }

    const btn = document.getElementById("requestPrescriptBtn");
    if (btn) btn.disabled = true;

    postForm("/request_prescript/", `username=${encodeURIComponent(name)}`)
        .then(response => response.json())
        .then(data => {
            if (data.status === "success" && data.item) {
                prependInboxItem(data.item);
            }
        })
        .finally(() => {
            if (btn) btn.disabled = false;
        });
}

function playAudio() { // This function plays a beep sound effect. It resets the audio to the start and sets the volume before playing, allowing for repeated rapid calls without waiting for the sound to finish.
    const beep = document.getElementById("beep");
    if (!beep) return;

    // Reset to the start in case the sound is still playing, so repeated actions can replay it.
    beep.currentTime = 0;
    beep.volume = 0.4;

    // Play on user interaction; browsers may block autoplay otherwise.
    beep.play().catch(err => console.error("Playback failed:", err));
}

function getStoredName() {                                      // This function retrieves the stored username from localStorage. If no username is stored, it returns an empty string. This allows the 
    return localStorage.getItem("prescript_username") || "";    // application to remember the user's name across sessions and use it for personalized greetings and server interactions.
}

function funcUpdateScore(score) { // This function sends a POST request to the server to update the user's grace score. It retrieves the stored username and includes it in the request body along with the new score.
    const name = getStoredName(); // This allows the server to associate the updated score with the correct user profile.
    postForm("/update_score/", `username=${encodeURIComponent(name)}&score=${encodeURIComponent(score)}`);
}

function setStoredName(name) {                          // This function stores the username in localStorage and sends a POST request to the server to update the user's name in their profile. It takes a name parameter,
    localStorage.setItem("prescript_username", name);   // saves it in localStorage under the "prescript_username" key, and then makes a request to the "/update/" endpoint with the new username. After updating, it
    postForm("/update/", `username=${encodeURIComponent(name)}`); // calls updateNameUI() to refresh any UI elements that display the user's name.
    updateNameUI();
}

function updateNameUI() {                     // This function updates various UI elements on the page to reflect the stored username. It retrieves the stored name, trims it, and uses it to personalize greetings, 
    const name = getStoredName().trim();      // headers, and other text elements across the application. If no name is stored, it defaults to "Citizen" for display purposes.
    const displayName = name || "Citizen";

    const userGreeting = document.getElementById("userGreeting");
    if (userGreeting) {
        userGreeting.textContent = `${displayName}'s prescript:`;
    }

    const historyHeader = document.getElementById("historyHeader");
    if (historyHeader) {
        historyHeader.textContent = `${displayName}'s procurations`;
    }

    const mailRecipient = document.getElementById("mailRecipient");
    if (mailRecipient) {
        mailRecipient.textContent = displayName;
    }

    const input = document.getElementById("usernameInput");
    if (input) {
        input.value = name;
    }
}

function stablePickFromSeed(seed, options) {
    // Simple deterministic pseudo-random selection based on a string seed.
    const hash = Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    return options[hash % options.length];
}

function getRoleForGrace(grace) {   // This function determines the user's role based on their grace score. It takes the grace score as input, processes it to ensure it's a number, and then uses a series of thresholds to
    let parsed = grace;             // assign a role with a name, description, and image. The function also uses the stored username as part of the logic for certain roles to create a more personalized experience.
    if (typeof parsed === 'string') {
        const stripped = parsed.replace(/[^0-9\-]/g, '').trim();
        parsed = stripped === '' ? parsed : Number(stripped);
    }

    const n = Number(parsed);
    const name = getStoredName().trim() || "__anon__";

    if (Number.isNaN(n)) {
        return {
            name: "Unknown",
            description: "Unable to determine role.",
            image: "/static/role_placeholder.svg"
        };
    }

    if (n <= -1) {
        return {
            name: "Turncoat",
            description: "Your alignment has tipped away from the City’s movement.",
            image: "/static/role_turncoat.svg"
        };
    }

    if (n <= 50) {
        return {
            name: "Civilian",
            description: "You are still forming your cadence within the City.",
            image: "/static/role_civilian.svg"
        };
    }

    if (n <= 125) {
        return {
            name: "Proselyte",
            description: "You are learning to listen and respond to the City’s rhythms.",
            image: "/static/role_proselyte.svg"
        };
    }

    if (n <= 200) {
        const roleName = stablePickFromSeed(name, ["Proxy", "Messenger"]);
        return {
            name: roleName,
            description: roleName === "Proxy"
                ? "You act as a conduit to move the City’s motion along."
                : "You carry messages through the City’s channels.",
            image: roleName === "Proxy" ? "/static/role_proxy.svg" : "/static/role_messenger.svg"
        };
    }

    return {
        name: "Weaver",
        description: "You shape the pattern the City follows.",
        image: "/static/role_weaver.svg"
    };
}

function updateRoleUI(score) {                  // This function updates the UI elements related to the user's role based on their grace score. It calls getRoleForGrace to determine the current role information, and then updates the role
    const roleInfo = getRoleForGrace(score);    // name, description, image, and score display accordingly. It also manages the visual state of role cards to indicate which roles are unlocked based on the current score.

    const roleScoreEl = document.getElementById("roleScore");
    const roleNameEl = document.getElementById("roleName");
    const roleDescEl = document.getElementById("roleDescription");
    const roleImageEl = document.getElementById("roleImage");

    if (roleScoreEl) {
        roleScoreEl.textContent = String(score);
    }
    if (roleNameEl) {
        roleNameEl.textContent = roleInfo.name;
    }

    console.debug(`updateRoleUI(score=${score}) => role=${roleInfo.name}, n=${String(score)}`);

    if (roleDescEl) {
        roleDescEl.textContent = roleInfo.description;
    }
    if (roleImageEl) {
        roleImageEl.src = roleInfo.image;
        roleImageEl.alt = `${roleInfo.name} icon`;
    }

    const thresholds = {
        Turncoat: -999,
        Civilian: 0,
        Proselyte: 51,
        Proxy: 126,
        Messenger: 126,
        Weaver: 201
    };

    const cards = document.querySelectorAll(".role-card");  // This assumes each role card has a data-role attribute corresponding to the role names used in the thresholds object.
    cards.forEach(card => {
        const role = card.dataset.role;
        const threshold = thresholds[role] ?? Infinity;
        if (score >= threshold) {
            card.classList.add("unlocked");
            card.classList.remove("locked");
            const lockLabel = card.querySelector(".role-card__lock-label");
            if (lockLabel) lockLabel.textContent = "Unlocked";
            if (card.querySelector(".role-card__lock")) {
                card.querySelector(".role-card__lock").style.display = "none";
            }
        } else {
            card.classList.add("locked");
            card.classList.remove("unlocked");
            const lockLabel = card.querySelector(".role-card__lock-label");
            if (lockLabel) lockLabel.textContent = "Locked";
            if (card.querySelector(".role-card__lock")) {
                card.querySelector(".role-card__lock").style.display = "flex";
            }
        }
    });

    cards.forEach(card => card.classList.remove("active"));  // Clear active state from all cards first, then set it on the current role if it exists. This ensures only the current role is highlighted as active.
    const activeCard = document.querySelector(`.role-card[data-role="${roleInfo.name}"]`);
    if (activeCard) {
        activeCard.classList.add("active");
    }
}

function loadHistory() {                     // Fetches this user's persisted history from the server and renders it into #history.
    const historyEl = document.getElementById("history");
    if (!historyEl) return;

    const name = getStoredName().trim();
    postForm("/get_history/", `username=${encodeURIComponent(name)}`)
        .then(response => response.json())
        .then(data => {
            const items = data.history || [];
            historyEl.innerHTML = "";

            if (!name || items.length === 0) {
                const empty = document.createElement("div");
                empty.className = "history-empty";
                empty.textContent = name
                    ? "No history yet — complete or ignore a prescript to start tracking it."
                    : "No history yet — save a name from the menu to start tracking it.";
                historyEl.appendChild(empty);
                return;
            }

            items.forEach(item => {
                const div = document.createElement("div");
                div.className = "history-item";
                const label = item.action === "completed" ? "Completed" : "Ignored";
                div.textContent = `${label} — ${item.text}`;
                historyEl.appendChild(div);
            });
        });
}

function initPage() {                     // This function initializes the page by fetching the user's current grace score and prescript from the server, updating the UI accordingly, and setting up event listeners for user
    const name = getStoredName().trim();  // interactions. It ensures that the user's name and prescript are displayed consistently across sessions by retrieving them from localStorage and updating the UI elements on page load.

    postForm("/get_score/", `username=${encodeURIComponent(name)}`)
        .then(response => response.json())
        .then(data => {
            const scoreValue = Number(data.score);
            const homeGraceEl = document.getElementById("grace");
            if (homeGraceEl) {
                homeGraceEl.innerText = "Grace: " + scoreValue;
            }

            const roleScoreEl = document.getElementById("roleScore");
            if (roleScoreEl) {
                roleScoreEl.textContent = scoreValue;
            }

            // Update role UI only where role elements exist
            const roleElement = document.getElementById("roleName") || document.querySelector(".role-summary");
            if (roleElement) {
                updateRoleUI(scoreValue);
            }
        });
    // Keep name displayed consistently across pages.
    updateNameUI();
    loadHistory();

    // const input = document.getElementById("usernameInput");
    // if (input) {
    //     input.addEventListener("input", (event) => {
    //         setStoredName(event.target.value);
    //     });
    // }

    const btnSave = document.getElementById("btnSave");
    if (btnSave) {
        btnSave.addEventListener("click", () => {
            const input = document.getElementById("usernameInput");
            if (input) {
                setStoredName(input.value);
            }
        });
    }


    if (document.getElementById("inbox")) {
        loadInbox();
        setInterval(loadInbox, INBOX_POLL_MS);
        // Catches a permission/name change made in another tab, or just coming back to a
        // backgrounded tab — cheap enough to just re-check every time the window regains focus.
        window.addEventListener("focus", loadInbox);
    }
}

initPage();
