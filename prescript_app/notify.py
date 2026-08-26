"""Pushes prescripts and outcome confirmations to your phone via ntfy.sh (https://ntfy.sh).

ntfy.sh needs no account: install the app, subscribe to a private topic name (your "secret"),
and anything POSTed to https://ntfy.sh/<topic> shows up as a push notification.
"""
import random
import time
import urllib.request

# Public URL of an icon ntfy will fetch and display next to the notification. Points at the
# deployed site's own static file — ntfy needs a real reachable URL, not a local path, so this
# has to be the live Render URL rather than localhost (which is why it's not configurable via
# NOTIFY_TRIGGER's request.build_absolute_uri — that'd break for local/dev runs of this command).
NOTIFICATION_ICON_URL = "https://will-of-the-city.onrender.com/static/notify_icon.png"

# Rotated randomly so notifications don't all open the same way. Kept flat and indifferent —
# not urgent or demanding — to match the cold, procedural voice used everywhere else in the
# app's copy (see the About page: it doesn't ask, it just states).
NOTIFICATION_TITLES = [
    "PRESCRIPT ISSUED",
    "A PRESCRIPT ARRIVES",
    "NOTED.",
    "RECORDED.",
    "MOTION LOGGED.",
    "THIS WAS ALREADY EXPECTED.",
    "ACCOUNTED FOR.",
]

# Sent back as a follow-up push the moment you tap Complete on a notification. Title-less on
# purpose (see send_ntfy_message) — a short, undecorated line reads as an outcome, not a new task.
COMPLETE_CONFIRMATIONS = [
    "The City is content, for now.",
    "Recorded without objection.",
    "This one aligned. Nothing more is owed.",
    "Filed as completed. The distance narrows slightly.",
    "Noted. The pattern holds.",
    "Acknowledged. Continue as before.",
    "The motion was accepted.",
    "This resolved the way it was meant to.",
]

# Sent back the moment you tap Ignore on a notification.
IGNORE_CONFIRMATIONS = [
    "Filed as ignored. The distance widens slightly.",
    "Noted. Nothing further will be said about it.",
    "This one will not be revisited.",
    "The City does not insist twice.",
    "Recorded as refusal. No explanation required.",
    "This was allowed to pass. Not forgiven — allowed.",
    "The gap remains, unremarked upon.",
    "The pattern continues without you, this time.",
]

# Sent when a prescript's time limit runs out with no response at all — auto-filed as ignored.
EXPIRED_MESSAGES = [
    "This one went unanswered. Filed as ignored.",
    "The window closed on its own. Recorded as refusal.",
    "No response arrived in time. The City assumed one anyway.",
    "Unattended. Logged as ignored, as expected.",
    "The moment passed without you. That, too, is on record.",
    "Silence was taken as an answer.",
]

# Sent if you tap Complete/Ignore after it already expired and was auto-filed — so the tap isn't
# silently swallowed with no feedback at all.
EXPIRED_TAP_MESSAGES = [
    "Too late. This one was already filed as ignored.",
    "This moment has already closed.",
    "The window for this one is gone. Wait for the next.",
    "Already recorded, without your input.",
    "That one is finished. Nothing changes now.",
]

# Fired in a burst (see send_ntfy_alarm_burst) once a prescript's been ignored several times in
# a row — a deliberate escalation, roleplaying the City losing patience with repeated refusal.
IGNORE_STREAK_TITLES = [
    "DEVIATION",
    "PATTERN BREAK",
    "UNRESOLVED",
    "RESPONSE OVERDUE",
    "THIS CANNOT CONTINUE",
]

IGNORE_STREAK_MESSAGES = [
    "The pattern has broken again.",
    "This will not stop asking.",
    "The City does not forget refusal.",
    "Deviation is being logged at an increasing rate.",
    "Something is accumulating. It has not been named yet.",
    "Continued refusal does not go unrecorded.",
    "The distance is no longer small.",
    "This has happened too many times to be incidental.",
]

# Sent once, the next time you Complete something after a bad streak — the alarm stops as
# abruptly as it started.
STREAK_RESOLUTION_MESSAGES = [
    "The pattern breaks. For now, that is enough.",
    "Noted. The volume, for now, returns to silence.",
    "The sequence ends here. Nothing more is asked of this moment.",
    "Recorded. Whatever was accumulating has been set down.",
]


def send_ntfy_message(topic, message, title=None, timeout=15):
    """POST a plain text push notification to an ntfy.sh topic.

    Used for outcome confirmations (Complete/Ignore/expired) rather than a new prescript —
    left title-less by default so it visually reads as a short reply, not a new task arriving.
    """
    headers = {"Priority": "default"}
    if title:
        headers["Title"] = title
    if NOTIFICATION_ICON_URL:
        headers["Icon"] = NOTIFICATION_ICON_URL

    req = urllib.request.Request(
        f"https://ntfy.sh/{topic}",
        data=message.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status


def send_ntfy_alarm_burst(topic, count, timeout=15):
    """Sends `count` back-to-back urgent-priority pushes, one after another — a deliberate
    'the City is losing patience' spam burst, each with its own title/message and its own beep.

    Capped at 5 regardless of `count` so a very long ignore streak doesn't turn into truly
    unbounded real spam.
    """
    count = max(1, min(count, 5))
    for _ in range(count):
        headers = {
            "Title": random.choice(IGNORE_STREAK_TITLES),
            "Priority": "urgent",
        }
        if NOTIFICATION_ICON_URL:
            headers["Icon"] = NOTIFICATION_ICON_URL

        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            data=random.choice(IGNORE_STREAK_MESSAGES).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        urllib.request.urlopen(req, timeout=timeout)
        time.sleep(1)  # so they land as distinct beeps, not one bundled/collapsed notification


def send_ntfy_prescript(topic, text, complete_url=None, ignore_url=None, timeout=15):
    """POST a prescript to an ntfy.sh topic as a phone push notification.

    If complete_url/ignore_url are given, attaches tap-to-act notification action buttons
    (ntfy's "Actions" header) so Complete/Ignore can be done straight from the notification,
    without opening the site.
    """
    title = random.choice(NOTIFICATION_TITLES)

    headers = {
        "Title": title,
        "Priority": "default",
    }
    if NOTIFICATION_ICON_URL:
        headers["Icon"] = NOTIFICATION_ICON_URL

    actions = []
    if complete_url:
        actions.append(f"http, Complete, {complete_url}, method=GET, clear=true")
    if ignore_url:
        actions.append(f"http, Ignore, {ignore_url}, method=GET, clear=true")
    if actions:
        headers["Actions"] = "; ".join(actions)

    req = urllib.request.Request(
        f"https://ntfy.sh/{topic}",
        data=text.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status
