import { APP_TIME_ZONE, logicalDate } from "@shared/logical-date";
import type { Task } from "@shared/model";
import { arrivalRanks } from "@shared/rank";
import { FakeServer } from "@/test/fake-server";

/**
 * FakeServer に、日付の切り替え（`src/worker/sync/rollover.ts` と同じ決まり）を足したもの。
 * 本物のサーバーは /api/sync の最初に切り替えを行うので、ここも /api/sync の直前に行う。
 * 未完了・未削除で、今日の置き場になく、予定の日付か締切が今日以前のタスクを、
 * 「今日来たタスクの後ろ、それ以外の前」へ日付の早い順・作成順・id の順で移す。
 * setupApp(path, server) にそのまま渡せる（fetch の形は変えない）
 */
export class RolloverFakeServer extends FakeServer {
  #lastRolloverOn: string | null = null;

  constructor() {
    super();
    // fetch は基底クラスで readonly な入力欄（インスタンスのフィールド）として作られるので、
    // ここではその場で包み直す（型だけ緩めて上書きする）
    const baseFetch = this.fetch;
    (this as { fetch: typeof fetch }).fetch = async (input, init) => {
      if (pathOf(input) === "/api/sync") this.#rolloverIfDue();
      return baseFetch(input, init);
    };
  }

  #rolloverIfDue(): void {
    const today = logicalDate(this.now(), APP_TIME_ZONE);
    if (this.#lastRolloverOn !== null && this.#lastRolloverOn >= today) return;

    const isDue = (task: Task) =>
      task.completedAt === null &&
      task.deletedAt === null &&
      task.bucket !== "today" &&
      ((task.scheduledOn !== null && task.scheduledOn <= today) ||
        (task.deadlineOn !== null && task.deadlineOn <= today));

    const candidates = Array.from(this.tasks.values()).filter(isDue);
    if (candidates.length === 0) {
      this.#lastRolloverOn = today;
      return;
    }

    const arrivalDate = (task: Task): string => {
      const dates = [task.scheduledOn, task.deadlineOn].filter(
        (date): date is string => date !== null && date <= today,
      );
      return dates.reduce((a, b) => (a < b ? a : b));
    };

    candidates.sort((a, b) => {
      const dateA = arrivalDate(a);
      const dateB = arrivalDate(b);
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const todayTasks = Array.from(this.tasks.values()).filter(
      (task) => task.bucket === "today" && task.completedAt === null && task.deletedAt === null,
    );
    const ranks = arrivalRanks(todayTasks, today, candidates.length);
    candidates.forEach((task, i) => {
      this.putTask({
        id: task.id,
        bucket: "today",
        scheduledOn: null,
        arrivedOn: today,
        rank: ranks[i],
      });
    });
    this.#lastRolloverOn = today;
  }
}

function pathOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url, "http://localhost").pathname;
}
