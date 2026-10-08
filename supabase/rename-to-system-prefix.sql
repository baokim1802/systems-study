-- One-time upgrade: give the Systems Study tables a system_ prefix (2026-10-07).
-- Only for a database created before the prefix. A new database just runs schema.sql.
--
-- In Supabase → SQL Editor → New query: paste this file and Run, then paste schema.sql and Run.
-- Renaming keeps every row, and the RLS policies and grants move with the table.
-- Safe to run twice: anything already renamed is skipped.

begin;

alter table if exists public.profiles     rename to system_profiles;
alter table if exists public.day_progress rename to system_day_progress;
alter table if exists public.answers      rename to system_answers;
alter table if exists public.day_feedback rename to system_day_feedback;
alter table if exists public.notes        rename to system_notes;
alter table if exists public.recall_cards rename to system_recall_cards;
alter table if exists public.activity     rename to system_activity;
alter table if exists public.cheatsheets  rename to system_cheatsheets;

alter index if exists public.recall_cards_due rename to system_recall_cards_due;

-- The old function writes to public.activity, which no longer exists.
-- schema.sql creates system_bump_activity in its place.
drop function if exists public.bump_activity(date, int, int, int, int);

commit;
