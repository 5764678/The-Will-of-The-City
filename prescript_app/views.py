import datetime
import json
import os
import random
from urllib.parse import quote
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core import signing
from django.http import HttpResponse, HttpResponseNotFound, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_POST
from django.utils.decorators import method_decorator
from django.views.generic import TemplateView

from prescript_app.models import UserProfile, PrescriptHistory, PendingNotification, PushSubscription
from .prescripts import generate_prescript
from . import grace as grace_module
from . import notify as notify_module
from .notify import (
    send_ntfy_alarm_burst,
    send_ntfy_message,
    send_ntfy_prescript,
    send_webpush_alarm_burst,
    send_webpush_prescript,
    WebPushGone,
    COMPLETE_CONFIRMATIONS,
    IGNORE_CONFIRMATIONS,
    EXPIRED_MESSAGES,
    EXPIRED_TAP_MESSAGES,
    STREAK_RESOLUTION_MESSAGES,
)

# How long a notification's prescript stays actionable. Tap Complete/Ignore within this window
# and it scores normally; let it run out and the next scheduled trigger auto-files it as ignored
# (see _expire_stale_pending). Comfortably above the 30-minute sweep interval so a normal delay
# in noticing your phone doesn't cost you anything.
PRESCRIPT_TIME_LIMIT = datetime.timedelta(minutes=40)

# Ignore 3 in a row (however they get ignored — an explicit tap or an unanswered timeout, both
# count) and the alarm burst kicks in. Each ignore beyond that sends one more message in the
# burst than the last, capped at 5 (see send_ntfy_alarm_burst).
IGNORE_SPAM_THRESHOLD = 3

# Indochina Time — fixed UTC+7 year-round, no DST to account for.
NOTIFY_TZ = ZoneInfo("Asia/Bangkok")

# Scheduled notification times (local, UTC+7) and the window of minutes-since-midnight around
# each one that should get that context's themed trigger pool (see context_triggers in
# prescripts.py). Anything outside every window (i.e. the ambient 30-minute sweep in between)
# falls through to the default, unthemed trigger pool — same as every prescript generated
# through the website itself. Widened a bit past the exact minute to absorb scheduler drift
# (GitHub Actions cron isn't guaranteed to fire on the exact minute).
NOTIFY_CONTEXT_WINDOWS = [
    ('morning', 6 * 60 + 30, 8 * 60),            # ~06:30-08:00 -> 07:00 anchor
    ('post_class', 9 * 60 + 35, 10 * 60 + 5),    # ~09:35-10:05 -> 09:50 anchor (just finished uni)
    ('lunch', 11 * 60 + 15, 11 * 60 + 50),       # ~11:15-11:50 -> 11:30 anchor
    ('afternoon_break', 13 * 60 + 55, 14 * 60 + 30),  # ~13:55-14:30 -> 14:10 anchor
    ('dismissed', 15 * 60 + 45, 16 * 60 + 15),   # ~15:45-16:15 -> 16:00 anchor
    ('night', 19 * 60 + 30, 20 * 60 + 30),       # ~19:30-20:30 -> 20:00 anchor
]


def _current_notify_context():
    """Which themed context (if any) the current local time falls into."""
    local_now = timezone.now().astimezone(NOTIFY_TZ)
    minutes = local_now.hour * 60 + local_now.minute
    for name, start, end in NOTIFY_CONTEXT_WINDOWS:
        if start <= minutes <= end:
            return name
    return None

SESSION_KEY = 'current_prescript'  # Holds {'text', 'reward', 'punishment'} for the prescript currently on screen.
                                    # Stored per-session (instead of as module globals) so two visitors hitting the
                                    # site at the same time don't overwrite each other's in-progress prescript.


def _get_current(request):
    """Return the prescript currently shown to this session, generating one if none exists yet."""
    current = request.session.get(SESSION_KEY)
    if not current:
        text, reward, punishment = generate_prescript()
        current = {'text': text, 'reward': reward, 'punishment': punishment}
        request.session[SESSION_KEY] = current
    return current


def _set_current(request, text, reward, punishment):
    request.session[SESSION_KEY] = {'text': text, 'reward': reward, 'punishment': punishment}


