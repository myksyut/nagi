PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE tasks (
                   id TEXT PRIMARY KEY,
                   seq INTEGER NOT NULL UNIQUE,
                   project_id TEXT,
                   open INTEGER NOT NULL,
                   deleted_at TEXT,
                   json TEXT NOT NULL
                 );
INSERT INTO tasks VALUES('01a12b59-7e0c-7815-98d3-e3a4c060e731',1,NULL,1,NULL,'{"id":"01a12b59-7e0c-7815-98d3-e3a4c060e731","title":"最初のタスク","memo":"","bucket":"inbox","scheduledOn":null,"deadlineOn":null,"projectId":null,"rank":"a0","arrivedOn":null,"checklist":[],"completedAt":null,"startedAt":null,"priority":null,"points":null,"createdAt":"2026-10-11T14:24:07.692Z","updatedAt":"2026-10-11T14:24:07.692Z","deletedAt":null,"seq":1}');
INSERT INTO tasks VALUES('01a12b5a-b213-7599-87cb-9648bc6f43f2',5,NULL,1,NULL,'{"id":"01a12b5a-b213-7599-87cb-9648bc6f43f2","title":"受信箱のタスク","memo":"メモの一行目","bucket":"inbox","scheduledOn":null,"deadlineOn":null,"projectId":null,"rank":"a1","arrivedOn":null,"checklist":[{"id":"01a12b5a-b213-7404-9348-1a2db6bd8624","title":"下調べ","done":false},{"id":"01a12b5a-b213-7de2-b0cc-20a3635aab25","title":"見積もり","done":false}],"completedAt":null,"startedAt":null,"priority":null,"points":null,"createdAt":"2026-10-11T14:25:26.547Z","updatedAt":"2026-10-11T14:25:26.558Z","deletedAt":null,"seq":5}');
INSERT INTO tasks VALUES('01a12b5a-b266-76b0-9589-dc980dc1bcf0',8,'01a12b5a-b196-7499-87e0-11342b4395a5',1,NULL,'{"id":"01a12b5a-b266-76b0-9589-dc980dc1bcf0","title":"今日のタスク","memo":"","bucket":"today","scheduledOn":null,"deadlineOn":null,"projectId":"01a12b5a-b196-7499-87e0-11342b4395a5","rank":"a0","arrivedOn":null,"checklist":[],"completedAt":null,"startedAt":null,"priority":"high","points":3,"createdAt":"2026-10-11T14:25:26.630Z","updatedAt":"2026-10-11T14:25:26.638Z","deletedAt":null,"seq":8}');
INSERT INTO tasks VALUES('01a12b5a-b2a8-7efc-ac93-089dc7e6ebf1',10,'01a12b5a-b196-7499-87e0-11342b4395a5',1,NULL,'{"id":"01a12b5a-b2a8-7efc-ac93-089dc7e6ebf1","title":"予定のタスク","memo":"","bucket":"scheduled","scheduledOn":"2026-10-20","deadlineOn":"2026-10-23","projectId":"01a12b5a-b196-7499-87e0-11342b4395a5","rank":"a0","arrivedOn":null,"checklist":[],"completedAt":null,"startedAt":null,"priority":null,"points":null,"createdAt":"2026-10-11T14:25:26.696Z","updatedAt":"2026-10-11T14:25:26.701Z","deletedAt":null,"seq":10}');
INSERT INTO tasks VALUES('01a12b5a-b2e5-754e-a02b-297ff0c417b4',12,NULL,1,NULL,'{"id":"01a12b5a-b2e5-754e-a02b-297ff0c417b4","title":"あとでのタスク","memo":"","bucket":"later","scheduledOn":null,"deadlineOn":null,"projectId":null,"rank":"a0","arrivedOn":null,"checklist":[],"completedAt":null,"startedAt":null,"priority":null,"points":5,"createdAt":"2026-10-11T14:25:26.757Z","updatedAt":"2026-10-11T14:25:26.760Z","deletedAt":null,"seq":12}');
INSERT INTO tasks VALUES('01a12b5a-b328-70c9-907e-93ec67935d95',16,'01a12b5a-b196-7499-87e0-113529508b89',0,NULL,'{"id":"01a12b5a-b328-70c9-907e-93ec67935d95","title":"完了したタスク","memo":"","bucket":"inbox","scheduledOn":null,"deadlineOn":null,"projectId":"01a12b5a-b196-7499-87e0-113529508b89","rank":"a2","arrivedOn":null,"checklist":[],"completedAt":"2026-10-11T14:25:27.091Z","startedAt":null,"priority":"low","points":null,"createdAt":"2026-10-11T14:25:26.824Z","updatedAt":"2026-10-11T14:25:27.091Z","deletedAt":null,"seq":16}');
INSERT INTO tasks VALUES('01a12b5a-b36a-7166-9f64-f57dacb4deff',18,NULL,0,'2026-10-11T14:25:27.287Z','{"id":"01a12b5a-b36a-7166-9f64-f57dacb4deff","title":"削除したタスク","memo":"","bucket":"inbox","scheduledOn":null,"deadlineOn":null,"projectId":null,"rank":"a3","arrivedOn":null,"checklist":[],"completedAt":null,"startedAt":null,"priority":null,"points":null,"createdAt":"2026-10-11T14:25:26.890Z","updatedAt":"2026-10-11T14:25:27.287Z","deletedAt":"2026-10-11T14:25:27.287Z","seq":18}');
CREATE TABLE projects (
                   id TEXT PRIMARY KEY,
                   seq INTEGER NOT NULL UNIQUE,
                   deleted_at TEXT,
                   json TEXT NOT NULL
                 );
