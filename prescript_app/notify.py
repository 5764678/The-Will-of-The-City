"""Pushes a prescript to your phone as a notification via ntfy.sh (https://ntfy.sh).

ntfy.sh needs no account: install the app, subscribe to a private topic name (your "secret"),
and anything POSTed to https://ntfy.sh/<topic> shows up as a push notification.
"""
import random
import urllib.request

# Rotated randomly so notifications don't all open the same way — keeps the in-universe,
# "mysterious yet specific" tone established across the rest of the app's copy.
NOTIFICATION_TITLES = [
    "PRESCRIPT ISSUED",
    "THE CITY REQUIRES SOMETHING OF YOU",
    "A PRESCRIPT ARRIVES",
    "YOUR ATTENTION IS REQUESTED",
    "MOTION HAS BEEN LOGGED",
    "THIS WAS ALREADY EXPECTED OF YOU",
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
        "Tags": "bell",
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
