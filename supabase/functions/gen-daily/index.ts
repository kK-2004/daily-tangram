// ============================================================
// gen-daily —— 每天 23:00 生成下一天的全套拼盘，写入 daily_puzzles
// ------------------------------------------------------------
// 由 Cron 调用（见 supabase-setup.sql 第 4 节），也可手动补跑：
//   POST https://<PROJECT_REF>.supabase.co/functions/v1/gen-daily
//   POST .../gen-daily?day=2026-11-05        （指定日期，用于补数据）
// 鉴权：必须携带 service role JWT：
//   Authorization: Bearer <SERVICE_ROLE_KEY>
//
// 生成算法与前端 index.html 保持一致（切分多连块 + 嵌入式答案），
// 每个日期生成 3 种难度 × 8 种「拼什么」组合，所有玩家统一读取。
// 注意：若以后调整难度数值，请同步修改 index.html 里的 STYLES。
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TZ = "Asia/Shanghai"; // 按哪个时区计算“下一天”
const STYLES: Record<string, [number, number]> = {
  easy: [5, 7],
  normal: [4, 6],
  hard: [3, 5],
};
const MASKS = ["111", "110", "101", "011", "100", "010", "001", "000"];
const ROWS = 8, COLS = 7;

const key = (r: number, c: number) => r + "," + c;
const monthPos = (m: number): [number, number] => [Math.floor(m / 6), m % 6];
const dayPos = (d: number): [number, number] => [2 + Math.floor((d - 1) / 7), (d - 1) % 7];
const weekPos = (w: number): [number, number] => (w <= 3 ? [6, 3 + w] : [7, w]);

// 棋盘 50 格：12 个月 + 31 天 + 7 个星期
const CELLS: string[] = [];
for (let m = 0; m < 12; m++) CELLS.push(key(...monthPos(m)));
for (let d = 1; d <= 31; d++) CELLS.push(key(...dayPos(d)));
for (let w = 0; w < 7; w++) CELLS.push(key(...weekPos(w)));

function dateInTz(tz: string, offsetDays = 0): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return f.format(new Date(Date.now() + offsetDays * 86400000)); // en-CA → YYYY-MM-DD
}

function coverKeys(day: string, mask: string): string[] {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ex = new Set<string>();
  if (mask[0] === "1") ex.add(key(...monthPos(m - 1)));
  if (mask[1] === "1") ex.add(key(...dayPos(d)));
  if (mask[2] === "1") ex.add(key(...weekPos(weekday)));
  return CELLS.filter((k) => !ex.has(k));
}

