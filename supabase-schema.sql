-- 울트라 오디오 스터디: Supabase 테이블 + 보안(RLS) 설정
-- 사용법: Supabase 대시보드 > SQL Editor > New query 에 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다. (이미 있는 것은 건너뜀)
-- ※ 이 파일은 position(카드 순서) 컬럼까지 포함합니다. supabase-position.sql 은 예전에 만든 테이블용이라 따로 실행할 필요 없어요.

-- ---------------------------------------------------------------
-- 1) 폴더(decks): 앱에서는 "폴더"로 보입니다.
-- ---------------------------------------------------------------
create table if not exists public.decks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 100),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 2) 카드(cards): 폴더를 지우면 안의 카드도 함께 삭제됩니다.
-- ---------------------------------------------------------------
create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  deck_id     uuid not null references public.decks(id) on delete cascade,
  question    text not null,
  answer      text not null,
  explanation text not null default '',
  wrong_count integer not null default 0 check (wrong_count >= 0),
  position    integer,
  kind        text not null default 'qa' check (kind in ('qa', 'note')),  -- qa: 문제·정답 카드, note: 오디오북 항목
  voice       text,                                                       -- 카드별 목소리 id (비어 있으면 기본 목소리 사용)
  media       jsonb not null default '[]'::jsonb,                         -- 첨부 [{type:'image'|'video', path, name, size}] (파일은 Storage 버킷 card-media)
  created_at  timestamptz not null default now()
);

-- 이미 cards 테이블이 있던 경우를 위한 보강
alter table public.cards add column if not exists position integer;
alter table public.cards add column if not exists kind text not null default 'qa';
alter table public.cards add column if not exists voice text;
alter table public.cards add column if not exists media jsonb not null default '[]'::jsonb;
alter table public.cards drop constraint if exists cards_kind_check;
alter table public.cards add constraint cards_kind_check check (kind in ('qa', 'note'));

create index if not exists decks_user_created_idx on public.decks (user_id, created_at);
create index if not exists cards_deck_position_idx on public.cards (deck_id, position, created_at);

-- ---------------------------------------------------------------
-- 3) 보안(RLS): 로그인한 본인 데이터만 보고/고치고/지울 수 있습니다.
-- ---------------------------------------------------------------
alter table public.decks enable row level security;
alter table public.cards enable row level security;

drop policy if exists "decks_select_own" on public.decks;
drop policy if exists "decks_insert_own" on public.decks;
drop policy if exists "decks_update_own" on public.decks;
drop policy if exists "decks_delete_own" on public.decks;

create policy "decks_select_own" on public.decks for select to authenticated
  using (user_id = (select auth.uid()));
create policy "decks_insert_own" on public.decks for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "decks_update_own" on public.decks for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "decks_delete_own" on public.decks for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "cards_select_own" on public.cards;
drop policy if exists "cards_insert_own" on public.cards;
drop policy if exists "cards_update_own" on public.cards;
drop policy if exists "cards_delete_own" on public.cards;

create policy "cards_select_own" on public.cards for select to authenticated
  using (user_id = (select auth.uid()));
-- 카드는 내 폴더에만 추가/이동할 수 있습니다.
create policy "cards_insert_own" on public.cards for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.decks d where d.id = deck_id and d.user_id = (select auth.uid()))
  );
create policy "cards_update_own" on public.cards for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.decks d where d.id = deck_id and d.user_id = (select auth.uid()))
  );
create policy "cards_delete_own" on public.cards for delete to authenticated
  using (user_id = (select auth.uid()));

-- 로그인하지 않은(anon) 사용자는 테이블에 접근할 수 없게 합니다.
revoke all on public.decks from anon;
revoke all on public.cards from anon;
grant select, insert, update, delete on public.decks to authenticated;
grant select, insert, update, delete on public.cards to authenticated;

-- ---------------------------------------------------------------
-- 4) (선택) 예전에 만든 카드가 있다면 순서 번호 채우기
-- ---------------------------------------------------------------
update public.cards c
set position = t.rn
from (
  select id, row_number() over (partition by deck_id order by created_at) - 1 as rn
  from public.cards
) t
where c.id = t.id and c.position is null;
