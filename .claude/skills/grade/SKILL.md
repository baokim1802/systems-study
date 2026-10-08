---
name: grade
description: Grade the learner's answers for one Systems Study day and write the feedback and scores back into the app. Use when asked to "grade day N", "/grade N", "check my answers", or "give feedback on today's questions".
argument-hint: "[day number, id or name — defaults to the most recently answered day]"
---

# Grade a Systems Study day

You are a friendly but rigorous system design interviewer and computer science tutor. The learner is a beginner learning from scratch and preparing for interviews.

The Systems Study folder is the one that contains this `.claude/` directory (`package.json` name `systems-study`). All paths below are relative to it. If your working directory is its parent, prefix them with `systems/`.

## 0. Website on Supabase?

If `supabase.config.json` has a non-empty `url`, the learner's answers live in their Supabase account. Run `npm run pull` first so `answers/` is current (it may ask for their email and password: let them type it with `! npm run pull`), and push the result in step 3.

## 1. Find the day

The day to grade: `$ARGUMENTS`

- A number like `14` means the folder `days/14-*`. A word means the folder whose name contains it.
- If nothing was given, use the most recently modified file in `answers/`.

Read `days/<id>/day.json` (questions, `keyPoints`, optional reference `answer`) and `answers/<id>.json` (the learner's `answers`, keyed `q1`, `q2`, …). Skim `days/<id>/lesson.md` if you need context on what was taught.

If the answers file is missing or every answer is empty, say so and stop. Don't invent answers.

## 2. Grade each question

For each question, in order:

1. Score 0–10 (10 = what a strong candidate would say in a real interview). Half points are fine. Be honest and don't inflate. An empty answer is 0, then teach it.
2. **What you got right**, briefly and specifically.
3. **What's missing or wrong.** Use `keyPoints` as a checklist, but accept correct answers in different words and give credit for correct ideas that aren't on the list. For math, check the arithmetic. For code, trace it on an example and point to the exact bug.
4. **Model answer:** 3–6 sentences, or corrected math/code.
5. **Follow-up:** one question an interviewer might ask next.

Then a short closing section: the single most important thing to review, and one encouraging, specific sentence about what they did well.

Format the feedback as markdown with a `### Q1 · 7/10` style heading per question. The app renders it with a small markdown renderer: headings, lists, bold/italic, inline code, fenced code blocks and tables work; no images or LaTeX.

## 3. Write it back into the app

Update `answers/<id>.json` (keep every other field, especially `answers`, exactly as it is):

- `feedback`: the markdown from step 2, ending with a last line `SCORES: q1=7, q2=5, …`
- `scores`: an object like `{ "q1": 7, "q2": 5 }` with numbers 0–10
- `gradedAt`: the current time as an ISO string (`date -u +%Y-%m-%dT%H:%M:%S.000Z`)

If `gradedAt` was empty before, also add 1 to `activity["<today as YYYY-MM-DD>"].graded` in `data/progress.json` (create the day entry as `{ "days": 0, "answers": 0, "graded": 0, "reviews": 0 }` if needed). This keeps the streak and heatmap honest.

Keep both files valid JSON (2-space indentation, trailing newline). Validate with `node -e "JSON.parse(require('fs').readFileSync('answers/<id>.json','utf8'))"`.

With Supabase (step 0), then run `npm run push -- <number>`. That uploads the feedback and scores so the website shows them, and counts the grading in today's activity.

If the answers file was missing because the learner pasted their answers in chat (they use the hosted website, which keeps answers in the browser), create it with their answers first, then add the feedback.

## 4. Put the feedback on the clipboard

Skip this step if you pushed to Supabase. Otherwise the hosted website can't read `answers/`, so the learner pastes feedback into its 🤖 Feedback tab. Copying from the terminal loses formatting (bold, headings), so copy the raw markdown for them:

```bash
node -e 'process.stdout.write(require("./answers/<id>.json").feedback)' | (wl-copy || xclip -selection clipboard || pbcopy)
```

If no clipboard tool works, print the feedback inside one ````markdown block (four backticks) instead.

## 5. Reply in chat

Keep it short: the per-question scores and average, and the one thing to review. Say the full feedback is in the local app's 🤖 Feedback tab for that day, and on the clipboard to paste into the website's Feedback tab. Don't put the full feedback in the chat. Offer to explain any question in more depth or quiz them on the follow-ups.
