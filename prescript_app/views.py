import os

from django.core import signing
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.decorators import method_decorator
from django.views.generic import TemplateView

from prescript_app.models import UserProfile, PrescriptHistory
from .prescripts import generate_prescript
from . import grace as grace_module
from .notify import send_ntfy_prescript

# Notification action buttons stay valid for this long after being sent, in case you don't
# see the phone notification right away.
NOTIFY_TOKEN_MAX_AGE = 60 * 60 * 12

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
    """Figure out which prescript is being acted on.

    Normally that's whatever's tracked in the session for this browser (_get_current). But a
    tap on a Complete/Ignore button inside a phone push notification arrives as a plain,
    session-less HTTP request — there's no browser session to read. For that case the
    notification's action URL carries a `p` token (see notify_trigger) signed with
    django.core.signing, which is verified and trusted here instead.
    """
    token = request.GET.get('p') or request.POST.get('p')
    if token:
        try:
            data = signing.loads(token, max_age=NOTIFY_TOKEN_MAX_AGE)
            return data['text'], data['reward'], data['punishment']
        except signing.BadSignature:
            pass  # fall through to the normal session-based prescript

    current = _get_current(request)
    return current['text'], current['reward'], current['punishment']


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


def complete(request): # This function handles the completion of a prescript task by the user. It updates the user's grace score based on the reward for completing the task, records the action in the history, and generates a new prescript for the next task. The function also manages user profiles and updates the database accordingly if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment = _resolve_current(request)

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

    _record_history(username, current_text, PrescriptHistory.COMPLETED)

    text, reward, punishment = generate_prescript()
    _set_current(request, text, reward, punishment)

    return JsonResponse({
        'grace': new_grace,
        'status': "clear",
        'prescript': text
    })


def ignore(request): # This function handles the case when a user chooses to ignore a prescript task. It updates the user's grace score based on the punishment for ignoring the task, records the action in the history, and generates a new prescript for the next task. Similar to the complete function, it manages user profiles and updates the database if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    current_text, current_reward, current_punishment = _resolve_current(request)

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


def notify_trigger(request):
    """Generates a prescript and pushes it to your phone via ntfy.sh.

    Meant to be called by an external scheduler (see .github/workflows/prescript-notify.yml)
    at fixed times of day, not by the browser — so it's authenticated with a shared secret
    header instead of CSRF/session, and works even while nobody has the site open.

    Configure via environment variables on the host:
      NOTIFY_TRIGGER_SECRET  required — must match the X-Notify-Secret header the caller sends
      NTFY_TOPIC             required — your ntfy.sh topic name (subscribe to it in the ntfy app)
      NOTIFY_USERNAME        optional — username whose Grace the Complete/Ignore buttons affect
    """
    secret = os.environ.get('NOTIFY_TRIGGER_SECRET')
    if not secret or request.headers.get('X-Notify-Secret') != secret:
        return JsonResponse({'status': 'forbidden'}, status=403)

    topic = os.environ.get('NTFY_TOPIC')
    if not topic:
        return JsonResponse({'status': 'error', 'detail': 'NTFY_TOPIC is not configured'}, status=500)

    username = os.environ.get('NOTIFY_USERNAME', '')

    text, reward, punishment = generate_prescript()
    token = signing.dumps({'text': text, 'reward': reward, 'punishment': punishment})

    base_url = request.build_absolute_uri('/').rstrip('/')
    username_qs = f"&username={username}" if username else ""
    complete_url = f"{base_url}/complete/?p={token}{username_qs}"
    ignore_url = f"{base_url}/ignore/?p={token}{username_qs}"

    try:
        send_ntfy_prescript(topic, text, complete_url=complete_url, ignore_url=ignore_url)
    except Exception as exc:
        return JsonResponse({'status': 'error', 'detail': str(exc)}, status=502)

    return JsonResponse({'status': 'sent', 'prescript': text})
