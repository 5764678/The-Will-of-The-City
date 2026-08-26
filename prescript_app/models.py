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