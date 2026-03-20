from django.http import JsonResponse
from django.views.generic import TemplateView

from prescript_app.models import UserProfile
from .prescripts import generate_prescript
from . import grace as grace_module

current_reward = 0
current_punishment = 0
current_text = ""
history = []


class home(TemplateView): # This class defines the view for the home page of the application, which displays the current prescript and the user's grace score. It inherits from TemplateView and specifies 'index.html' as the template to render. The get_context_data method is overridden to generate a new prescript, update the current reward and punishment values, and include the prescript text and grace score in the context passed to the template for rendering.
    template_name = 'index.html'

    def get_context_data(self, **kwargs): # This method is responsible for preparing the context data that will be passed to the template when rendering the home page. It generates a new prescript using the generate_prescript function, updates the global variables for the current reward, punishment, and text, and adds these values along with the current grace score to the context dictionary that will be used in the template.
        global current_reward, current_punishment, current_text

        context = super().get_context_data(**kwargs)

        text, reward, punishment = generate_prescript()

        current_reward = reward
        current_punishment = punishment
        current_text = text

        context['prescript'] = text
        context['grace'] = grace_module.get_grace()

        return context
class historyView(TemplateView): # This class defines the view for the history page of the application, which displays a list of the user's past actions (completions and ignores) along with the associated prescripts. It inherits from TemplateView and specifies 'history.html' as the template to render. The get_context_data method is overridden to include the history list in the context passed to the template for rendering.
    template_name = 'history.html'

    def get_context_data(self, **kwargs): # This method prepares the context data for the history page. It retrieves the global history list, which contains records of the user's past actions, and adds it to the context dictionary that will be used in the template. This allows the template to display the history of completions and ignores when rendering the page.
        context = super().get_context_data(**kwargs)
        context['history'] = history
        return context


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

class roleView(TemplateView): # This class defines the view for the role page of the application, which displays the user's current role based on their grace score. It inherits from TemplateView and specifies 'role.html' as the template to render. The get_context_data method is overridden to include the user's current grace score in the context passed to the template, allowing the template to determine and display the appropriate role information based on that score.
    template_name = 'role.html'

    def get_context_data(self, **kwargs): # This method prepares the context data for the role page. It retrieves the current grace score using the get_grace function from the grace module and adds it to the context dictionary that will be used in the template. This allows the template to determine the user's current role based on their grace score and display the relevant information accordingly.
        context = super().get_context_data(**kwargs)
        context['grace'] = grace_module.get_grace()
        return context


def complete(request): # This function handles the completion of a prescript task by the user. It updates the user's grace score based on the reward for completing the task, records the action in the history, and generates a new prescript for the next task. The function also manages user profiles and updates the database accordingly if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    global current_reward, current_punishment, current_text, history

    history.append(f"Completed — {current_text}")

    username = request.GET.get('username') or request.POST.get('username')
    base_grace = grace_module.get_grace()

    if username:
        profile, _ = UserProfile.objects.get_or_create(name=username)
        base_grace = profile.grace if profile.grace is not None else 0

    new_grace = grace_module.update_grace(True, current_reward, current_punishment, base_grace)

    if username:
        profile.grace = new_grace
        profile.total_rewards = new_grace
        profile.save()
    else:
        grace_module.set_grace(new_grace)

    text, reward, punishment = generate_prescript()

    current_reward = reward
    current_punishment = punishment
    current_text = text

    status = "clear"

    return JsonResponse({
        'grace': new_grace,
        'status': status,
        'prescript': text
    })


