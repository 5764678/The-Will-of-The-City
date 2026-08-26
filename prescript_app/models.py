from django.db import models

# Create your models here.
class UserProfile(models.Model):
    name = models.TextField(unique=True)
    grace = models.IntegerField(default=0)
    total_rewards = models.IntegerField(default=0)
    total_punishments = models.IntegerField(default=0)

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


class PendingNotification(models.Model):  # Tracks a scheduled push notification's prescript from the moment it's
    # sent until it's either tapped (Complete/Ignore) or times out unanswered. Lets notify_trigger auto-file an
    # unanswered one as ignored the next time it runs, instead of it just silently going nowhere.
    username = models.CharField(max_length=150)
    text = models.TextField()
    reward = models.IntegerField()
    punishment = models.IntegerField()
    token = models.TextField(db_index=True)  # the exact signed `p` value sent in the notification's action URLs
    sent_at = models.DateTimeField(auto_now_add=True)
    resolved = models.BooleanField(default=False)

    class Meta:
        ordering = ['-sent_at']

    def __str__(self):
        return f"{self.username}: {'resolved' if self.resolved else 'pending'} — {self.text[:40]}"