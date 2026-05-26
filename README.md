# 🔮 Oracle — Thread Toxicity Predictor

> "Oracle sees the future of your threads."

Oracle is a moderator early-warning app for Reddit communities. It watches new posts during their first few minutes, samples early thread signals, and predicts whether the discussion is likely to need moderator intervention.

When a thread crosses your configured risk threshold, Oracle sends the mod team a concise modmail briefing with the Risk Score, signal breakdown, thread link, and suggested next steps. It also keeps a live dashboard post with recent predictions and outcome tracking so moderators can learn whether alerts were useful.

## What it does

Oracle runs without external APIs or machine-learning services. Every prediction is computed from Reddit data available to the installed app: early comments, post reports when exposed by the API, the post title, baseline comment velocity, and author removal history tracked locally in Redis.

The app is event-driven. A `PostSubmit` trigger schedules one prediction job for that specific post after the configured prediction window. The job runs once, saves a durable prediction record, optionally sends modmail, and updates the rolling subreddit baseline.

Moderators can also run Oracle manually from any post with **🔮 Predict Now**, then mark the result as **Intervened** or **False Alarm**. Those markings feed the dashboard accuracy loop.

## The 5 Prediction Signals

| Signal | What it measures | Max points | Why it predicts toxicity |
| --- | --- | ---: | --- |
| Comment velocity | First-window comments vs. the subreddit rolling baseline | 25 | Threads moving far faster than normal tend to require earlier attention. |
| New account surge | Share of early commenters who only comment once in the thread | 25 | One-time early commenters can indicate external traffic or drive-by escalation. |
| Report rate | Post reports divided by comment count | 20 | Reports are a direct moderator signal when Reddit exposes them to the app. |
| Author history | Prior removals by the same author in this subreddit | 20 | Local removal history is a useful contextual risk signal. |
| Title sensitivity | Heated, emotional, or question-bait markers in the title | 10 | Certain title patterns predict argumentative comment sections. |

## Risk Levels

| Score | Level | Emoji | What to do |
| --- | --- | --- | --- |
| 0-25 | Low | 🟢 | No action needed. |
| 26-50 | Moderate | 🟡 | Worth watching. |
| 51-74 | High | 🟠 | Monitor closely and check the queue. |
| 75-100 | Critical | 🔴 | Open the thread immediately. |

## How accuracy improves over time

Oracle needs a warm-up period. During the first several posts, the rolling baseline is still learning the subreddit’s normal first-window comment volume, so comment velocity contributes less until at least five sampled posts exist. The dashboard shows a warming-up notice until ten posts have been sampled.

Outcome marking improves the usefulness of Oracle’s reporting. When moderators mark flagged threads as **Intervened** or **False Alarm**, the dashboard can show alert accuracy once at least five outcomes have been recorded.

## Installation & setup

1. Install Oracle from the Reddit Developer/App Directory into a subreddit you moderate.
2. Open the app settings for that subreddit.
3. Keep the default settings for a demo, or set **Alert threshold** to `0` temporarily to force a modmail alert during testing.
4. Use the subreddit menu action **🔮 Create Oracle Dashboard** to create the dashboard post.
5. Pin the dashboard post if you want moderators to review recent predictions quickly.

Subreddit creation is done on Reddit itself, not through the Devvit CLI. If you do not already moderate a small test subreddit, create one on Reddit first and then install Oracle there.

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| Alert threshold | Minimum Risk Score required before Oracle sends modmail. | 55 |
| Alert cooldown | Minimum minutes between Oracle modmail alerts. | 15 |
| Prediction window | Minutes after posting before Oracle samples the thread. | 5 |
| Mute all Oracle alerts | Stops modmail while still computing and storing predictions. | Off |
| Watch all posts | If off, Oracle only runs when moderators use Predict Now. | On |

## How to mark outcomes

Open the post menu on any predicted thread and choose **🔮 Mark as Intervened** when moderators had to act. Choose **🔮 Mark as False Alarm** when the alert did not need intervention.

These actions update the stored prediction record and dashboard stats. After at least five marked outcomes, Oracle displays the percentage of marked alerts that led to intervention.

## Dashboard

Use the subreddit menu action **🔮 Create Oracle Dashboard** to submit a custom post dashboard. It shows recent predictions, alert counts, outcome counts, accuracy when enough outcomes exist, and whether the comment-velocity baseline is still warming up.

## Testing checklist

- New post submitted → `oracle-predict` job is scheduled.
- Five minutes later, or 30 seconds after **🔮 Predict Now**, a prediction is computed.
- Risk Score is a number from 0 to 100.
- Modmail alert fires when the score meets the threshold.
- Dashboard shows recent predictions.
- **Mark as Intervened** and **Mark as False Alarm** update stats.
- Null state renders cleanly before any predictions exist.
