
grace = 0

def get_grace(): # This function retrieves the current grace score. It simply returns the value of the global variable "grace", which is used to track the user's current grace score in the application.
    global grace
    return grace


def set_grace(value): # This function updates the grace score to a new value. It takes a value as an argument and assigns it to the global variable "grace", allowing the application to keep track of the user's current grace score as it changes based on their actions.
    global grace
    grace = value


def update_grace(completed, reward, punishment, current_grace=None): # This function updates the grace score based on whether the user has completed a task and the associated reward or punishment. It takes the completion status, reward, and punishment values as arguments, along with an optional current_grace parameter to allow for updating the grace score based on a specific starting value.

    global grace
    if current_grace is None:
        current_grace = grace

    if completed:
        new_grace = current_grace + reward
    else:
        new_grace = current_grace - punishment

    grace = new_grace
    return new_grace