def _resolve_current(request):
    """Figure out which prescript is being acted on, and where it came from.

    Normally that's whatever's tracked in the session for this browser (_get_current) — source
    'session'. But a tap on a Complete/Ignore button inside a phone push notification arrives as
    a plain, session-less HTTP request. For that case the notification's action URL carries a
    `p` token (see notify_trigger) signed with django.core.signing — source 'token' if it's still
    within its time limit, or 'expired_token' if you tapped after PRESCRIPT_TIME_LIMIT ran out
    (in which case it was likely already auto-filed as ignored by the next sweep — see
    _expire_stale_pending — so nothing here should be scored again).

    Returns (text, reward, punishment, source, token).
    """
    token = request.GET.get('p') or request.POST.get('p')
    if token:
        try:
            data = signing.loads(token, max_age=PRESCRIPT_TIME_LIMIT.total_seconds())
            return data['text'], data['reward'], data['punishment'], 'token', token
        except signing.SignatureExpired:
            return None, None, None, 'expired_token', token
        except signing.BadSignature:
            pass  # malformed/tampered — fall through to the normal session-based prescript

    current = _get_current(request)
    return current['text'], current['reward'], current['punishment'], 'session', None


ANON_GRACE_SESSION_KEY = 'anon_grace'  # Grace for visitors who haven't saved a name — isolated per browser
                                        # session instead of one value shared by literally everyone (see grace.py).


def _get_anon_grace(request):
    return request.session.get(ANON_GRACE_SESSION_KEY, 0)


def _set_anon_grace(request, value):
    request.session[ANON_GRACE_SESSION_KEY] = value


def _webpush_subscriptions_for(username):
    if not username:
        return []
    return list(PushSubscription.objects.filter(username=username))


def _send_webpush_to_all(username, send_one, *args, **kwargs):
    """Calls send_one(subscription, *args, **kwargs) for every subscription this username has.

    send_one is one of the send_webpush_* helpers in notify.py. A subscription that comes back
    confirmed dead (WebPushGone — uninstalled, permission revoked) is deleted so it stops being
    tried again; any other failure just leaves that one subscription's send unsuccessful.

    Returns True if at least one subscription was actually reached, so the caller knows whether
    it still needs to fall back to ntfy.
    """
    subs = _webpush_subscriptions_for(username)
    sent_any = False
    for sub in subs:
        try:
            send_one(sub, *args, **kwargs)
            sent_any = True
        except WebPushGone:
            sub.delete()
        except Exception:
            pass
    return sent_any


def _maybe_notify(message, username=None, title=None):
    """Best-effort push of a short outcome message.

    Web Push is tried first (if `username` has any subscriptions on file). ntfy.sh is used as a
    fallback — either because `username` has no subscription yet, or the push attempt(s) failed
    outright — as long as NTFY_TOPIC is configured. Never raises: a notification hiccup shouldn't
    break scoring, which already happened by this point.
    """
    if username:
        try:
            if _send_webpush_to_all(username, notify_module.send_webpush, title or "", message):
                return
        except Exception:
            pass

    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return
    try:
        send_ntfy_message(topic, message, title=title)
    except Exception:
        pass


def _claim_pending_or_reject(token):
    """Atomically claim a notification's PendingNotification row so it can be scored at most
    once, no matter how many times Complete/Ignore gets tapped on it.

    Must run BEFORE any grace/history changes — this used to happen after scoring, which meant
    a second tap on the same still-valid token (within its 40-minute window) scored it again.

    Returns True if it's safe to proceed with scoring, False if this token was already used
    (caller should bail out without touching grace/history at all). If no PendingNotification
    row exists for this token at all (e.g. NOTIFY_USERNAME wasn't configured when it was sent,
    so nothing was ever tracked), there's nothing to enforce — treat it as safe to proceed.
    """
    if not PendingNotification.objects.filter(token=token).exists():
        return True
    claimed = PendingNotification.objects.filter(token=token, resolved=False).update(resolved=True)
    return claimed > 0


@method_decorator(ensure_csrf_cookie, name='dispatch')
class home(TemplateView): # This class defines the view for the home page — an inbox of pending prescripts (see get_inbox/request_prescript) rather than
    # a single current one. The page itself just renders the shell; script.js's loadInbox() populates #inbox client-side, scoped to the saved username,
    # the same way get_history/get_score already work. get_context_data only needs to supply the anonymous/global grace fallback for the initial paint —
    # script.js immediately overwrites it once it knows the real username (see initPage).
    template_name = 'index.html'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['grace'] = _get_anon_grace(self.request)
        return context


