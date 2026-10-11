import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appliedMutations, meta, projects, sessions, tasks, users } from "../db/schema";

/**
 * 利用者と、その行をすべて消す（1 回の batch。途中で止まって、行だけが残ることはない）。
 * 外部キーは ON DELETE NO ACTION なので、子の表から順に消し、最後に users を消す。
 * applied_mutations は日数で消さないので（schema.ts）、ここで消さないと利用者の ID が残り続ける
 */
export async function deleteAccount(db: Db, userId: string): Promise<void> {
  await db.batch([
    db.delete(tasks).where(eq(tasks.userId, userId)),
    db.delete(projects).where(eq(projects.userId, userId)),
    db.delete(appliedMutations).where(eq(appliedMutations.userId, userId)),
    db.delete(meta).where(eq(meta.userId, userId)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db.delete(users).where(eq(users.id, userId)),
  ]);
}
