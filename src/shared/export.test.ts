import { describe, expect, it } from "vitest";
import { exportSchema } from "./export";

/** `nagi export`（端末のデータ）の出力の見本。まだ Worker にない行は seq が 0 */
const SAMPLE = `{
  "format": "nagi-export",
  "formatVersion": 1,
  "exportedAt": "2026-10-12T03:04:05.678Z",
  "app": "nagi 0.4.0",
  "projects": [
    {
      "id": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
      "name": "仕事",
      "color": null,
      "archivedAt": "2026-10-01T00:00:00.000Z",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "updatedAt": "2026-10-01T00:00:00.000Z",
      "deletedAt": null,
      "seq": 2
    }
  ],
  "tasks": [
    {
      "id": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
      "title": "報告書\\n全角　空白と絵文字😀",
      "memo": "",
      "bucket": "scheduled",
      "scheduledOn": "2026-10-20",
      "deadlineOn": "2026-10-25",
      "projectId": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
      "rank": "a0",
      "arrivedOn": null,
      "checklist": [
        { "id": "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d", "title": "下書き", "done": true }
      ],
      "completedAt": "2026-10-02T00:00:00.000Z",
      "startedAt": null,
      "priority": "high",
      "points": 5,
      "createdAt": "2026-09-01T00:00:00.000Z",
      "updatedAt": "2026-10-02T00:00:00.000Z",
      "deletedAt": null,
      "seq": 0
    }
  ]
}`;

describe("exportSchema", () => {
  it("nagi export の見本の JSON を読める", () => {
    const document = exportSchema.parse(JSON.parse(SAMPLE));
    expect(document.tasks).toHaveLength(1);
    expect(document.projects).toHaveLength(1);
  });

  it("別の形式・版や、論理削除の行は読まない", () => {
    const base = JSON.parse(SAMPLE);
    expect(exportSchema.safeParse({ ...base, format: "other" }).success).toBe(false);
    expect(exportSchema.safeParse({ ...base, formatVersion: 2 }).success).toBe(false);
    const deleted = { ...base.tasks[0], deletedAt: "2026-10-03T00:00:00.000Z" };
    expect(exportSchema.safeParse({ ...base, tasks: [deleted] }).success).toBe(false);
  });
});