@method_decorator(ensure_csrf_cookie, name='dispatch')
class historyView(TemplateView): # This class defines the view for the history page. History is now fetched client-side (see get_history / script.js) so it can be scoped to the current username instead of showing one shared list to every visitor.
    template_name = 'history.html'


@method_decorator(ensure_csrf_cookie, name='dispatch')
class menuView(TemplateView): # This class defines the view for the menu page of the application, which provides navigation links to different sections of the app such as the home page, role page, history page, and about page. It inherits from TemplateView and specifies 'menu.html' as the template to render. The get_context_data method is overridden to include a list of menu links in the context passed to the template for rendering.
    template_name = 'menu.html'

    def get_context_data(self, **kwargs): # This method prepares the context data for the menu page. It creates a list of dictionaries representing the menu links, where each dictionary contains a 'label' for the link text and a 'url' for the link destination. This list is added to the context dictionary that will be used in the template, allowing the template to dynamically generate the navigation menu based on this context data.
        context = super().get_context_data(**kwargs)
        context['menu_links'] = [
            {'label': "Prescript's", 'url': '/home/'},
            {'label': 'Role', 'url': '/role/'},
            {'label': 'History', 'url': '/history/'},
            {'label': 'About', 'url': '/about/'},
            # Add additional menu entries here as you add new pages
        ]
        return context


class aboutView(TemplateView): # This class defines the view for the about page of the application, which provides information about the app and its purpose. It inherits from TemplateView and specifies 'about_us.html' as the template to render. The get_context_data method is overridden to include a description of the application in the context passed to the template for rendering.
    template_name = 'about_us.html'

@method_decorator(ensure_csrf_cookie, name='dispatch')
class roleView(TemplateView): # This class defines the view for the role page of the application, which displays the user's current role based on their grace score. It inherits from TemplateView and specifies 'role.html' as the template to render. The get_context_data method is overridden to include the user's current grace score in the context passed to the template, allowing the template to determine and display the appropriate role information based on that score.
    template_name = 'role.html'

    def get_context_data(self, **kwargs): # This method prepares the context data for the role page. It retrieves the current grace score (this visitor's own session-scoped value if anonymous, see _get_anon_grace) and adds it to the context dictionary that will be used in the template. This allows the template to determine the user's current role based on their grace score and display the relevant information accordingly.
        context = super().get_context_data(**kwargs)
        context['grace'] = _get_anon_grace(self.request)
        return context


def _record_history(username, text, action):
    if not username:
        return
    profile, _ = UserProfile.objects.get_or_create(name=username)
    PrescriptHistory.objects.create(user=profile, text=text, action=action)


def _current_ignore_streak(profile):
    """How many of this user's most recent history entries, counting back from the newest, are
    consecutive Ignores. Stops at the first Completed (or at the start of history)."""
    streak = 0
    for h in profile.history.all():  # already ordered newest-first (PrescriptHistory.Meta)
        if h.action == PrescriptHistory.IGNORED:
            streak += 1
        else:
            break
    return streak


def _maybe_trigger_ignore_alarm(profile, username=None):
    """Call right after recording an Ignore (explicit tap or auto-expired timeout — both count
    the same). Fires an escalating alarm burst once the streak crosses IGNORE_SPAM_THRESHOLD."""
    if not profile:
        return
    streak = _current_ignore_streak(profile)
    if streak < IGNORE_SPAM_THRESHOLD:
        return
    burst_size = streak - IGNORE_SPAM_THRESHOLD + 1

    sent = False
    if username:
        try:
            sent = _send_webpush_to_all(username, send_webpush_alarm_burst, burst_size)
        except Exception:
            sent = False

    if sent:
        return
    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return
    try:
        send_ntfy_alarm_burst(topic, burst_size)
    except Exception:
        pass


def _maybe_send_streak_resolution(profile, username=None):
    """Call right before recording a Complete — if there was an active bad streak going into
    it, send a one-off message acknowledging it broke. Reads history from *before* this
    Complete is recorded, so call this first."""
    if not profile:
        return
    if _current_ignore_streak(profile) >= IGNORE_SPAM_THRESHOLD:
        _maybe_notify(random.choice(STREAK_RESOLUTION_MESSAGES), username=username)


