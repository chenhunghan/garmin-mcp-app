---
name: garmin
description: Run Coach — read the user's Garmin health and training data and show it in interactive views — daily briefing, performance trends, training week, activity splits and workouts.
---

# Run Coach (Garmin data)

Prefer the tools that open a view, and let the view carry the numbers — answer with what they mean, not a list of values:

- "How am I today?", "should I train today?", "morning briefing" → `get-daily-briefing` (date optional), then give 2–3 concrete suggestions grounded in the numbers and one thing to watch.
- Trends, progress, "is my fitness improving?" → `show-performance-dashboard` (metrics and range optional). Compare the current level with the period average, not first vs last day.
- Planning a week → `get-training-context`, ask for the goal and availability, propose a plan and wait for confirmation, then `create-structured-workout` for each session (with `scheduleDate`) and finish with `show-training-week`.
- A specific run → `get-activities` / `get-activities-by-date` to find it, then `get-activity-splits` (per-km splits even for single-lap runs) or `get-activity-hr-zones`.
- A saved workout by name → `list-workouts` with `name`, then `get-workout`.
- For several days of sleep, stress or heart rate, make ONE call with `date` and `endDate` (each call opens its own view).

If the user isn't signed in, call `garmin-check-auth`: it opens the sign-in form in the app (email, password, MFA code). Never ask for the password in the chat.
