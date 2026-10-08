# 🫧 Systems Study

A daily study space for **how computers really work** and **system design interviews**. Sister project of [`../leet`](../leet).

Every day has one topic:

1. 📖 **Read** a lesson (analogy → mechanism → numbers → how it shows up in interviews)
2. ✍️ **Answer** 5–6 interview-style questions in your own words (saved as you type)
3. 🤖 **Get feedback** from an AI: a score out of 10 per answer, what's missing, a model answer and a follow-up question.
   Then the 💡 **Solution** tab unlocks: a written model answer and the key points for every question, next to yours. The 📝 **Notes** tab is yours to fill.
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
supabase/schema.sql         the database tables, if the website saves to Supabase
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
| `npm run pull` | Copy your answers and progress from Supabase into `answers/` and `data/progress.json` |
| `npm run push` | Copy them back up (`npm run push -- 14`: only day 14, e.g. after `/grade 14`) |

## Put it on GitHub (optional)

Like Leet Study, this can live in its own repo and publish a website with GitHub Pages:

```bash
git add -A && git commit -m "Set up Systems Study"
gh repo create systems-study --public --source . --push
```

(GitHub Pages on a private repo needs a paid GitHub plan. Your answers are committed too, so pick public only if you're fine with them being visible.)

Then in the repo, set **Settings → Pages → Source** to **GitHub Actions**. Every push to `main` rebuilds the site (`.github/workflows/pages.yml`). On the website, your answers are saved in the browser; use **⬇️ Backup / ⬆️ Restore** to move them. The `/grade` command needs the local app or Codespaces, where answers are files.

## Save to your account with Supabase (optional, free)

Instead of one browser, the website can save to a free [Supabase](https://supabase.com) Postgres database. You sign in on any device, and only people you invite can have an account. Each person sees only their own answers (Row Level Security). The tables are in [`supabase/schema.sql`](supabase/schema.sql).

1. **Create the project.** Sign up at supabase.com (GitHub login works), click **New project**, pick the free plan and a region near you, and save the database password somewhere safe.
2. **Create the tables.** **SQL Editor → New query**, paste all of `supabase/schema.sql`, **Run**.
3. **Invite-only.** **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up". Email stays on.
4. **Where email links go.** **Authentication → URL Configuration**: set **Site URL** to your website (e.g. `https://<you>.github.io/systems-study/`) and add it, plus `http://localhost:4332/`, under **Redirect URLs**.
5. **Connect the app.** **Project Settings → API**: copy the **Project URL** and the **anon public** key into `supabase.config.json`. Both are safe to commit: the anon key can't read anything without a signed-in user. Never put the `service_role` key here.
6. **Invite people, yourself first.** **Authentication → Users → Add user → Send invitation**. The email links to the site, where they choose a password.
7. Commit and push. The website now shows a sign-in screen. Work already saved in your browser is offered for upload on your first sign-in.

Locally, `npm start` still uses the files. `npm run pull` copies your account's answers and progress into them (it asks for your email and password once), and `npm run push` copies them back. `/grade` does this for you.

Free-tier notes: 500 MB of database (this app uses well under 1 MB), and a project that sees no activity for 7 days is paused. Click **Restore** in the dashboard and nothing is lost. Supabase's built-in email sends only a few emails an hour, which is plenty for invites.
