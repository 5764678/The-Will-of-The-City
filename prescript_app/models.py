from django.db import models

# Create your models here.
class UserProfile(models.Model):
    name = models.TextField(unique=True)
    grace = models.IntegerField(default=0)
    total_rewards = models.IntegerField(default=0)
    total_punishments = models.IntegerField(default=0)

    def __str__(self):
        return self.name