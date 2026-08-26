"""Pushes a prescript to your phone as a notification via ntfy.sh (https://ntfy.sh).

ntfy.sh needs no account: install the app, subscribe to a private topic name (your "secret"),
and anything POSTed to https://ntfy.sh/<topic> shows up as a push notification.
"""
import random
import urllib.request

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
