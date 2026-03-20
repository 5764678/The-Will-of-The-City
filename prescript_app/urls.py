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
]