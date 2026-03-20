
function animateStatus(message) {                       // This function creates a "decode-style" animation effect for the status message, where random characters are rapidly replaced
    const statusEl = document.getElementById("status"); // by the actual message characters over a short duration. It also plays a sound effect to enhance the experience.

    let symbols = "!@#$%^&*ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
    let current = Array(message.length).fill("");
    playAudio();
    let frame = 0;

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
        }

        setTimeout(() => {
            statusEl.innerText = "";
            statusEl.classList.remove("clear", "failed");
        }, 4000);
    }, 100);
}

function completePrescript() {         // This function is called when the user completes a prescript. It sends a request to the server to process the completion, updates the UI with the new 
    const username = getStoredName();  // grace score and prescript, and triggers the appropriate status animation based on whether the action was successful or not.
    const url = username ? `/complete/?username=${encodeURIComponent(username)}` : "/complete/";

    fetch(url)
        .then(response => response.json())
        .then(data => {
            const graceEl = document.getElementById("grace");
            if (graceEl) {
                graceEl.innerText = "Grace: " + data.grace;
            }
            const roleScoreEl = document.getElementById("roleScore");
            if (roleScoreEl) {
                updateRoleUI(data.grace);
            }
            funcUpdateScore(data.grace);
            setStoredPrescript(data.prescript);
            const prescriptEl = document.getElementById("prescript");
            if (prescriptEl) {
                prescriptEl.dataset.text = data.prescript;
                prescriptEl.textContent = data.prescript;
            }
            decodeText(data.prescript);


            if (data.status === "clear") {
                animateStatus("Clear");
            }

            setTimeout(() => {
                ;
                // location.reload();
            }, 2500);
        });
}

function ignorePrescript() {           // This function is called when the user chooses to ignore a prescript. It sends a request to the server to process the ignore action, updates the UI with the 
    const username = getStoredName();  // new grace score and prescript, and triggers a "Failed" status animation since ignoring is considered a failure in terms of grace.
    const url = username ? `/ignore/?username=${encodeURIComponent(username)}` : "/ignore/";

    fetch(url)
        .then(response => response.json())
        .then(data => {
            const graceEl = document.getElementById("grace");
            if (graceEl) {
                graceEl.innerText = "Grace: " + data.grace;
            }
            const roleScoreEl = document.getElementById("roleScore");
            if (roleScoreEl) {
                updateRoleUI(data.grace);
            }
            funcUpdateScore(data.grace);
            setStoredPrescript(data.prescript);
            const prescriptEl = document.getElementById("prescript");
            if (prescriptEl) {
                prescriptEl.dataset.text = data.prescript;
                prescriptEl.textContent = data.prescript;
            }
            decodeText(data.prescript);

            if (data.status === "failed") {
                animateStatus("Failed");
            }

            setTimeout(() => {
                ;
            }, 2500);
        });
}


function decodeText(newText) { // This function creates a "decode-style" animation effect for the prescript text, where random characters are rapidly replaced by the actual message characters over a short 
                               // duration. It also plays a sound effect to enhance the experience. The function takes an optional newText parameter, which allows it to be called with a specific text to decode, or it can fallback to using the existing data-text attribute of the prescript element.
    const line = document.getElementById("prescript");

    // Fallback to existing data-text (if provided) and guarantee immediate display.
    const target = newText || (line && line.dataset && line.dataset.text) || "";
    if (line) {
        line.dataset.text = target;
        line.textContent = target; // ensure initial text is visible instantly
    }

    if (!target) return;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";
    let revealed = Array(target.length).fill(false);

    function decode() {
        const beep = document.getElementById("beep");
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

        line.textContent = output;
        if (revealed.includes(false)) {
            setTimeout(decode, 30);
        } else {
            line.textContent = target;
        }
    }

    decode();
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

function getStoredPrescript() {                             // This function retrieves the stored prescript text from localStorage. If no prescript is stored, it returns an empty string. This allows 
    return localStorage.getItem("prescript_text") || "";    // the application to remember the last prescript across sessions and display it when the user returns to the page.
}

function setStoredPrescript(text) {                        // This function stores the prescript text in localStorage. It takes a text parameter and sets it as the value for the "prescript_text" key.
    localStorage.setItem("prescript_text", text);          // This allows the application to remember the last prescript across sessions and display it when the user returns to the page.
}

function funcUpdateScore(score) { // This function sends a POST request to the server to update the user's grace score. It retrieves the stored username and includes it in the request body along with the new score. 
    const name = getStoredName(); // This allows the server to associate the updated score with the correct user profile.
    fetch("/update_score/", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `username=${encodeURIComponent(name)}&score=${encodeURIComponent(score)}`
    })
}

function setStoredName(name) {                          // This function stores the username in localStorage and sends a POST request to the server to update the user's name in their profile. It takes a name parameter, 
    localStorage.setItem("prescript_username", name);   // saves it in localStorage under the "prescript_username" key, and then makes a request to the "/update/" endpoint with the new username. After updating, it 
    fetch("/update/", {                                 // calls updateNameUI() to refresh any UI elements that display the user's name.
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `username=${encodeURIComponent(name)}`
    });
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
            image: "/static/turncoat_image.webp"
        };
    }

    if (n <= 50) {
        return {
            name: "Civilian",
            description: "You are still forming your cadence within the City.",
            image: "/static/civilian_image.webp"
        };
    }

    if (n <= 125) {
        return {
            name: "Proselyte",
            description: "You are learning to listen and respond to the City’s rhythms.",
            image: "/static/proselyte_image.webp"
        };
    }

    if (n <= 200) {
        const roleName = stablePickFromSeed(name, ["Proxy", "Messenger"]);
        return {
            name: roleName,
            description: roleName === "Proxy"
                ? "You act as a conduit to move the City’s motion along."
                : "You carry messages through the City’s channels.",
            image: roleName === "Proxy" ? "/static/proxy_image.webp" : "/static/messenger_image.webp"
        };
    }

    return {
        name: "Weaver",
        description: "You shape the pattern the City follows.",
        image: "/static/weaver_image.webp"
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

function initPage() {                     // This function initializes the page by fetching the user's current grace score and prescript from the server, updating the UI accordingly, and setting up event listeners for user 
    const name = getStoredName().trim();  // interactions. It ensures that the user's name and prescript are displayed consistently across sessions by retrieving them from localStorage and updating the UI elements on page load.

    fetch("/get_score/", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `username=${encodeURIComponent(name)}`
    }).then(response => response.json())
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


    const prescriptEl = document.getElementById("prescript");
    const persistedPrescript = getStoredPrescript().trim();

    if (prescriptEl) {
        if (persistedPrescript) {
            prescriptEl.dataset.text = persistedPrescript;
            prescriptEl.textContent = persistedPrescript;
            // Keep animation behavior on load if desired.
            decodeText(persistedPrescript);
        } else {
            // initialize with server-provided text so it is not replaced immediately.
            const initial = prescriptEl.dataset.text || "";
            if (initial) {
                setStoredPrescript(initial);
                decodeText(initial);
            }
        }
    }
}

initPage();