function transform(cells: number[][], rot: number, flip: boolean): number[][] {
  let out = cells.map(([r, c]) => [r, flip ? -c : c]);
  for (let k = 0; k < rot; k++) out = out.map(([r, c]) => [c, -r]);
  let mr = Infinity, mc = Infinity;
  for (const [r, c] of out) { if (r < mr) mr = r; if (c < mc) mc = c; }
  return out.map(([r, c]) => [r - mr, c - mc]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function canonKey(cells: number[][]): string {
  let best: string | null = null;
  for (let t = 0; t < 8; t++) {
    const k = JSON.stringify(transform(cells, t % 4, t >= 4));
    if (best === null || k < best) best = k;
  }
  return best!;
}

// 把覆盖区随机切分成大小在 [mn, mx] 的多连块（与前端 partition 相同）
function partition(cellKeys: string[], mn: number, mx: number): string[][] | null {
  const all = new Set(cellKeys);
  const NB = new Map<string, string[]>();
  for (const k of all) {
    const [r, c] = k.split(",").map(Number);
    NB.set(k, [key(r - 1, c), key(r + 1, c), key(r, c - 1), key(r, c + 1)].filter((n) => all.has(n)));
  }
  const feasible = (s: number) => Math.ceil(s / mx) <= Math.floor(s / mn);
  const comps = (free: Set<string>) => {
    const seen = new Set<string>(), sizes: number[] = [];
    for (const k of free) {
      if (seen.has(k)) continue;
      let n = 0;
      const st = [k];
      seen.add(k);
      while (st.length) {
        const x = st.pop()!;
        n++;
        for (const y of NB.get(x)!) if (free.has(y) && !seen.has(y)) { seen.add(y); st.push(y); }
      }
      sizes.push(n);
    }
    return sizes;
  };
  const freeDeg = (k: string, free: Set<string>) => {
    let n = 0;
    for (const y of NB.get(k)!) if (free.has(y)) n++;
    return n;
  };

  let best: string[][] | null = null, bestScore = Infinity;
  for (let att = 0; att < 4000; att++) {
    const free = new Set(all), out: string[][] = [];
    let ok = true;
    while (free.size) {
      if (free.size >= mn && free.size <= mx && comps(free).length === 1) { out.push([...free]); free.clear(); break; }
      let start: string | null = null, bd = Infinity;
      for (const k of free) { const d = freeDeg(k, free) + Math.random() * 0.9; if (d < bd) { bd = d; start = k; } }
      const target = mn + Math.floor(Math.random() * (mx - mn + 1));
      const piece = [start!];
      free.delete(start!);
      while (piece.length < target) {
        const cand = new Set<string>();
        for (const k of piece) for (const n of NB.get(k)!) if (free.has(n)) cand.add(n);
        if (!cand.size) break;
        let pick: string | null = null, ps = Infinity;
        for (const n of cand) { const s = freeDeg(n, free) + Math.random() * 2.4; if (s < ps) { ps = s; pick = n; } }
        piece.push(pick!);
        free.delete(pick!);
      }
      if (piece.length < mn) { ok = false; break; }
      if (comps(free).some((s) => !feasible(s))) { ok = false; break; }
      out.push(piece);
    }
    if (!ok) continue;
    const cnt = new Map<string, number>();
    out.forEach((pc) => {
      const k = canonKey(pc.map((s) => s.split(",").map(Number)));
      cnt.set(k, (cnt.get(k) || 0) + 1);
    });
    let score = 0;
    cnt.forEach((v) => (score += v - 1));
    if (score < bestScore) { best = out; bestScore = score; if (score === 0) break; }
    if (att > 800 && best) break;
  }
  return best;
}

interface Puzzle {
  pieces: { cells: number[][]; r0: number; f0: boolean }[];
  solution: { t: number; gx: number; gy: number }[];
}

// 生成某天某组合的拼盘；答案直接内嵌（切分位置即解），保证有解
function buildPuzzle(day: string, mask: string, style: string): Puzzle | null {
  const [mn, mx] = STYLES[style];
  const parts = partition(coverKeys(day, mask), mn, mx);
  if (!parts) return null;
  const pieces: Puzzle["pieces"] = [];
  const solution: Puzzle["solution"] = [];
  parts.forEach((pc) => {
    const abs = pc.map((s) => s.split(",").map(Number));
    const minR = Math.min(...abs.map((a) => a[0]));
    const minC = Math.min(...abs.map((a) => a[1]));
    const cells = abs.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    pieces.push({ cells, r0: Math.floor(Math.random() * 4), f0: Math.random() < 0.5 });
    solution.push({ t: 0, gx: minC, gy: minR });
  });
  const idx = pieces.map((_, i) => i).sort(() => Math.random() - 0.5);
  return { pieces: idx.map((i) => pieces[i]), solution: idx.map((i) => solution[i]) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // 只允许 service role 调用（Cron / 手动补跑），不给匿名触发
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.endsWith(serviceKey)) return json({ error: "forbidden" }, 401);

  const url = new URL(req.url);
  const day = url.searchParams.get("day") ?? dateInTz(TZ, 1); // 默认：TZ 的下一天
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "bad day, want YYYY-MM-DD" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const rows: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (const style of Object.keys(STYLES)) {
    for (const mask of MASKS) {
      const p = buildPuzzle(day, mask, style);
      if (!p) { failed.push(style + "/" + mask); continue; }
      rows.push({ day, mask, style, pieces: p.pieces, solution: p.solution });
    }
  }
  if (rows.length) {
    const { error } = await admin.from("daily_puzzles").upsert(rows, { onConflict: "day,mask,style" });
    if (error) return json({ error: error.message }, 500);
  }
  return json({ day, generated: rows.length, failed });
});
