create extension if not exists vector;

create table if not exists heuristic_rules (
  id text primary key,
  pattern text not null,
  correction text not null,
  active boolean not null default false,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table if not exists secret_store (
  id text primary key,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

create table if not exists workspace_config (
  id integer primary key default 1,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ledger_events (
  id text primary key,
  provider text not null,
  at timestamptz not null,
  status text not null
);

alter table heuristic_rules enable row level security;
alter table secret_store enable row level security;
alter table workspace_config enable row level security;
alter table ledger_events enable row level security;
