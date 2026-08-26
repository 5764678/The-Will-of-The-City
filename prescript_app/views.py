import datetime
import os
import random
from zoneinfo import ZoneInfo

from django.core import signing
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.decorators import method_decorator
from django.views.generic import TemplateView

from prescript_app.models import UserProfile, PrescriptHistory, PendingNotification
from .prescripts import generate_prescript
from . import grace as grace_module
from .notify import (
    send_ntfy_alarm_burst,
    send_ntfy_message,
    send_ntfy_prescript,
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


def _maybe_notify(message):
    """Best-effort push of a short outcome message — only if NTFY_TOPIC is configured. Never
    raises: a notification hiccup shouldn't break scoring, which already happened by this point."""
    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return
    try:
        send_ntfy_message(topic, message)
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
class home(TemplateView): # This class defines the view for the home page of the application, which displays the current prescript and the user's grace score. It inherits from TemplateView and specifies 'index.html' as the template to render. The get_context_data method is overridden to generate a new prescript, update the current reward and punishment values, and include the prescript text and grace score in the context passed to the template for rendering.
    template_name = 'index.html'

    def get_context_data(self, **kwargs): # This method is responsible for preparing the context data that will be passed to the template when rendering the home page. It generates a new prescript using the generate_prescript function, stores it in the session, and adds it along with the current grace score to the context used in the template.
        context = super().get_context_data(**kwargs)

        text, reward, punishment = generate_prescript()
        _set_current(self.request, text, reward, punishment)

        context['prescript'] = text
        context['grace'] = grace_module.get_grace()

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

    def get_context_data(self, **kwargs): # This method prepares the context data for the role page. It retrieves the current grace score using the get_grace function from the grace module and adds it to the context dictionary that will be used in the template. This allows the template to determine the user's current role based on their grace score and display the relevant information accordingly.
        context = super().get_context_data(**kwargs)
        context['grace'] = grace_module.get_grace()
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


def _maybe_trigger_ignore_alarm(profile):
    """Call right after recording an Ignore (explicit tap or auto-expired timeout — both count
    the same). Fires an escalating alarm burst once the streak crosses IGNORE_SPAM_THRESHOLD."""
    if not profile:
        return
    streak = _current_ignore_streak(profile)
    if streak < IGNORE_SPAM_THRESHOLD:
        return
    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return
    burst_size = streak - IGNORE_SPAM_THRESHOLD + 1
    try:
        send_ntfy_alarm_burst(topic, burst_size)
    except Exception:
        pass


def _maybe_send_streak_resolution(profile):
    """Call right before recording a Complete — if there was an active bad streak going into
    it, send a one-off message acknowledging it broke. Reads history from *before* this
    Complete is recorded, so call this first."""
    if not profile:
        return
    if _current_ignore_streak(profile) >= IGNORE_SPAM_THRESHOLD:
        _maybe_notify(random.choice(STREAK_RESOLUTION_MESSAGES))


def complete(request): # This function handles the completion of a prescript task by the user. It updates the user's grace score based on the reward for completing the task, records the action in the history, and generates a new prescript for the next task. The function also manages user profiles and updates the database accordingly if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment, source, token = _resolve_current(request)

    if source == 'expired_token':
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES))
        return JsonResponse({'status': 'expired'}, status=410)

    if source == 'token' and not _claim_pending_or_reject(token):
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES))
        return JsonResponse({'status': 'already_handled'}, status=409)

    username = request.GET.get('username') or request.POST.get('username')
    base_grace = grace_module.get_grace()

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
        grace_module.set_grace(new_grace)

    _maybe_send_streak_resolution(profile)  # check before recording, so it sees the streak that's about to break
    _record_history(username, current_text, PrescriptHistory.COMPLETED)

    if source == 'token':
        _maybe_notify(random.choice(COMPLETE_CONFIRMATIONS))

    text, reward, punishment = generate_prescript()
    _set_current(request, text, reward, punishment)

    return JsonResponse({
        'grace': new_grace,
        'status': "clear",
        'prescript': text
    })