def ignore(request): # This function handles the case when a user chooses to ignore a prescript task. It updates the user's grace score based on the punishment for ignoring the task, records the action in the history, and generates a new prescript for the next task. Similar to the complete function, it manages user profiles and updates the database if a username is provided in the request. Finally, it returns a JsonResponse containing the new grace score, status, and the next prescript to be displayed to the user.
    global current_reward, current_punishment, current_text, history

    history.append(f"Ignored — {current_text}")

    username = request.GET.get('username') or request.POST.get('username')
    base_grace = grace_module.get_grace()

    if username:
        profile, _ = UserProfile.objects.get_or_create(name=username)
        base_grace = profile.grace if profile.grace is not None else 0

    new_grace = grace_module.update_grace(False, current_reward, current_punishment, base_grace)

    if username:
        profile.grace = new_grace
        profile.total_punishments += 1
        profile.total_rewards = new_grace
        profile.save()
    else:
        grace_module.set_grace(new_grace)

    text, reward, punishment = generate_prescript()

    current_reward = reward
    current_punishment = punishment
    current_text = text

    status = "failed"

    return JsonResponse({
        'grace': new_grace,
        'status': status,
        'prescript': text
    })

def update(request): # This function is designed to handle updates to the user's profile, such as creating a new user profile if a username is provided in the request. It checks for the presence of a username in the POST data, and if it exists, it either retrieves the existing user profile or creates a new one in the database. The function then returns a JsonResponse indicating the success of the operation. This allows the application to manage user profiles and ensure that each user has an associated profile in the database.
    print("Updating prescript user...")
    if request.method == "POST":
        username = request.POST.get('username')
        print(f"Received username: {username}")

        if UserProfile.objects.filter(name=username).exists():
            print(f"User '{username}' already exists.")
        else:
            UserProfile.objects.create(name=username)
            print(f"Created new user profile for '{username}'.")
        # Here you would typically update the user's profile in the database
    return JsonResponse({
        'status': 'success'
    })

def update_score(request): # This function is responsible for updating the user's score based on the provided username and score in the POST request. It checks if the username and score are present, and if so, it retrieves or creates a user profile for that username. The function then updates the user's grace score and total rewards in the database with the new score value. Finally, it returns a JsonResponse indicating the success of the operation along with the updated score. This allows the application to keep track of each user's score and update it as needed based on their interactions with the prescripts.
    print("Updating score for prescript user...")
    score = 0
    if request.method == "POST":
        username = request.POST.get('username')
        score = request.POST.get('score')
        print(f"Received username: {username}, score: {score}")
        if username and score is not None:
            try:
                user_profile, created = UserProfile.objects.get_or_create(name=username)
                user_profile.grace = int(score)
                user_profile.total_rewards = int(score)
                if created:
                    user_profile.total_punishments = 0
                user_profile.save()
                print(f"Updated user profile for '{username}' with new score: {score}.")
            except ValueError:
                print(f"Invalid score value: {score}")
        else:
            print("update_score skipped: missing username or score")
    return JsonResponse({
        'status': 'success',
        'score': score
    })

def get_score(request): # This function retrieves the current score for a given username. It checks if a username is provided in the POST request, and if so, it attempts to retrieve the corresponding user profile from the database. If the user profile exists and has a grace score or total rewards, it returns that score. If the user does not exist or does not have a score, it falls back to returning the global grace score. The function then returns a JsonResponse containing the status and the retrieved score. This allows the application to provide users with their current score based on their interactions with the prescripts.
    print("Retrieving score for prescript user...")
    score = grace_module.get_grace()
    if request.method == "POST":
        username = request.POST.get('username')
        print(f"Received username for score retrieval: {username}")
        if username:
            try:
                user_profile = UserProfile.objects.get(name=username)
                if user_profile.grace is not None and user_profile.grace != 0:
                    score = user_profile.grace
                elif user_profile.total_rewards is not None:
                    score = user_profile.total_rewards
                else:
                    score = grace_module.get_grace()
                print(f"Retrieved score for '{username}': {score} (grace={user_profile.grace}, total_rewards={user_profile.total_rewards}).")
            except UserProfile.DoesNotExist:
                print(f"User '{username}' does not exist. Using global grace: {grace_module.get_grace()}.")
                score = grace_module.get_grace()
        else:
            print(f"No username provided. Using global grace: {grace_module.get_grace()}.")
            score = grace_module.get_grace()

    return JsonResponse({
        'status': 'success',
        'score': score
    })
