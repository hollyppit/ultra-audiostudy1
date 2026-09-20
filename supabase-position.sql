-- 카드 순서(드래그 정렬)를 저장하려면 Supabase 대시보드 > SQL Editor 에서 한 번만 실행하세요.
-- 실행하지 않아도 앱은 동작하지만, 순서는 만든 순서로만 보입니다. (로컬 모드는 실행 불필요)
alter table public.cards add column if not exists position integer;

-- 기존 카드에 현재 순서(만든 순서)대로 번호를 채웁니다.
update public.cards c
set position = t.rn
from (
  select id, row_number() over (partition by deck_id order by created_at) - 1 as rn
  from public.cards
) t
where c.id = t.id and c.position is null;
