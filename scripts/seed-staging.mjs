// staging（https://staging.usenagi.dev）の D1「nagi-staging」を、テスト利用者 3 人とそのタスクの状態に初期化する。
// scripts/seed-local.mjs は手元の Worker に /api/mutate で入れるが、staging はログインが要るので、
// wrangler d1 execute --env staging --remote で SQL を直接流す。
//   node scripts/seed-staging.mjs          … いまの行をすべて消してから、種を入れる（何度回しても同じ状態に戻る）
//   node scripts/seed-staging.mjs --print  … 流す SQL を出すだけ（D1 には触らない）
// テスト利用者の GitHub ユーザー ID は架空の値（9000000001〜）で、そのままではログインできない。
// 利用者 1 として GitHub でログインしたいときは、STAGING_TEST_USER_1_GITHUB_ID に自分の ID を渡し、
// wrangler.jsonc の env.staging.vars.ALLOWED_GITHUB_USER_IDS にも同じ ID を足して配備する
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNKeysBetween } from "fractional-indexing";

const STAGING_DB = { name: "nagi-staging", id: "8f5e89a9-19fb-4982-b33a-dc6374731e9e" };
const PRODUCTION_DB_ID = "770a86db-0365-4b58-ab4f-842f1d0684d3";
// src/worker/db/schema.ts の OWNER_USER_ID（migrations/0004 が入れる、利用者を分ける前のデータの持ち主）
const OWNER_USER_ID = "owner";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const unknown = args.filter((arg) => arg !== "--print");
if (unknown.length > 0) {
  console.error(`知らない引数：${unknown.join(" ")}`);
  process.exit(2);
}

/** wrangler.jsonc は // のコメントを含む。文字列の中の // は URL なので、文字列の外のコメントだけ消す */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** `--env staging` で wrangler が解決する D1 が nagi-staging（名前と id の両方）であることを確かめる。本番の id は名指しで断る */
function assertStagingDatabase() {
  const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const databases = config.env?.staging?.d1_databases ?? [];
  if (databases.length !== 1) throw new Error("env.staging.d1_databases が 1 つではありません");
  const { database_name: name, database_id: id } = databases[0];
  if (id === PRODUCTION_DB_ID || config.d1_databases?.some((d) => d.database_id === id)) {
    throw new Error(`env.staging の D1 が本番のデータベース（${id}）です。何も書かずに止めます`);
  }
  if (name !== STAGING_DB.name || id !== STAGING_DB.id) {
    throw new Error(
      `env.staging の D1 が ${STAGING_DB.name}（${STAGING_DB.id}）ではありません：${name}（${id}）`,
    );
  }
}

const quote = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`整数ではありません：${value}`);
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
};

