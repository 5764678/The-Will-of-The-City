"""Pushes prescripts and outcome confirmations to your phone.

Two delivery paths live here side by side:

- Web Push (send_webpush*) — the primary path. Goes straight to the browser that's subscribed
  (see PushSubscription / push_subscribe in views.py), which on iOS means the site installed to
  the Home Screen as a PWA. No third-party service involved once VAPID keys are configured.
- ntfy.sh (send_ntfy*) — the original path, kept as a fallback for whenever a target username
  has no push subscription on file (hasn't installed/enabled notifications yet), or every send
  attempt to their subscriptions failed. ntfy.sh needs no account: install the app, subscribe to
  a private topic name (your "secret"), and anything POSTed to https://ntfy.sh/<topic> shows up
  as a push notification.

Callers (views.py) decide which path to use per-message — see _maybe_notify / notify_trigger.
"""
import json
import os
import random
import time
import urllib.request

from pywebpush import webpush, WebPushException

# VAPID identifies this server to the browsers' push services (Google/Mozilla/Apple's push
# endpoints) so they can rate-limit and contact the operator about abuse — it's required by the
# Web Push spec, not optional. All three come from the environment, never hardcoded: generate a
# keypair once (see README) and set these on the host. VAPID_CLAIMS_EMAIL is only ever sent to
# the browser vendor's push service as the "sub" contact claim — never anywhere else.
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS_EMAIL = os.environ.get('VAPID_CLAIMS_EMAIL')

# The detailed Index logo (same image used as the app/manifest icon — see icon-192.png in
# generate_icons.py) — shown as the small icon on the notification itself once it lands. Shared
# with NOTIFICATION_ICON_URL below so ntfy and Web Push notifications, and the installed app icon,
# all show the same image.
WEBPUSH_ICON_URL = "https://will-of-the-city.onrender.com/static/icons/icon-192.png"


def _decorated_title(title):
    """Wraps a notification header in the same '.-TEXT-.' decode-terminal framing used for the
    in-page status line (see animateStatus in script.js) — visual consistency between the site
    and what actually lands on your phone. Only applied to titles that already exist (prescript
    arrivals, alarm bursts) — the deliberately title-less outcome confirmations stay title-less."""
    return f".-{title}-."


class WebPushGone(Exception):
    """Raised when a subscription is confirmed dead (browser returned 404/410 — uninstalled,
    permission revoked, or otherwise expired). Callers should delete the PushSubscription row;
    anything else raised from send_webpush is a transient failure and the row should be kept."""


def send_webpush(subscription, title, body, *, icon=None, tag=None, urgent=False,
                  url=None, complete_url=None, ignore_url=None, timeout=15):
    """Sends one Web Push notification to a single PushSubscription (or subscription-info dict).

    Raises WebPushGone if the subscription is confirmed dead (caller should delete it), or
    re-raises WebPushException for any other failure (caller decides whether to fall back).
    """
    if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY):
        raise RuntimeError("VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY are not configured")

    subscription_info = subscription if isinstance(subscription, dict) else {
        "endpoint": subscription.endpoint,
        "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
    }

    payload = {
        "title": title,
        "body": body,
        "icon": icon or WEBPUSH_ICON_URL,
        "badge": icon or WEBPUSH_ICON_URL,
        "tag": tag,
        "url": url or "/home/",
    }
    actions = []
    if complete_url:
        actions.append({"action": "complete", "title": "Complete", "url": complete_url})
    if ignore_url:
        actions.append({"action": "ignore", "title": "Ignore", "url": ignore_url})
    if actions:
        payload["actions"] = actions

    vapid_claims = {"sub": f"mailto:{VAPID_CLAIMS_EMAIL}"} if VAPID_CLAIMS_EMAIL else {}

    try:
        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=vapid_claims,
            ttl=int(timeout) * 60,
            headers={"Urgency": "high" if urgent else "normal"},
        )
    except WebPushException as exc:
        status = getattr(exc.response, "status_code", None)
        if status in (404, 410):
            raise WebPushGone(str(exc)) from exc
        raise

# Public URL of an icon ntfy will fetch and display next to the notification — the same detailed
# Index logo used everywhere else (see WEBPUSH_ICON_URL above). ntfy needs a real reachable URL,
# not a local path, so this has to be the live Render URL rather than localhost (which is why
# it's not configurable via NOTIFY_TRIGGER's request.build_absolute_uri — that'd break for
# local/dev runs of this command).
NOTIFICATION_ICON_URL = "https://will-of-the-city.onrender.com/static/icons/icon-192.png"

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
            "Title": _decorated_title(random.choice(IGNORE_STREAK_TITLES)),
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
    title = _decorated_title(random.choice(NOTIFICATION_TITLES))

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


def send_webpush_alarm_burst(subscription, count, timeout=15):
    """Web Push counterpart of send_ntfy_alarm_burst — same escalating spam-burst behavior, one
    subscription at a time (the caller loops over a username's subscriptions; see views.py)."""
    count = max(1, min(count, 5))
    for _ in range(count):
        send_webpush(
            subscription,
            title=_decorated_title(random.choice(IGNORE_STREAK_TITLES)),
            body=random.choice(IGNORE_STREAK_MESSAGES),
            urgent=True,
            tag=None,  # no tag: each burst message should show as its own notification, not collapse
            timeout=timeout,
        )
        time.sleep(1)  # so they land as distinct beeps, not one bundled/collapsed notification


def send_webpush_prescript(subscription, text, complete_url=None, ignore_url=None, timeout=15):
    """Web Push counterpart of send_ntfy_prescript — same random title, same Complete/Ignore
    tap-to-act actions (rendered as notification action buttons where the browser supports them;
    where it doesn't, e.g. some iOS Safari versions, tapping the notification body still opens
    the site with the same prescript on screen)."""
    send_webpush(
        subscription,
        title=_decorated_title(random.choice(NOTIFICATION_TITLES)),
        body=text,
        tag="prescript",
        complete_url=complete_url,
        ignore_url=ignore_url,
        timeout=timeout,
    )
