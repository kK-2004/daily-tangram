-- ============================================================
-- 今天你拼了吗 · Supabase 初始化脚本
-- ------------------------------------------------------------
-- 用法：在 Supabase Dashboard → SQL Editor 中执行一次即可。
-- 然后在 GitHub 仓库 Settings → Secrets and variables → Actions 里配置
-- SUPABASE_URL 与 SUPABASE_ANON_KEY，部署时自动注入 index.html
-- （见 .github/workflows/deploy.yml）。
-- ============================================================

-- 1. 完成记录表：每行代表某个浏览器完成了一次当日拼图。
--    每天完成人数 = 当天行数；排名按 created_at 先后；最快 = 当天最小用时。
--    时区约定：day 是前端按北京时间（UTC+8）算好的日历日（与每日
--    拼盘的 day 一致）；created_at 为 timestamptz，底层一律 UTC 存储，
--    排名/最快的比较都基于绝对时间，不受服务器时区影响。
create table if not exists public.completions (
  id              bigint generated always as identity primary key,
  day             date        not null,
  target          text,                 -- 拼的是什么（日期|月日周掩码），便于区分玩法
  elapsed_seconds integer     not null check (elapsed_seconds >= 0),
  created_at      timestamptz not null default now()
);

create index if not exists completions_day_created_idx on public.completions (day, created_at);

alter table public.completions enable row level security;

-- 游戏无登录，放行匿名写入 / 读取；后续接入用户表时可收紧为按用户校验
drop policy if exists "completions anon insert" on public.completions;
create policy "completions anon insert" on public.completions
  for insert to anon with check (true);

drop policy if exists "completions anon select" on public.completions;
create policy "completions anon select" on public.completions
  for select to anon using (true);