def ignore(request): # This function handles the case when a user chooses to ignore a prescript task. It updates the user's grace score based on the punishment for ignoring the task, records the action in the history, and generates a new prescript for the next task. Similar to the complete function, it manages user profiles and updates the database if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment, source, token = _resolve_current(request)

    if source == 'expired_token':
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES))
        return JsonResponse({'status': 'expired'}, status=410)

    if source == 'token' and not _claim_pending_or_reject(token):
        _maybe_notify(random.choice(EXPIRED_TAP_MESSAGES))
        return JsonResponse({'status': 'already_handled'}, status=409)

    username = request.GET.get('username') or request.POST.get('username')
    base_grace = grace_module.get_grace()

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
        grace_module.set_grace(new_grace)

    _record_history(username, current_text, PrescriptHistory.IGNORED)
    _maybe_trigger_ignore_alarm(profile)

    if source == 'token':
        _maybe_notify(random.choice(IGNORE_CONFIRMATIONS))

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

def get_score(request): # This function retrieves the current score for a given username. It checks if a username is provided in the POST request, and if so, it attempts to retrieve the corresponding user profile from the database. If the user profile exists, it returns that user's grace score. If the user does not exist or no username is given, it falls back to returning the global grace score. The function then returns a JsonResponse containing the status and the retrieved score.
    score = grace_module.get_grace()
    if request.method == "POST":
        username = request.POST.get('username')
        if username:
            try:
                user_profile = UserProfile.objects.get(name=username)
                score = user_profile.grace
            except UserProfile.DoesNotExist:
                score = grace_module.get_grace()

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

        _maybe_notify(random.choice(EXPIRED_MESSAGES))
        _maybe_trigger_ignore_alarm(profile)


def notify_trigger(request):
    """Generates a prescript and pushes it to your phone via ntfy.sh.

    Meant to be called by an external scheduler (see .github/workflows/prescript-notify.yml)
    at fixed times of day, not by the browser — so it's authenticated with a shared secret
    header instead of CSRF/session, and works even while nobody has the site open.

    Configure via environment variables on the host:
      NOTIFY_TRIGGER_SECRET  required — must match the X-Notify-Secret header the caller sends
      NTFY_TOPIC             required — your ntfy.sh topic name (subscribe to it in the ntfy app)
      NOTIFY_USERNAME        optional — username whose Grace the Complete/Ignore buttons affect,
                              and who unanswered prescripts get auto-filed against
    """
    secret = os.environ.get('NOTIFY_TRIGGER_SECRET')
    if not secret or request.headers.get('X-Notify-Secret') != secret:
        return JsonResponse({'status': 'forbidden'}, status=403)

    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return JsonResponse({'status': 'error', 'detail': 'NTFY_TOPIC is not configured'}, status=500)

    username = os.environ.get('NOTIFY_USERNAME', '')

    _expire_stale_pending(username)

    context = _current_notify_context()
    text, reward, punishment = generate_prescript(context=context)
    token = signing.dumps({'text': text, 'reward': reward, 'punishment': punishment})

    base_url = request.build_absolute_uri('/').rstrip('/')
    username_qs = f"&username={username}" if username else ""
    complete_url = f"{base_url}/complete/?p={token}{username_qs}"
    ignore_url = f"{base_url}/ignore/?p={token}{username_qs}"

    if username:
        PendingNotification.objects.create(
            username=username, text=text, reward=reward, punishment=punishment, token=token,
        )

    try:
        send_ntfy_prescript(topic, text, complete_url=complete_url, ignore_url=ignore_url)
    except Exception as exc:
        return JsonResponse({'status': 'error', 'detail': str(exc)}, status=502)

    return JsonResponse({'status': 'sent', 'prescript': text})
