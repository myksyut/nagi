// 速さの確認用のデータを、手元のサーバー（http://localhost:5317、.dev.vars の AUTH_DISABLED=true）の
// /api/mutate で入れる。送り先は localhost だけで、本番の D1 には触らない（README「速さの確認」）。
//   node scripts/seed-local.mjs today100     … 今日に 100 件、受信箱とあとでに 10 件ずつ、プロジェクト 2 つ
//                                              （優先度と工数は一部のタスクにだけ付ける）
//   node scripts/seed-local.mjs fill 20000   … タスクの合計がこの件数になるまで、完了ログ（過去 2 年に散らばる完了）を足す
// ほかのポートで動かしているときは SEED_PORT=5319 のように渡す
import { readFileSync } from "node:fs";
import { generateNKeysBetween } from "fractional-indexing";

const BASE = `http://localhost:${process.env.SEED_PORT ?? "5317"}`;

/**
 * API の版は src/shared/api.ts の API_VERSION を読んで使う（古いまま残って 409 にならないように）。
 * api.ts は TypeScript で、zod などを import しているので、ここでは import せずに文字として読み取る
 */
function readApiVersion() {
  const source = readFileSync(new URL("../src/shared/api.ts", import.meta.url), "utf8");
  const match = source.match(/^export const API_VERSION = (\d+);$/m);
  if (!match) throw new Error("src/shared/api.ts から API_VERSION を読み取れませんでした");
  return match[1];
}
const API_VERSION = readApiVersion();
const [mode = "today100", countArg] = process.argv.slice(2);

let seq = 0;
function uuidv7() {
  const now = Date.now() + seq++;
  const hex = now.toString(16).padStart(12, "0");
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const r = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${r.slice(0, 3)}-${((parseInt(r.slice(3, 4), 16) & 0x3) | 0x8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

async function api(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Origin: BASE,
      "Content-Type": "application/json",
      "X-Api-Version": API_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
  return response.json();
}

async function send(mutations) {
  for (let i = 0; i < mutations.length; i += 500) {
    await api("/api/mutate", { id: uuidv7(), mutations: mutations.slice(i, i + 500) });
  }
}

async function countRows() {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const page = await api("/api/sync", { cursor, baseCursor: 0 });
    total += page.rows.filter((row) => row.kind === "task").length;
    if (!page.hasMore) return total;
    cursor = page.nextCursor;
  }
}

const TITLES = [
  "請求書の確認",
  "見積もりを送る",
  "週次の振り返り",
  "資料のレビュー",
  "Slack の返信",
  "採用の面談の準備",
  "経費の精算",
  "議事録をまとめる",
  "デプロイの確認",
  "契約書を読む",
];
const title = (i) => `${TITLES[i % TITLES.length]} ${i + 1}`;

if (mode === "today100") {
  const project = { id: uuidv7(), name: "AIPR" };
  const project2 = { id: uuidv7(), name: "採用" };
  const mutations = [
    { type: "project.create", project },
    { type: "project.create", project: project2 },
  ];
  const task = (fields) => ({ type: "task.create", task: { id: uuidv7(), ...fields } });
  // 優先度と工数は一部のタスクにだけ付ける（なしも残す）。値は src/shared/priority-points.ts と同じ
  const PRIORITY_CYCLE = ["high", null, "medium", "low", null];
  const POINTS_CYCLE = [1, 2, null, 3, 5, null, 8, 13, null];
  const estimate = (i) => ({
    priority: PRIORITY_CYCLE[i % PRIORITY_CYCLE.length],
    points: POINTS_CYCLE[i % POINTS_CYCLE.length],
  });
  mutations.push(
    ...generateNKeysBetween(null, null, 100).map((rank, i) =>
      task({
        title: title(i),
        bucket: "today",
        rank,
        projectId: i % 3 === 0 ? project.id : i % 5 === 0 ? project2.id : null,
        memo: i % 7 === 0 ? "https://example.com/doc のメモ" : "",
        ...estimate(i),
      }),
    ),
    ...generateNKeysBetween(null, null, 10).map((rank, i) =>
      task({ title: `受信箱 ${i + 1}`, bucket: "inbox", rank, ...estimate(i * 2 + 1) }),
    ),
    ...generateNKeysBetween(null, null, 10).map((rank, i) =>
      task({
        title: `あとで ${i + 1}`,
        bucket: "later",
        rank,
        projectId: project.id,
        ...estimate(i + 3),
      }),
    ),
  );
  await send(mutations);
  const withPriority = mutations.filter((m) => m.task?.priority).length;
  const withPoints = mutations.filter((m) => m.task?.points).length;
  console.log(
    `入れた：今日 100・受信箱 10・あとで 10・プロジェクト 2（優先度あり ${withPriority}・工数あり ${withPoints}）`,
  );
} else if (mode === "fill") {
  const target = Number(countArg ?? 20000);
  const have = await countRows();
  const need = Math.max(0, target - have);
  // あとでの 10 件（a0〜a9）より後ろの並び。完了したタスクは今日や受信箱の並べ替えに関わらないよう、あとでに置く
  const ranks = generateNKeysBetween("a9", null, need);
  const now = Date.now();
  const mutations = [];
  for (let i = 0; i < need; i++) {
    const id = uuidv7();
    // 昨日から2年前までに散らばる完了
    const completedAt = new Date(
      now - (1 + Math.floor((i / need) * 730)) * 86_400_000 - (i % 600) * 60_000,
    ).toISOString();
    mutations.push({
      type: "task.create",
      task: { id, title: title(i), bucket: "later", rank: ranks[i] },
    });
    mutations.push({ type: "task.update", id, changes: { completedAt } });
  }
  await send(mutations);
  console.log(`入れた：完了 ${need} 件（合計 ${have + need} 件）`);
}
