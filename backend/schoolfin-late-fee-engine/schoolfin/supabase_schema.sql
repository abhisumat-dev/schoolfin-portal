-- ============================================================
-- SchoolFin — Supabase schema
-- Run this once in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ------------------------------------------------------------
-- 1. STUDENTS
-- ------------------------------------------------------------
create table if not exists public.students (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  grade              text,
  parent_name        text,
  phone              text,
  balance            numeric not null default 0,
  days_overdue       integer not null default 0,
  reminders_ignored  integer not null default 0,
  status             text not null default 'active',   -- active | cleared | waiver_approved | defaulter
  risk_score         numeric not null default 0,        -- kept in sync by trigger below, don't set manually
  created_at         timestamptz not null default now()
);

-- Mirrors your client-side riskScore(): (days_overdue*1.5) + (min(balance,100000)/1000) + (reminders_ignored*6)
create or replace function public.compute_risk_score()
returns trigger as $$
begin
  new.risk_score := least(
    100,
    (new.days_overdue * 1.5) + (least(new.balance, 100000) / 1000) + (new.reminders_ignored * 6)
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_students_risk_score on public.students;
create trigger trg_students_risk_score
  before insert or update on public.students
  for each row execute function public.compute_risk_score();

-- Needed so Realtime UPDATE payloads include full old+new row (your initRealtime UPDATE listener needs this)
alter table public.students replica identity full;

create index if not exists idx_students_risk_score on public.students (risk_score desc);


-- ------------------------------------------------------------
-- 2. TRANSACTIONS
-- ------------------------------------------------------------
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid references public.students(id) on delete set null,
  invoice_id      uuid,
  amount          numeric not null,
  payment_method  text not null,             -- upi | cheque | cash
  status          text not null default 'completed',
  client_uuid     uuid not null,             -- dedupes retried offline-sync writes
  source          text not null,             -- online | ocr_match | offline_sync
  created_at      timestamptz not null default now(),
  unique (client_uuid)                       -- idempotency: retrying an offline sync won't double-count
);

create index if not exists idx_transactions_student_id on public.transactions (student_id);
create index if not exists idx_transactions_created_at on public.transactions (created_at desc);

-- Replicates what your mock-mode insertTransaction() does manually (lines 836-841):
-- decrement balance, clear status + reset overdue counters when balance hits 0.
create or replace function public.apply_transaction_to_student()
returns trigger as $$
begin
  update public.students
  set
    balance           = greatest(0, balance - new.amount),
    status            = case when (balance - new.amount) <= 0 then 'cleared' else status end,
    days_overdue      = case when (balance - new.amount) <= 0 then 0 else days_overdue end,
    reminders_ignored = case when (balance - new.amount) <= 0 then 0 else reminders_ignored end
  where id = new.student_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_transactions_apply_to_student on public.transactions;
create trigger trg_transactions_apply_to_student
  after insert on public.transactions
  for each row execute function public.apply_transaction_to_student();


-- ------------------------------------------------------------
-- 3. FEE RULES
-- ------------------------------------------------------------
create table if not exists public.fee_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  conditions  jsonb not null,   -- [{ field, op, value }, ...]
  action      jsonb not null,   -- { type, value, unit }
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_fee_rules_created_at on public.fee_rules (created_at desc);


-- ------------------------------------------------------------
-- 4. AUDIT LOGS
-- ------------------------------------------------------------
create table if not exists public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  action_type  text not null,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);


-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ------------------------------------------------------------
-- Hackathon-mode policies: anon key gets full read/write on all four tables.
-- This is fine for a demo (no auth flow in your frontend), but call this out
-- explicitly to judges/reviewers — it is NOT production-safe as-is. A real
-- deployment would scope these to authenticated staff roles.
-- ============================================================
alter table public.students     enable row level security;
alter table public.transactions enable row level security;
alter table public.fee_rules    enable row level security;
alter table public.audit_logs   enable row level security;

create policy "anon full access" on public.students
  for all using (true) with check (true);
create policy "anon full access" on public.transactions
  for all using (true) with check (true);
create policy "anon full access" on public.fee_rules
  for all using (true) with check (true);
create policy "anon full access" on public.audit_logs
  for all using (true) with check (true);


-- ============================================================
-- 6. REALTIME — required for your initRealtime() subscription to fire
-- ============================================================
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.students;


-- ============================================================
-- 7. SEED DATA — mirrors your generateMockStudents()/generateMockFeeRules()
--    so the dashboard isn't empty on first live load. Safe to skip/edit.
-- ============================================================
insert into public.students (name, grade, parent_name, phone, balance, days_overdue, reminders_ignored, status)
values
  ('Aarav Mehta',      'Grade 3-A', 'Mehta A. (Parent)',   '+91 91000000',  0,     0,  0, 'cleared'),
  ('Diya Sharma',      'Grade 4-B', 'Sharma D. (Parent)',  '+91 91076543',  4500,  12, 1, 'active'),
  ('Vihaan Iyer',      'Grade 5-A', 'Iyer V. (Parent)',    '+91 91153086',  12000, 45, 3, 'active'),
  ('Ananya Reddy',     'Grade 6-C', 'Reddy A. (Parent)',   '+91 91229629',  800,   3,  0, 'active'),
  ('Kabir Nair',       'Grade 7-B', 'Nair K. (Parent)',    '+91 91306172',  18500, 60, 4, 'defaulter'),
  ('Ishita Rao',       'Grade 8-A', 'Rao I. (Parent)',     '+91 91382715',  0,     0,  0, 'cleared'),
  ('Reyansh Gupta',    'Grade 3-A', 'Gupta R. (Parent)',   '+91 91459258',  25000, 90, 6, 'defaulter'),
  ('Myra Pillai',      'Grade 4-B', 'Pillai M. (Parent)',  '+91 91535801',  3200,  8,  0, 'active'),
  ('Arjun Verma',      'Grade 5-A', 'Verma A. (Parent)',   '+91 91612344',  0,     0,  0, 'cleared'),
  ('Sara Khan',        'Grade 6-C', 'Khan S. (Parent)',    '+91 91688887',  9800,  22, 1, 'active'),
  ('Vivaan Joshi',     'Grade 7-B', 'Joshi V. (Parent)',   '+91 91765430',  15600, 55, 3, 'active'),
  ('Anika Menon',      'Grade 8-A', 'Menon A. (Parent)',   '+91 91841973',  0,     0,  0, 'cleared'),
  ('Advait Kulkarni',  'Grade 3-A', 'Kulkarni A. (Parent)','+91 91918516',  32000, 120,6, 'defaulter'),
  ('Riya Chatterjee',  'Grade 4-B', 'Chatterjee R. (Parent)','+91 91995059',6100,  15, 1, 'active'),
  ('Dhruv Malhotra',   'Grade 5-A', 'Malhotra D. (Parent)','+91 92071602',  1200,  5,  0, 'active')
on conflict do nothing;

insert into public.fee_rules (name, conditions, action, is_active)
values
  ('Late Penalty (>15 Days Overdue)',
   '[{"field":"days_overdue","op":">","value":15},{"field":"status","op":"!=","value":"waiver_approved"}]',
   '{"type":"compound_penalty","value":2,"unit":"percent"}',
   true),
  ('Severe Defaulter Escalation',
   '[{"field":"days_overdue","op":">=","value":60},{"field":"reminders_ignored","op":">=","value":3}]',
   '{"type":"flag_defaulter","value":0,"unit":"percent"}',
   true)
on conflict do nothing;