function insert(table, rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const values = rows.map((row) => `(${columns.map((c) => quote(row[c])).join(", ")})`);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values.join(",\n")};\n`;
}

const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const dayOffset = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);

const PRIORITIES = ["high", null, "medium", "low", null];
const POINTS = [1, 2, null, 3, 5, null, 8];

/** 利用者ごとに件数を変える（別の利用者のタスクが見えていないことを、件数と題名で見分けられるように） */
const USERS = [
  { today: 6, inbox: 3, later: 2, scheduled: 2, done: 2 },
  { today: 4, inbox: 2, later: 1, scheduled: 1, done: 1 },
  { today: 2, inbox: 1, later: 1, scheduled: 0, done: 0 },
].map((counts, index) => ({
  ...counts,
  label: `test${index + 1}`,
  id: `staging-user-${index + 1}`,
  githubUserId:
    index === 0 && process.env.STAGING_TEST_USER_1_GITHUB_ID
      ? Number(process.env.STAGING_TEST_USER_1_GITHUB_ID)
      : 9_000_000_001 + index,
}));

for (const user of USERS) {
  if (!Number.isSafeInteger(user.githubUserId) || user.githubUserId <= 0) {
    throw new Error("STAGING_TEST_USER_1_GITHUB_ID は正の整数で渡してください");
  }
}

/** 決まった UUID（画面の API が受ける小文字の UUID の形）。何度回しても同じ ID になる */
const uuid = (userIndex, n) =>
  `00000000-0000-7000-8000-${String(userIndex + 1).padStart(4, "0")}${String(n).padStart(8, "0")}`;

function seedRows(user, userIndex) {
  let seq = 0;
  let n = 0;
  const nextId = () => uuid(userIndex, ++n);
  const timestamps = { created_at: NOW_ISO, updated_at: NOW_ISO, deleted_at: null };

  const projects = ["AIPR", "採用"].map((name) => ({
    user_id: user.id,
    id: nextId(),
    name,
    color: null,
    archived_at: null,
    ...timestamps,
    seq: ++seq,
  }));

  const tasks = [];
  const add = (bucket, count, extra) => {
    const ranks = generateNKeysBetween(null, null, count);
    for (let i = 0; i < count; i++) {
      const k = tasks.length;
      tasks.push({
        user_id: user.id,
        id: nextId(),
        title: `[${user.label}] ${bucket} ${i + 1}`,
        memo: i === 0 ? "https://example.com/doc のメモ" : "",
        bucket,
        scheduled_on: bucket === "scheduled" ? dayOffset(i + 1) : null,
        deadline_on: null,
        project_id: k % 2 === 0 ? projects[k % projects.length].id : null,
        rank: ranks[i],
        arrived_on: null,
        checklist: "[]",
        completed_at: null,
        started_at: null,
        priority: PRIORITIES[k % PRIORITIES.length],
        points: POINTS[k % POINTS.length],
        ...timestamps,
        seq: ++seq,
        ...extra?.(i),
      });
    }
  };
  add("today", user.today);
  add("inbox", user.inbox);
  add("later", user.later);
  add("scheduled", user.scheduled);
  // 完了したタスクは、完了しても bucket を変えない（src/shared/model.ts）
  add("later", user.done, (i) => ({
    title: `[${user.label}] done ${i + 1}`,
    completed_at: new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString(),
  }));

  const metaRows = [
    { user_id: user.id, key: "seq", value: String(seq) },
    { user_id: user.id, key: "last_rollover_on", value: "" },
    { user_id: user.id, key: "purged_through_seq", value: "0" },
  ];
  return { projects, tasks, metaRows };
}

function buildSql() {
  const initialOwnerMeta = [
    { user_id: OWNER_USER_ID, key: "seq", value: "0" },
    { user_id: OWNER_USER_ID, key: "last_rollover_on", value: "" },
    { user_id: OWNER_USER_ID, key: "purged_through_seq", value: "0" },
  ];
  const seeds = USERS.map(seedRows);
  return [
    // 子の表から先に消す。持ち主の行は migrations/0004 が入れたものなので残し、データだけ空にする
    "DELETE FROM applied_mutations;",
    "DELETE FROM user_sessions;",
    "DELETE FROM tasks;",
    "DELETE FROM projects;",
    "DELETE FROM meta;",
    `DELETE FROM users WHERE id <> ${quote(OWNER_USER_ID)};`,
    insert("meta", initialOwnerMeta),
    insert(
      "users",
      USERS.map((u) => ({ id: u.id, github_user_id: u.githubUserId, created_at: NOW_ISO })),
    ),
    insert(
      "meta",
      seeds.flatMap((s) => s.metaRows),
    ),
    insert(
      "projects",
      seeds.flatMap((s) => s.projects),
    ),
    insert(
      "tasks",
      seeds.flatMap((s) => s.tasks),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

const sql = buildSql();
if (printOnly) {
  process.stdout.write(sql);
  process.exit(0);
}

assertStagingDatabase();

const wrangler = (extra) =>
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      STAGING_DB.name,
      "--env",
      "staging",
      "--remote",
      ...extra,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

const dir = mkdtempSync(join(tmpdir(), "nagi-seed-staging-"));
try {
  const file = join(dir, "seed.sql");
  writeFileSync(file, sql);
  wrangler(["--file", file]);
  const counts = JSON.parse(
    wrangler([
      "--json",
      "--command",
      "SELECT u.id AS user_id, (SELECT count(*) FROM tasks t WHERE t.user_id = u.id) AS tasks, (SELECT count(*) FROM projects p WHERE p.user_id = u.id) AS projects FROM users u ORDER BY u.id",
    ]),
  );
  console.log("staging（nagi-staging）を種の状態にしました");
  for (const row of counts[0].results) {
    console.log(`${row.user_id}：タスク ${row.tasks}・プロジェクト ${row.projects}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