def complete(request): # This function handles the completion of a prescript task by the user. It updates the user's grace score based on the reward for completing the task, records the action in the history, and generates a new prescript for the next task. The function also manages user profiles and updates the database accordingly if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment, source, token = _resolve_current(request)
    username = request.GET.get('username') or request.POST.get('username')

    if source == 'expired_token':
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES), username=username)
        return JsonResponse({'status': 'expired'}, status=410)

    if source == 'token' and not _claim_pending_or_reject(token):
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES), username=username)
        return JsonResponse({'status': 'already_handled'}, status=409)

    base_grace = _get_anon_grace(request)

    profile = None
    if username:
        profile, _ = UserProfile.objects.get_or_create(name=username)
        base_grace = profile.grace if profile.grace is not None else 0

    new_grace = grace_module.update_grace(True, current_reward, current_punishment, base_grace)

    if profile:
        profile.grace = new_grace
        profile.total_rewards += 1  # count of completions, not a mirror of the grace score
        profile.save()
    else:
        _set_anon_grace(request, new_grace)

    _maybe_send_streak_resolution(profile, username=username)  # check before recording, so it sees the streak that's about to break
    _record_history(username, current_text, PrescriptHistory.COMPLETED)

    if source == 'token':
        _maybe_notify(random.choice(COMPLETE_CONFIRMATIONS), username=username)

    text, reward, punishment = generate_prescript()
    _set_current(request, text, reward, punishment)

    return JsonResponse({
        'grace': new_grace,
        'status': "clear",
        'prescript': text
    })


def ignore(request): # This function handles the case when a user chooses to ignore a prescript task. It updates the user's grace score based on the punishment for ignoring the task, records the action in the history, and generates a new prescript for the next task. Similar to the complete function, it manages user profiles and updates the database if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment, source, token = _resolve_current(request)
    username = request.GET.get('username') or request.POST.get('username')

    if source == 'expired_token':
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES), username=username)
        return JsonResponse({'status': 'expired'}, status=410)

    if source == 'token' and not _claim_pending_or_reject(token):
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES), username=username)
        return JsonResponse({'status': 'already_handled'}, status=409)

    base_grace = _get_anon_grace(request)

    profile = None
    if username:
        profile, _ = UserProfile.objects.get_or_create(name=username)
        base_grace = profile.grace if profile.grace is not None else 0

    new_grace = grace_module.update_grace(False, current_reward, current_punishment, base_grace)

    if profile:
        profile.grace = new_grace
        profile.total_punishments += 1
        profile.save()
    else:
        _set_anon_grace(request, new_grace)

    _record_history(username, current_text, PrescriptHistory.IGNORED)
    _maybe_trigger_ignore_alarm(profile, username=username)

    if source == 'token':
        _maybe_notify(random.choice(IGNORE_CONFIRMATIONS), username=username)

    text, reward, punishment = generate_prescript()
    _set_current(request, text, reward, punishment)

    return JsonResponse({
        'grace': new_grace,
        'status': "failed",
        'prescript': text
    })

def update(request): # This function is designed to handle updates to the user's profile, such as creating a new user profile if a username is provided in the request. It checks for the presence of a username in the POST data, and if it exists, it either retrieves the existing user profile or creates a new one in the database. The function then returns a JsonResponse indicating the success of the operation. This allows the application to manage user profiles and ensure that each user has an associated profile in the database.
    if request.method == "POST":
        username = request.POST.get('username')
        if username:
            UserProfile.objects.get_or_create(name=username)
    return JsonResponse({
        'status': 'success'
    })

def update_score(request): # This function is responsible for updating the user's score based on the provided username and score in the POST request. It checks if the username and score are present, and if so, it retrieves or creates a user profile for that username. The function then updates the user's grace score in the database with the new score value. Finally, it returns a JsonResponse indicating the success of the operation along with the updated score.
    score = 0
    if request.method == "POST":
        username = request.POST.get('username')
        score = request.POST.get('score')
        if username and score is not None:
            try:
                user_profile, _ = UserProfile.objects.get_or_create(name=username)
                user_profile.grace = int(score)
                user_profile.save()
            except ValueError:
                pass
    return JsonResponse({
        'status': 'success',
        'score': score
    })

