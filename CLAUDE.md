# Systems Study

A daily study app for computer science fundamentals and system design (sister project of `../leet`). Zero dependencies, Node 18+ (`.nvmrc` pins 22; the shell default here may be older, so use `nvm use` or `~/.nvm/versions/node/v22*/bin/node`).

- `days/NN-slug/lesson.md` + `day.json`: one lesson and its interview questions per day. Format in `CONTENT_GUIDE.md`; validate with `npm run check`.
- `answers/<day-id>.json`: the learner's answers, AI feedback and scores (`{ answers, scores, feedback, updatedAt, gradedAt }`).
- `data/progress.json`: days finished, activity, recall schedule, goals.
- `app/shared.js`: rules shared by `server.js` and the static website (`app/static-api.js`), including the grading prompt.

## Grading answers

When the learner asks to grade a day ("grade day 5", "check my answers", or pastes answers), follow `.claude/skills/grade/SKILL.md`: grade against each question's `keyPoints`, then write `feedback`, `scores` and `gradedAt` into `answers/<day-id>.json` so the app shows it.

The learner is a beginner. Be encouraging and honest, explain terms, and use numbers and examples.
