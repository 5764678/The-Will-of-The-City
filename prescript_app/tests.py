import datetime
import os
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from prescript_app import views
from prescript_app.models import PendingNotification, PrescriptHistory, UserProfile


def _scheduled(username, minutes_ago):
    row = PendingNotification.objects.create(
        username=username, text="t", reward=10, punishment=5, token=f"tok-{minutes_ago}",
        source=PendingNotification.SCHEDULED,
    )
    # sent_at is auto_now_add, so backdate it after creation.
    PendingNotification.objects.filter(pk=row.pk).update(sent_at=timezone.now() - datetime.timedelta(minutes=minutes_ago))


class MissedSweepCountTests(TestCase):
    def test_first_ever_send_is_due(self):
        self.assertEqual(views._missed_sweep_count("alice"), 1)

    def test_well_inside_interval_is_not_due(self):
        _scheduled("alice", 5)
        self.assertEqual(views._missed_sweep_count("alice"), 0)

    def test_cold_start_drift_still_counts_as_due(self):
        # Last send stamped ~40s late by a cold start; the next 15-minute heartbeat sees ~14m20s.
        # Before SWEEP_DUE_TOLERANCE this returned 0 and the cadence silently became 30 minutes.
        _scheduled("alice", 14)
        self.assertEqual(views._missed_sweep_count("alice"), 1)

    def test_catch_up_is_capped(self):
        _scheduled("alice", 150)
        self.assertEqual(views._missed_sweep_count("alice"), views.MAX_CATCHUP)

    def test_long_gap_resumes_with_one(self):
        _scheduled("alice", 60 * 5)
        self.assertEqual(views._missed_sweep_count("alice"), 1)


class NotifyTriggerTests(TestCase):
    @mock.patch.dict(os.environ, {"NOTIFY_TRIGGER_SECRET": "s3cret", "NOTIFY_USERNAME": ""})
    def test_no_recipients_is_not_a_server_error(self):
        # A 500 here counts as a failed run on cron-job.org, which auto-disables a job after
        # enough consecutive failures.
        response = self.client.get("/notify/trigger/", HTTP_X_NOTIFY_SECRET="s3cret")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "no_recipients")

    @mock.patch.dict(os.environ, {"NOTIFY_TRIGGER_SECRET": "s3cret"})
    def test_wrong_secret_is_forbidden(self):
        response = self.client.get("/notify/trigger/", HTTP_X_NOTIFY_SECRET="nope")
        self.assertEqual(response.status_code, 403)


class InboxAndHistoryPayloadTests(TestCase):
    def test_request_prescript_returns_stakes_and_expiry(self):
        response = self.client.post("/request_prescript/", {"username": "alice"})
        item = response.json()["item"]
        for key in ("token", "text", "sent_at", "expires_at", "reward", "punishment"):
            self.assertIn(key, item)

        inbox = self.client.post("/get_inbox/", {"username": "alice"}).json()["inbox"]
        self.assertEqual(inbox[0]["token"], item["token"])
        self.assertIn("expires_at", inbox[0])

    def test_history_includes_totals(self):
        profile = UserProfile.objects.create(name="alice")
        PrescriptHistory.objects.create(user=profile, text="a", action=PrescriptHistory.COMPLETED)
        PrescriptHistory.objects.create(user=profile, text="b", action=PrescriptHistory.COMPLETED)
        PrescriptHistory.objects.create(user=profile, text="c", action=PrescriptHistory.IGNORED)
        data = self.client.post("/get_history/", {"username": "alice"}).json()
        self.assertEqual(data["totals"], {"completed": 2, "ignored": 1})


@override_settings(STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class PageRenderTests(TestCase):
    def test_every_page_renders(self):
        for path in ("/", "/home/", "/menu/", "/role/", "/history/", "/about/"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)
