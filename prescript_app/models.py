from django.db import models

# Create your models here.
class UserProfile(models.Model):
    name = models.TextField(unique=True)
    grace = models.IntegerField(default=0)
    total_rewards = models.IntegerField(default=0)
    total_punishments = models.IntegerField(default=0)
    accepting_prescripts = models.BooleanField(default=True)  # The home page's "Index Device:
    # Operational/Standby" toggle. False means this username is in standby: no *new* prescript
    # gets generated for them, scheduled (notify_trigger) or on-demand (request_prescript) — see
    # both in views.py. Doesn't touch anything already in flight: existing PendingNotification
    # rows still expire/complete/ignore normally, and Web Push subscriptions are untouched. A
    # missing UserProfile (e.g. the legacy NOTIFY_USERNAME fallback before its first toggle) is
    # treated as accepting=True everywhere this is checked, so nobody is opted into standby by default.

    def __str__(self):
        return self.name


class PrescriptHistory(models.Model):  # Persists each completed/ignored prescript per user, so History survives server restarts and isn't shared between different users.
    COMPLETED = 'completed'
    IGNORED = 'ignored'
    ACTION_CHOICES = [
        (COMPLETED, 'Completed'),
        (IGNORED, 'Ignored'),
    ]

    user = models.ForeignKey(UserProfile, on_delete=models.CASCADE, related_name='history')
    text = models.TextField()
    action = models.CharField(max_length=16, choices=ACTION_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.user.name}: {self.action} — {self.text[:40]}"


class PushSubscription(models.Model):  # A browser's Web Push subscription (from PushManager.subscribe()), tied to a
    # username the same way PendingNotification is. One row per browser/device that's granted notification
    # permission — a user with the PWA installed on two phones gets two rows, and both get pushed to.
    username = models.CharField(max_length=150, db_index=True)
    endpoint = models.TextField(unique=True)  # uniquely identifies the browser+device+origin; re-subscribing
    # the same device just updates the existing row (see push_subscribe) rather than creating a duplicate.
    p256dh = models.TextField()  # subscription's public key, used by the server to encrypt the push payload
    auth = models.TextField()    # subscription's auth secret, required alongside p256dh to encrypt the payload
    user_agent = models.CharField(max_length=255, blank=True)  # for humans skimming /admin/, not used by code
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.username}: {self.endpoint[:60]}"


class PendingNotification(models.Model):  # An inbox item: one prescript sitting unresolved, from the moment it's created (either
    # a scheduled push from notify_trigger, or a self-requested one from request_prescript — both create the same kind of row) until
    # it's either tapped (Complete/Ignore, on the phone notification or in the home page inbox — same /complete//ignore/ endpoints
    # either way) or times out unanswered. Lets the next notify_trigger sweep auto-file an unanswered one as ignored instead of it
    # just sitting there forever. get_inbox reads these (resolved=False) to populate the home page's inbox list.
    SCHEDULED = 'scheduled'
    REQUESTED = 'requested'
    SOURCE_CHOICES = [
        (SCHEDULED, 'Scheduled'),
        (REQUESTED, 'Requested'),
    ]

    username = models.CharField(max_length=150)
    text = models.TextField()
    reward = models.IntegerField()
    punishment = models.IntegerField()
    token = models.TextField(db_index=True)  # the exact signed `p` value sent in the notification's action URLs
    sent_at = models.DateTimeField(auto_now_add=True)
    resolved = models.BooleanField(default=False)
    source = models.CharField(max_length=16, choices=SOURCE_CHOICES, default=REQUESTED)  # distinguishes an
    # automatic notify_trigger send from a self-requested one — request_prescript's rows stay REQUESTED (the
    # default) so a burst of "Request Prescript" taps can never be mistaken for missed scheduled sends. Lets
    # notify_trigger's catch-up logic look at only SCHEDULED rows when deciding how far behind it is.

    class Meta:
        ordering = ['-sent_at']

    def __str__(self):
        return f"{self.username}: {'resolved' if self.resolved else 'pending'} — {self.text[:40]}"