def get_score(request): # This function retrieves the current score for a given username. It checks if a username is provided in the POST request, and if so, it attempts to retrieve the corresponding user profile from the database. If the user profile exists, it returns that user's grace score. If the user does not exist or no username is given, it falls back to this visitor's own session-scoped grace (see _get_anon_grace) rather than one value shared by every anonymous visitor. The function then returns a JsonResponse containing the status and the retrieved score.
    score = _get_anon_grace(request)
    if request.method == "POST":
        username = request.POST.get('username')
        if username:
            try:
                user_profile = UserProfile.objects.get(name=username)
                score = user_profile.grace
            except UserProfile.DoesNotExist:
                score = _get_anon_grace(request)

    return JsonResponse({
        'status': 'success',
        'score': score
    })


def get_history(request): # Returns this username's persisted prescript history as JSON, newest first. Replaces the old server-rendered global `history` list, which was shared by every visitor and lost on every restart.
    username = request.GET.get('username') or request.POST.get('username')
    items = []
    if username:
        try:
            profile = UserProfile.objects.get(name=username)
            items = [
                {
                    'text': h.text,
                    'action': h.action,
                    'created_at': h.created_at.isoformat(),
                }
                for h in profile.history.all()[:100]
            ]
        except UserProfile.DoesNotExist:
            items = []

    return JsonResponse({
        'status': 'success',
        'history': items,
    })


def get_inbox(request): # Returns this username's still-unresolved prescripts (see PendingNotification) newest first — the home page's inbox list.
    # Covers both scheduled pushes (notify_trigger) and self-requested ones (request_prescript) — both create the same kind of row, so they show up
    # side by side. Polled periodically by script.js (loadInbox) so a scheduled push that arrives while the page is open appears without a reload.
    username = request.GET.get('username') or request.POST.get('username')
    items = []
    if username:
        rows = PendingNotification.objects.filter(username=username, resolved=False).order_by('-sent_at')[:50]
        items = [
            {'token': r.token, 'text': r.text, 'sent_at': r.sent_at.isoformat()}
            for r in rows
        ]

    return JsonResponse({
        'status': 'success',
        'inbox': items,
    })


def request_prescript(request): # Generates a prescript on demand (the inbox's "Request Prescript" button) instead of waiting for the next scheduled
    # push. Creates the same kind of PendingNotification row notify_trigger does — same signed token, same 40-minute time limit, same auto-expiry sweep
    # — so it's indistinguishable from a scheduled one once it's in the inbox. No push is sent; the caller is already looking at the page.
    if request.method != "POST":
        return JsonResponse({'status': 'error', 'detail': 'POST required'}, status=405)

    username = (request.POST.get('username') or '').strip()
    if not username:
        return JsonResponse({'status': 'error', 'detail': 'username is required'}, status=400)

    text, reward, punishment = generate_prescript()
    token = signing.dumps({'text': text, 'reward': reward, 'punishment': punishment})

    pending = PendingNotification.objects.create(
        username=username, text=text, reward=reward, punishment=punishment, token=token,
    )

    return JsonResponse({
        'status': 'success',
        'item': {'token': pending.token, 'text': pending.text, 'sent_at': pending.sent_at.isoformat()},
    })


def _expire_stale_pending(username):
    """Auto-file any prescript that's been sent to `username` and left unanswered past
    PRESCRIPT_TIME_LIMIT as ignored — same scoring path as tapping Ignore, plus a push telling
    you it happened. Runs at the top of every notify_trigger call."""
    if not username:
        return

    cutoff = timezone.now() - PRESCRIPT_TIME_LIMIT
    stale = PendingNotification.objects.filter(username=username, resolved=False, sent_at__lt=cutoff)

    for pending in stale:
        profile, _ = UserProfile.objects.get_or_create(name=username)
        base_grace = profile.grace if profile.grace is not None else 0
        new_grace = grace_module.update_grace(False, pending.reward, pending.punishment, base_grace)
        profile.grace = new_grace
        profile.total_punishments += 1
        profile.save()

        PrescriptHistory.objects.create(user=profile, text=pending.text, action=PrescriptHistory.IGNORED)

        pending.resolved = True
        pending.save()

        _maybe_notify(random.choice(EXPIRED_MESSAGES), username=username)
        _maybe_trigger_ignore_alarm(profile, username=username)


