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

Notifications go out via Web Push first (see `prescript_app/notify.py`), falling back to
[ntfy.sh](https://ntfy.sh) if a user has no push subscription yet or a push attempt fails.

**Environment variables** (set on Render and, for the scheduler, in the GitHub Actions repo
secrets — see `render.yaml` / `.github/workflows/prescript-notify.yml`):

| Variable | Required for | Notes |
|---|---|---|
| `NOTIFY_TRIGGER_SECRET` | scheduled notifications | shared secret the GitHub Actions cron sends as `X-Notify-Secret` |
| `NOTIFY_USERNAME` | scheduled notifications | whose subscriptions get pushed to / Grace gets affected |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push | generate once, see below — **do not commit these** |
| `VAPID_CLAIMS_EMAIL` | Web Push | contact email sent only to the browser vendor's push service (Google/Mozilla/Apple), as required by the Web Push spec |
| `NTFY_TOPIC` | ntfy.sh fallback | optional |

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

## Credits
Project Moon inspiration
Community image sources
