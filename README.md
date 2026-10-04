# 🫧 Systems Study

A daily study space for **how computers really work** and **system design interviews**. Sister project of [`../leet`](../leet).

Every day has one topic:

1. 📖 **Read** a lesson (analogy → mechanism → numbers → how it shows up in interviews)
2. ✍️ **Answer** 5–6 interview-style questions in your own words (saved as you type)
3. 🤖 **Get feedback** from an AI: a score out of 10 per answer, what's missing, a model answer and a follow-up question
4. 💙 **Finish the day.** Its questions join the 🧠 **Recall** deck and come back 1, 3, 7, 14, 30 and 60 days later

67 days in seven tracks: how a computer works → networking → data & databases → building blocks of scale → distributed systems → production (security, deploys, cloud, AI serving) → design case studies (URL shortener, news feed, chat, video, payments…).

## Run it

```bash
nvm use          # needs Node 18+ (.nvmrc pins 22)
npm start        # → http://localhost:4331   (npm start -- --open also opens the browser)
```

No dependencies to install. Leet Study uses port 4321, so both can run at once.

## Getting your answers graded

**Any AI.** On a day's page, click **📋 Copy prompt for AI**. The prompt has the questions, your answers and the grading checklist. Paste it into Claude (or another AI), then paste the reply into the **🤖 Feedback** tab. The reply ends with `SCORES: q1=7, q2=5, …`, which records your scores.

**Claude Code.** Open Claude Code in this folder (or in `~/study`) and run:

```
/grade 14        # or: "grade day 14", or "/grade" for the last day you answered
```

Claude reads `answers/14-http.json`, grades it, and writes the feedback and scores back into the file. Switch back to the browser tab and the feedback shows up.

**Terminal.** `npm run prompt -- 14` prints the same prompt (`npm run prompt` with no number uses your current day).

## Layout

```
days/NN-topic/
  lesson.md                 the reading
  day.json                  title, track, questions, grading key points
answers/NN-topic.json       ✏️ your answers, AI feedback and scores
cheatsheets/                quick references shown in the 📝 drawer (Ctrl+/)
data/progress.json          streaks, finished days, recall schedule, goals
app/  lib/  scripts/  server.js   the app itself
CONTENT_GUIDE.md            how a day is written (add your own!)
```

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the study app |
| `npm run prompt -- 14` | Print the AI grading prompt for day 14 |
| `npm run check` | Check every day's files against `CONTENT_GUIDE.md` |
| `npm run sync` | Commit + push your answers and progress (same as ☁️ Save to GitHub) |
| `npm run build` | Build the static website into `dist/` (`-- --serve` to try it at :4332) |

## Put it on GitHub (optional)

Like Leet Study, this can live in its own repo and publish a website with GitHub Pages:

```bash
git add -A && git commit -m "Set up Systems Study"
gh repo create systems-study --public --source . --push
```

(GitHub Pages on a private repo needs a paid GitHub plan. Your answers are committed too, so pick public only if you're fine with them being visible.)

Then in the repo, set **Settings → Pages → Source** to **GitHub Actions**. Every push to `main` rebuilds the site (`.github/workflows/pages.yml`). On the website, your answers are saved in the browser; use **⬇️ Backup / ⬆️ Restore** to move them. The `/grade` command needs the local app or Codespaces, where answers are files.