-- 2. 一次提交同时返回 排名 / 总人数 / 当日最快，避免前端多次往返。
--    前端优先调用它；若函数缺失，会自动退回 insert + count 查询。
create or replace function public.submit_completion(
  p_day     date,
  p_elapsed integer,
  p_target  text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ts    timestamptz;
  v_rank  integer;
  v_total integer;
  v_best  integer;
begin
  insert into public.completions (day, target, elapsed_seconds)
  values (p_day, p_target, p_elapsed)
  returning created_at into v_ts;

  select count(*) into v_total from public.completions where day = p_day;
  select count(*) into v_rank  from public.completions where day = p_day and created_at <= v_ts;
  select min(elapsed_seconds) into v_best from public.completions where day = p_day;

  return json_build_object('rank', v_rank, 'total', v_total, 'best', v_best);
end;
$$;

grant execute on function public.submit_completion(date, integer, text) to anon, authenticated;

-- ============================================================
-- 2.5 全局累计完成人数
-- ------------------------------------------------------------
-- 每天 0:30（北京时间）由 Cron 把前一天的完成人数累加进
-- global_stats.total_completions；前端展示「累计已有 N 人拼好 ·
-- 上次更新于 …」。
-- 时区：rolled_day 按北京时间取“前一天”（与 completions.day 的
-- 北京日历日一致）；updated_at 为 timestamptz（UTC 存储，前端
-- 转本地时区显示）。
-- ============================================================
create table if not exists public.global_stats (
  id                integer primary key default 1 check (id = 1),
  total_completions bigint not null default 0,
  rolled_day        date,                 -- 最后一次累计到的是哪一天（幂等防重）
  updated_at        timestamptz not null default now()
);

insert into public.global_stats (id) values (1) on conflict do nothing;

alter table public.global_stats enable row level security;

drop policy if exists "stats anon select" on public.global_stats;
create policy "stats anon select" on public.global_stats
  for select to anon using (true);
-- 无匿名写策略：只有下面的 security definer 函数（Cron 调用）能写

-- 把某一天的完成人数累加进全局总数。
-- 幂等：rolled_day 已 >= p_day 时不再累加，Cron 重复跑也不会重复计数。
create or replace function public.rollup_day(p_day date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
  v_found boolean;
begin
  update public.global_stats g
  set total_completions = g.total_completions + c.cnt,
      rolled_day        = p_day,
      updated_at        = now()
  from (select count(*) as cnt from public.completions where day = p_day) c
  where g.id = 1
    and (g.rolled_day is null or g.rolled_day < p_day)
  returning true into v_found;

  select total_completions into v_total from public.global_stats where id = 1;
  return json_build_object('day', p_day, 'total', v_total, 'rolled', coalesce(v_found, false));
end;
$$;

-- ============================================================
-- 3. 每日拼盘表：每天 23:00 由 Edge Function（supabase/functions/gen-daily）
--    生成下一天的全套拼盘写入这里，所有端统一读取；
--    前端取不到时才会回退为本机生成。
-- ============================================================
create table if not exists public.daily_puzzles (
  day        date not null,
  mask       text not null,             -- 月/日/周 哪些露出，如 '111'
  style      text not null,             -- easy / normal / hard
  pieces     jsonb not null,            -- [{cells:[[r,c]...], r0, f0}, ...]
  solution   jsonb not null,            -- [{t:0, gx, gy}, ...]
  created_at timestamptz not null default now(),
  primary key (day, mask, style)
);

alter table public.daily_puzzles enable row level security;

drop policy if exists "daily anon select" on public.daily_puzzles;
create policy "daily anon select" on public.daily_puzzles
  for select to anon using (true);

-- 允许匿名“补插”缺失的每日拼盘（乐观锁式首写生效）：
-- 前端发现连库成功但当日组合为空时，本地生成一份并 upsert
-- （ON CONFLICT DO NOTHING）。只有第一份会插入成功，之后的写入
-- 被忽略；已存在的行没有 update/delete 策略，任何人都无法覆盖，
-- 保证当日已发布的拼盘稳定不被篡改。
drop policy if exists "daily anon insert" on public.daily_puzzles;
create policy "daily anon insert" on public.daily_puzzles
  for insert to anon with check (true);

-- ============================================================
-- 3.5 表级权限
-- ------------------------------------------------------------
-- 新建的 Supabase 项目不再自动给 public 下新表授予 anon /
-- service_role 权限，RLS 策略只在已有表权限的前提下生效；缺这一步
-- 时 REST 请求返回 401「permission denied for table」(42501)。
-- ============================================================
grant select, insert on public.completions   to anon, authenticated;
grant select         on public.global_stats  to anon, authenticated;
grant select, insert on public.daily_puzzles to anon, authenticated;
-- Edge Function 用 service_role 做 upsert（insert + on conflict update）
grant select, insert, update on public.daily_puzzles to service_role;
grant select, insert, update on public.completions, public.global_stats to service_role;

-- ============================================================
-- 4.（可选）定时任务：Dashboard → Integrations → Cron 里创建两个任务
--    （pg_cron 一律按 UTC 调度，注意换算成北京时间）
-- ============================================================
-- 4a. 每天 23:00（北京）生成下一天拼盘：调 Edge Function
--     Schedule: 0 15 * * *        （UTC 15:00 = 北京 23:00）
--     命令类型选 HTTP / Edge Function，请求：
--       POST https://<PROJECT_REF>.supabase.co/functions/v1/gen-daily
--       Header: Authorization: Bearer <SERVICE_ROLE_KEY>
--
-- 4b. 每天 0:30（北京）把前一天完成人数累加进全局总数：
--     直接跑 SQL，无需密钥
--     Schedule: 30 16 * * *        （UTC 16:30 = 北京 0:30）
--     命令类型选 SQL，内容：
--       select public.rollup_day(((now() at time zone 'Asia/Shanghai')::date - 1));
--
-- 方式 B（纯 SQL 建 Cron）：
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule(
--   'gen-daily-puzzle',
--   '0 15 * * *',
--   $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/gen-daily',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
-- select cron.schedule(
--   'rollup-daily-stats',
--   '30 16 * * *',
--   $$ select public.rollup_day(((now() at time zone 'Asia/Shanghai')::date - 1)) $$
-- );
-- ============================================================
