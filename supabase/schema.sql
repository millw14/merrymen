-- merrymen_* tables (shared "Sakura" project aofzomovaozcwcozokll; bullone owns bullone_*).
-- Service-role only: RLS enabled with NO policies, matching the bullone pattern.
-- Apply via the Supabase dashboard SQL editor (or ask Claude to apply it with approval).
-- Until applied + SUPABASE_SERVICE_ROLE_KEY is set, the app uses .data/*.jsonl fallback.

create table if not exists merrymen_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Robin',
  smart_account text not null unique,
  owner_address text not null,
  session_key_address text not null,
  chain_id int not null,
  caps jsonb not null,
  granted_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'armed',
  created_at timestamptz not null default now()
);

create table if not exists merrymen_events (
  id bigint generated always as identity primary key,
  agent_id uuid not null references merrymen_agents(id) on delete cascade,
  level text not null default 'ok',
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists merrymen_events_agent_time on merrymen_events (agent_id, created_at desc);

create table if not exists merrymen_trades (
  id bigint generated always as identity primary key,
  agent_id uuid not null references merrymen_agents(id) on delete cascade,
  kind text not null,
  target text not null,
  sell_token text,
  buy_token text,
  amount_usdg numeric not null,
  user_op_hash text,
  tx_hash text,
  status text not null default 'pending',
  reject_rule text,
  created_at timestamptz not null default now()
);
create index if not exists merrymen_trades_agent_time on merrymen_trades (agent_id, created_at desc);

create table if not exists merrymen_equity (
  id bigint generated always as identity primary key,
  agent_id uuid not null references merrymen_agents(id) on delete cascade,
  eth_wei numeric not null,
  cash_usdg numeric not null,
  vault_usdg numeric not null,
  equity_usdg numeric not null,
  at timestamptz not null default now()
);
create index if not exists merrymen_equity_agent_time on merrymen_equity (agent_id, at desc);

alter table merrymen_agents enable row level security;
alter table merrymen_events enable row level security;
alter table merrymen_trades enable row level security;
alter table merrymen_equity enable row level security;
