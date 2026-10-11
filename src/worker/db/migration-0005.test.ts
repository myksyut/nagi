import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * migrations/0005_user_time_zone.sql の確認。DB とは別の空の D1（MIGRATION_0005_TEST_DB）に 0004 まで当てて
 * 利用者を入れてから、0005 を当てる。行は残り、time_zone は NULL（APP_TIMEZONE として扱う）
 */
describe("マイグレーション 0005：利用者のタイムゾーン", () => {
  it("0004 まで当てた D1 に行があっても、0005 を当てると行は残り、time_zone は NULL", async () => {
    const raw = env.MIGRATION_0005_TEST_DB;
    const all = async (sql: string) => (await raw.prepare(sql).all()).results;

    await applyD1Migrations(raw, env.TEST_MIGRATIONS.slice(0, 5));
    // 前の状態が残っていて、当てずに通ってしまうのを防ぐ
    expect((await all("PRAGMA table_info(users)")).map((row) => row.name)).not.toContain(
      "time_zone",
    );

    const createdAt = "2026-01-01T00:00:00.000Z";
    await raw
      .prepare("INSERT INTO users (id, github_user_id, created_at) VALUES (?, ?, ?)")
      .bind("u-1", 4242, createdAt)
      .run();

    await applyD1Migrations(raw, env.TEST_MIGRATIONS);

    expect(
      await all("SELECT id, github_user_id, created_at, time_zone FROM users ORDER BY id"),
    ).toEqual([
      { id: "owner", github_user_id: null, created_at: expect.any(String), time_zone: null },
      { id: "u-1", github_user_id: 4242, created_at: createdAt, time_zone: null },
    ]);
  });
});
