from django.urls import path
from . import views

urlpatterns = [
    path('', views.menuView.as_view()),
    path('home/', views.home.as_view()),
    path('history/', views.historyView.as_view()),
    path('about/', views.aboutView.as_view()),
    path('role/', views.roleView.as_view()),
    path('menu/', views.menuView.as_view()),
    path('complete/', views.complete),
    path('ignore/', views.ignore),
    path('update/', views.update),
    path('update_score/', views.update_score),
    path('get_score/', views.get_score),
    path('get_history/', views.get_history),
    path('get_inbox/', views.get_inbox),
    path('request_prescript/', views.request_prescript),
    path('notify/trigger/', views.notify_trigger),
    path('sw.js', views.service_worker),
    path('push/vapid-public-key/', views.vapid_public_key),
    path('push/subscribe/', views.push_subscribe),
    path('push/unsubscribe/', views.push_unsubscribe),
]