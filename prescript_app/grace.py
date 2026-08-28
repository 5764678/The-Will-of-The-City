"""Pure grace-score math — no shared state lives here.

This used to hold a single module-level `grace` variable that every visitor read and wrote,
meaning every anonymous (no saved name) visitor to the site shared one counter with everyone
else, and it reset to 0 on every server restart/redeploy. Worse, update_grace() always wrote its
result back into that global as a side effect, even for named users, which meant one named user's
Complete/Ignore could quietly clobber the anonymous counter's value too.

Now the caller (views.py) is entirely responsible for where "current grace" comes from and where
the result gets stored — a UserProfile row for a named user, or the visitor's own session for an
anonymous one (see _get_anon_grace/_set_anon_grace there). This module just does the arithmetic.
"""


def update_grace(completed, reward, punishment, current_grace=0):
    """Applies one Complete (+reward) or Ignore (-punishment) to current_grace and returns the
    new value. A pure function — reads nothing and writes nothing on its own."""
    if completed:
        return current_grace + reward
    return current_grace - punishment
