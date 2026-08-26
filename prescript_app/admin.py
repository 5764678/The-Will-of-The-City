from django.contrib import admin

from .models import UserProfile, PrescriptHistory


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ('name', 'grace', 'total_rewards', 'total_punishments')
    search_fields = ('name',)


@admin.register(PrescriptHistory)
class PrescriptHistoryAdmin(admin.ModelAdmin):
    list_display = ('user', 'action', 'text', 'created_at')
    list_filter = ('action',)
    search_fields = ('text', 'user__name')
