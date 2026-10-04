---
name: onboarding
description: Connect the user's Garmin account and show what the Garmin plugin can do, when the user chooses Set up for Garmin or asks for onboarding.
---

# Set up Garmin

1. Call `garmin-check-auth` with `{}`. If the user isn't connected, it shows the Garmin sign-in form inside the app: ask them to sign in there (email, password and, if enabled, the MFA code). Never ask for the password in the chat — the form encrypts it and it stays on their computer.
2. Once connected, call `get-daily-briefing` with `{}` to show today's briefing, and give a one-paragraph read of it.
3. Mention, briefly, what else they can ask: trends over the last year (`show-performance-dashboard`), planning a training week, and splits of a recent run. The Garmin sidebar item opens the daily briefing and the dashboard any time.

If they installed the plugin during another task, continue that task after connecting.