def _scheduled_recipients():
    """Every username that should get an automatic prescript on this sweep: anyone who's ever
    enabled Web Push (has a PushSubscription row — that's the opt-in signal, no separate flag
    needed), plus NOTIFY_USERNAME even without one. That legacy env var isn't "the one target"
    any more — it's kept only so the original single-user ntfy fallback keeps working for its
    original owner, since nobody else has an ntfy topic configured.

    Returns (usernames: set[str], legacy_username: str).
    """
    usernames = set(
        u for u in PushSubscription.objects.values_list('username', flat=True).distinct() if u
    )
    legacy_username = os.environ.get('NOTIFY_USERNAME', '').strip()
    if legacy_username:
        usernames.add(legacy_username)
    return usernames, legacy_username


def _send_scheduled_prescript(base_url, username, context, allow_ntfy):
    """Generates and delivers one automatic prescript to one username — the per-recipient body of
    notify_trigger, pulled out so one sweep can independently serve every subscribed username
    (own random text, own grace/history/ignore-streak, own delivery outcome) instead of the single
    hardcoded NOTIFY_USERNAME the site used to be limited to.

    allow_ntfy gates the ntfy.sh fallback to just the legacy NOTIFY_USERNAME (see
    _scheduled_recipients) — everyone else is Web-Push-only.
    """
    _expire_stale_pending(username)

    text, reward, punishment = generate_prescript(context=context)
    token = signing.dumps({'text': text, 'reward': reward, 'punishment': punishment})

    username_qs = f"&username={quote(username)}"
    complete_url = f"{base_url}/complete/?p={token}{username_qs}"
    ignore_url = f"{base_url}/ignore/?p={token}{username_qs}"

    PendingNotification.objects.create(
        username=username, text=text, reward=reward, punishment=punishment, token=token,
    )

    sent = False
    try:
        sent = _send_webpush_to_all(
            username, send_webpush_prescript, text,
            complete_url=complete_url, ignore_url=ignore_url,
        )
    except Exception:
        sent = False

    if not sent and allow_ntfy:
        topic = os.environ.get('NTFY_TOPIC')
        if topic:
            try:
                send_ntfy_prescript(topic, text, complete_url=complete_url, ignore_url=ignore_url)
                sent = True
            except Exception:
                sent = False

    return {'username': username, 'status': 'sent' if sent else 'failed'}


def notify_trigger(request):
    """Generates and delivers one automatic prescript to every subscribed recipient (see
    _scheduled_recipients) — every username with an active Web Push subscription, plus the legacy
    NOTIFY_USERNAME/ntfy fallback for its original owner. Each recipient gets their own
    independently generated prescript, scored against their own grace/history/streak — this isn't
    a broadcast, everyone's Complete/Ignore is entirely their own.

    Meant to be called by an external scheduler (see .github/workflows/prescript-notify.yml) at
    fixed times of day, not by the browser — so it's authenticated with a shared secret header
    instead of CSRF/session, and works even while nobody has the site open.

    Configure via environment variables on the host:
      NOTIFY_TRIGGER_SECRET  required — must match the X-Notify-Secret header the caller sends
      NOTIFY_USERNAME        optional legacy fallback — see _scheduled_recipients
      NTFY_TOPIC             optional — ntfy.sh fallback topic, only ever used for NOTIFY_USERNAME
      VAPID_PUBLIC_KEY/
      VAPID_PRIVATE_KEY      required for Web Push — see README for how to generate a pair
    """
    secret = os.environ.get('NOTIFY_TRIGGER_SECRET')
    if not secret or request.headers.get('X-Notify-Secret') != secret:
        return JsonResponse({'status': 'forbidden'}, status=403)

    usernames, legacy_username = _scheduled_recipients()
    if not usernames:
        return JsonResponse({
            'status': 'error',
            'detail': 'No recipients: nobody has an active Web Push subscription, and NOTIFY_USERNAME is not set',
        }, status=500)

    base_url = request.build_absolute_uri('/').rstrip('/')
    context = _current_notify_context()

    results = [
        _send_scheduled_prescript(base_url, username, context, allow_ntfy=(username == legacy_username))
        for username in usernames
    ]
    sent_count = sum(1 for r in results if r['status'] == 'sent')

    return JsonResponse({
        'status': 'sent' if sent_count else 'error',
        'sent': sent_count,
        'total': len(results),
        'recipients': results,
    })


