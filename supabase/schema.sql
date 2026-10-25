-- Supabase SQL Editor で1回実行する。

-- 1行 = 1レコード。store は IndexedDB の店名（items, sales など）。
create table if not exists public.records (
  store text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (store, id)
);

create index if not exists records_updated_at_idx on public.records (updated_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists records_set_updated_at on public.records;
create trigger records_set_updated_at
before insert or update on public.records
for each row execute function public.set_updated_at();

alter table public.records enable row level security;

grant select, insert, update, delete on public.records to authenticated;

drop policy if exists "owner access records" on public.records;
create policy "owner access records" on public.records
  for all to authenticated
  using (true)
  with check (true);

-- 写真本体。非公開バケットで、ログイン済みユーザーだけが扱える。
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "owner access photos" on storage.objects;
create policy "owner access photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'photos')
  with check (bucket_id = 'photos');
