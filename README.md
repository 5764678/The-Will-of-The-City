# The Will of The City

## About
Fan project inspired by The Index from Project Moon.

## Features
- Dynamic prescript generation
- Grace system
- Role progression
- History archive
- About pages

## Tech Stack
- Django
- Python
- JavaScript
- HTML/CSS

## Installable PWA + push notifications
The site is an installable Progressive Web App (`prescript_app/static/manifest.webmanifest`,
`prescript_app/static/sw.js`). On iOS, notifications only work once it's added to the Home
Screen: Safari → Share → **Add to Home Screen**, open it from there, then use **Enable
Notifications** on the Menu page (has to be a direct tap — iOS refuses permission requests
otherwise).

Notifications go out via Web Push (see `prescript_app/notify.py`). The scheduled sweep
(`notify_trigger` / `.github/workflows/prescript-notify.yml`) is **per-user**: anyone who's ever
enabled notifications gets their own independently generated prescript, scored against their own
grace/history/streak — not a broadcast of one shared prescript. `NOTIFY_USERNAME` is a legacy
setting kept only so the original single-user ntfy.sh fallback keeps working for whoever that env
var names; everyone else is Web-Push-only (nobody else has an ntfy topic configured for them).

**Environment variables** (set on Render and, for the scheduler, in the GitHub Actions repo
secrets — see `render.yaml` / `.github/workflows/prescript-notify.yml`):

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | persistence | set manually to a **Neon** Postgres connection string (neon.tech — free tier, never expires, just suspends compute on idle and auto-wakes on the next query). Without it the app falls back to a local SQLite file, which does **not** survive Render restarts/deploys. Render's own free Postgres was tried first but self-deletes 30 days after creation — not used for that reason |
| `NOTIFY_TRIGGER_SECRET` | scheduled notifications | shared secret the GitHub Actions cron sends as `X-Notify-Secret` |
| `NOTIFY_USERNAME` | legacy ntfy fallback | optional — see above |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push | generate once, see below — **do not commit these** |
| `VAPID_CLAIMS_EMAIL` | Web Push | contact email sent only to the browser vendor's push service (Google/Mozilla/Apple), as required by the Web Push spec |
| `NTFY_TOPIC` | legacy ntfy fallback | optional, only ever used for `NOTIFY_USERNAME` |

Generate a VAPID keypair once (don't regenerate on a live deployment — that invalidates every
browser's existing subscription, so everyone would need to re-enable notifications):
```
pip install py-vapid
python -c "
from py_vapid import Vapid02
import base64
v = Vapid02(); v.generate_keys()
pub = v.public_key.public_bytes(__import__('cryptography').hazmat.primitives.serialization.Encoding.X962, __import__('cryptography').hazmat.primitives.serialization.PublicFormat.UncompressedPoint)
priv = v.private_key.private_numbers().private_value.to_bytes(32, 'big')
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
print('VAPID_PUBLIC_KEY=', b64(pub))
print('VAPID_PRIVATE_KEY=', b64(priv))
"
```

### Scheduler reliability

The automatic sweep is a GitHub Actions `schedule` cron hitting `/notify/trigger/` — there's no
background worker or in-process scheduler in this app at all, by design (Render's free web
service has none, and one would die on every spin-down anyway). GitHub's own docs confirm what
its run history here showed directly: scheduled workflows "can be delayed during periods of high
loads... especially at the start of every hour," and "some queued jobs may be dropped" — which is
exactly why the cron entries are offset a few minutes off `:00`/`:30` rather than sitting on them.

That reduces drops but doesn't eliminate GitHub's own scheduling variance. For tighter timing,
add a second, independent trigger from [cron-job.org](https://cron-job.org) (genuinely free, no
card, donation-funded, up to 1-per-minute granularity — verified directly against their site, not
assumed) hitting the same endpoint a few minutes off the GitHub Actions one:
```
GET https://will-of-the-city.onrender.com/notify/trigger/
Header: X-Notify-Secret: <same value as NOTIFY_TRIGGER_SECRET>
```
Two independent, uncorrelated schedulers firing the same idempotent endpoint is pure redundancy —
whichever lands first wins for that sweep, neither depends on the other.

## Credits
Project Moon inspiration
Community image sources