INSERT INTO projects VALUES('01a12b5a-b196-7499-87e0-11342b4395a5',2,NULL,'{"id":"01a12b5a-b196-7499-87e0-11342b4395a5","name":"仕事","color":null,"archivedAt":null,"createdAt":"2026-10-11T14:25:26.422Z","updatedAt":"2026-10-11T14:25:26.422Z","deletedAt":null,"seq":2}');
INSERT INTO projects VALUES('01a12b5a-b196-7499-87e0-113529508b89',17,NULL,'{"id":"01a12b5a-b196-7499-87e0-113529508b89","name":"引っ越し","color":null,"archivedAt":"2026-10-11T14:25:27.287Z","createdAt":"2026-10-11T14:25:26.422Z","updatedAt":"2026-10-11T14:25:27.287Z","deletedAt":null,"seq":17}');
CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
INSERT INTO meta VALUES('seq',18);
INSERT INTO meta VALUES('last_rollover_on','2026-10-11');
CREATE TABLE applied (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO applied VALUES('01a12b59-7e0c-787b-83e7-eb10a8824b91','2026-10-11T14:24:07.692Z');
INSERT INTO applied VALUES('01a12b5a-b196-7499-87e0-1136cc078019','2026-10-11T14:25:26.422Z');
INSERT INTO applied VALUES('01a12b5a-b213-7509-b15b-2a839b71786f','2026-10-11T14:25:26.547Z');
INSERT INTO applied VALUES('01a12b5a-b213-72d2-a83e-eb74e4d7889e','2026-10-11T14:25:26.558Z');
INSERT INTO applied VALUES('01a12b5a-b266-77cb-a135-445dedc13c61','2026-10-11T14:25:26.630Z');
INSERT INTO applied VALUES('01a12b5a-b266-7597-b119-49b8ecd492a2','2026-10-11T14:25:26.635Z');
INSERT INTO applied VALUES('01a12b5a-b266-7360-b95e-d96578d77a13','2026-10-11T14:25:26.638Z');
INSERT INTO applied VALUES('01a12b5a-b2a8-7375-9698-8b0f880fc271','2026-10-11T14:25:26.696Z');
INSERT INTO applied VALUES('01a12b5a-b2a8-797f-89e1-e7b158908e44','2026-10-11T14:25:26.701Z');
INSERT INTO applied VALUES('01a12b5a-b2e5-76c3-9a81-d42d0ec6df9e','2026-10-11T14:25:26.757Z');
INSERT INTO applied VALUES('01a12b5a-b2e5-78d0-8592-fc1151f390c5','2026-10-11T14:25:26.760Z');
INSERT INTO applied VALUES('01a12b5a-b328-78b4-8123-e0c74e5bf736','2026-10-11T14:25:26.824Z');
INSERT INTO applied VALUES('01a12b5a-b328-7a19-85ca-6961d110a450','2026-10-11T14:25:26.827Z');
INSERT INTO applied VALUES('01a12b5a-b36a-7cc1-abd5-a5a24c9dc8d8','2026-10-11T14:25:26.890Z');
INSERT INTO applied VALUES('01a12b5a-b433-736a-acd8-4e97035ff6b8','2026-10-11T14:25:27.091Z');
INSERT INTO applied VALUES('01a12b5a-b4f7-7042-b080-8d0a17207c9e','2026-10-11T14:25:27.287Z');
CREATE INDEX tasks_open ON tasks (open, project_id);
PRAGMA user_version=1;
COMMIT;