def service_worker(request):
    """Serves sw.js at the site root (/sw.js) rather than /static/sw.js — a service worker's
    default max allowed scope is the directory it's served from, and this one needs to cover the
    whole app ("/") so it can intercept navigations on every page and receive push events
    regardless of which page (or none) is currently open."""
    sw_path = os.path.join(settings.BASE_DIR, 'prescript_app', 'static', 'sw.js')
    try:
        with open(sw_path, 'rb') as f:
            content = f.read()
    except FileNotFoundError:
        return HttpResponseNotFound()
    response = HttpResponse(content, content_type='application/javascript')
    response['Cache-Control'] = 'no-cache'  # so an updated sw.js is picked up promptly, not stuck behind a long-lived cache
    return response


def debug_push_status(request):
    """Temporary, no-auth diagnostic — deliberately exposes nothing sensitive (counts and
    timestamps only, no usernames/endpoints/keys) so it's safe to leave world-readable while
    debugging why automatic delivery isn't confirmed yet. Added to answer "is there actually a
    live subscription, and when" with real evidence instead of guessing from code review. Remove
    once the automatic-delivery question is settled."""
    subs = PushSubscription.objects.order_by('-created_at')
    pending = PendingNotification.objects.order_by('-sent_at')
    unresolved = pending.filter(resolved=False)

    return JsonResponse({
        'push_subscription_count': subs.count(),
        'most_recent_subscription_at': subs.first().created_at.isoformat() if subs.exists() else None,
        'pending_notification_count_total': pending.count(),
        'pending_notification_count_unresolved': unresolved.count(),
        'most_recent_pending_notification_at': pending.first().sent_at.isoformat() if pending.exists() else None,
        'server_time': timezone.now().isoformat(),
    })


def vapid_public_key(request):
    """Returns the VAPID public key the client needs to pass to PushManager.subscribe()
    (as applicationServerKey). Public by design — it's not a secret, only the private key is."""
    key = notify_module.VAPID_PUBLIC_KEY
    if not key:
        return JsonResponse({'status': 'error', 'detail': 'VAPID_PUBLIC_KEY is not configured'}, status=500)
    return JsonResponse({'status': 'success', 'publicKey': key})


@csrf_exempt  # called with fetch() before a session/csrftoken cookie can be relied on in some
              # PWA-install edge cases; the payload is just a public subscription + a username,
              # nothing sensitive, and it can't act on anyone else's behalf (see PushSubscription).
@require_POST
def push_subscribe(request):
    """Stores (or refreshes) a browser's Web Push subscription for `username`.

    Called from pwa.js right after the user grants notification permission and
    PushManager.subscribe() resolves. Body is JSON: {username, subscription: {endpoint, keys}}.
    """
    try:
        data = json.loads(request.body or "{}")
    except (ValueError, TypeError):
        return JsonResponse({'status': 'error', 'detail': 'invalid JSON'}, status=400)

    username = (data.get('username') or '').strip()
    sub = data.get('subscription') or {}
    endpoint = sub.get('endpoint')
    keys = sub.get('keys') or {}
    p256dh = keys.get('p256dh')
    auth = keys.get('auth')

    if not (username and endpoint and p256dh and auth):
        return JsonResponse({'status': 'error', 'detail': 'username, endpoint and keys are required'}, status=400)

    PushSubscription.objects.update_or_create(
        endpoint=endpoint,
        defaults={
            'username': username,
            'p256dh': p256dh,
            'auth': auth,
            'user_agent': request.META.get('HTTP_USER_AGENT', '')[:255],
        },
    )
    return JsonResponse({'status': 'success'})


@csrf_exempt  # see push_subscribe
@require_POST
def push_unsubscribe(request):
    """Removes a browser's Web Push subscription — called from pwa.js when the user turns
    notifications back off, and by the service worker's `pushsubscriptionchange` handler when
    the browser itself invalidates the subscription. Body is JSON: {endpoint}."""
    try:
        data = json.loads(request.body or "{}")
    except (ValueError, TypeError):
        return JsonResponse({'status': 'error', 'detail': 'invalid JSON'}, status=400)

    endpoint = data.get('endpoint')
    if endpoint:
        PushSubscription.objects.filter(endpoint=endpoint).delete()
    return JsonResponse({'status': 'success'})
