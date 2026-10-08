-- Systems Study: your answers and progress in Supabase (Postgres).
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run again: tables are only created if missing, and policies are replaced.
-- Every table here starts with system_, so it can share a project with Leet Study (leet_*).
-- Upgrading a database made before the system_ prefix? Run rename-to-system-prefix.sql first.
--
-- Every table has a user_id, and Row Level Security (RLS) makes sure each signed-in person
-- only ever sees and changes their own rows. Logged-out visitors (the "anon" role) get nothing.

-- ---------- tables ----------

-- One row per person: name and goals.
create table if not exists public.system_profiles (
  user_id       uuid primary key default auth.uid() references auth.users on delete cascade,
  name          text not null default '',
  days_per_week smallint not null default 5 check (days_per_week between 0 and 7),
  target_date   date,
  target_label  text not null default '',
  custom_goals  jsonb not null default '[]', -- [{ id, text, done }]: a small list we never query, so JSON is fine
  updated_at    timestamptz not null default now()
);

-- Which days you've read and finished.
create table if not exists public.system_day_progress (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day_id  text not null,           -- '14-http'
  done    boolean not null default false,
  done_at date,
  read_at date,
  primary key (user_id, day_id)
);

-- One row per question you answered: the text you wrote and the score it got.
create table if not exists public.system_answers (
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  day_id      text not null,
  question_id text not null,       -- 'q1'
  answer      text not null default '',
  score       numeric(3,1) check (score between 0 and 10), -- null = not graded yet
  updated_at  timestamptz,
  primary key (user_id, day_id, question_id)
);

-- The AI feedback for a day (one markdown text covering all its questions).
create table if not exists public.system_day_feedback (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  day_id    text not null,
  feedback  text not null default '',
  graded_at timestamptz,
  primary key (user_id, day_id)
);

-- Your own notes for a day.
create table if not exists public.system_notes (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  day_id     text not null,
  body       text not null default '',
  markdown   boolean not null default true,
  updated_at timestamptz,
  primary key (user_id, day_id)
);

-- Spaced recall: each question of a finished day is a card that comes back on its due date.
create table if not exists public.system_recall_cards (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  card_id text not null,           -- '14-http#q1'
  box     smallint not null default 0,
  due     date,
  last    date,
  primary key (user_id, card_id)
);
-- "Which cards are due today?" looks up by date instead of scanning every card.
create index if not exists system_recall_cards_due on public.system_recall_cards (user_id, due);

-- What you did each day (streaks and the heatmap).
create table if not exists public.system_activity (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day     date not null,
  days    int not null default 0,  -- days finished
  answers int not null default 0,  -- questions answered for the first time
  graded  int not null default 0,  -- days that got feedback
  reviews int not null default 0,  -- recall cards reviewed
  primary key (user_id, day)
);

-- Your edits to the built-in cheat sheets, and cheat sheets you added (is_new).
create table if not exists public.system_cheatsheets (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  sheet_id   text not null,
  markdown   text not null default '',
  is_new     boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, sheet_id)
);

-- ---------- security: everyone sees only their own rows ----------

do $$
declare t text;
begin
  foreach t in array array['system_profiles', 'system_day_progress', 'system_answers', 'system_day_feedback', 'system_notes', 'system_recall_cards', 'system_activity', 'system_cheatsheets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    -- (select auth.uid()) instead of auth.uid(): Postgres runs it once per query, not once per row
    execute format('create policy "own rows" on public.%I for all to authenticated
                      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
    -- grant explicitly, so it works with "Automatically expose new tables" turned off
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- adding to today's activity ----------

-- Adds to a day's counters in one statement, so two devices counting at the same time
-- both get added (reading the row, adding in JavaScript and writing it back could lose one).
create or replace function public.system_bump_activity(
  p_day date, p_days int default 0, p_answers int default 0, p_graded int default 0, p_reviews int default 0
) returns void
language sql
security invoker -- runs as the caller, so the RLS policy above still applies
set search_path = ''
as $$
  insert into public.system_activity (user_id, day, days, answers, graded, reviews)
  values (auth.uid(), p_day, p_days, p_answers, p_graded, p_reviews)
  on conflict (user_id, day) do update set
    days    = public.system_activity.days    + excluded.days,
    answers = public.system_activity.answers + excluded.answers,
    graded  = public.system_activity.graded  + excluded.graded,
    reviews = public.system_activity.reviews + excluded.reviews;
$$;

revoke execute on function public.system_bump_activity(date, int, int, int, int) from public, anon;
grant execute on function public.system_bump_activity(date, int, int, int, int) to authenticated;
