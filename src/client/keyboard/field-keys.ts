import { createAtom } from "mobx";
import { parseKey } from "./keys";

/**
 * 候補や欄の中のキー（p の候補・日付の入力・追加欄・開いたタスク・チェックリスト・⌘K・プロジェクトの名前の欄など）。
 * これらのキーは、キーマップではなく部品が自分で扱う（onKeyDown や Base UI）ので、キーマップにはない。
 * ショートカットのページに出すために、説明だけをここに登録する（動きは登録しない）。
 * 登録は registerKeyBindings と同じ形：キーを扱う部品のそば（同じモジュール）で、場面ごとに1回呼ぶ。
 * 同じ id で登録し直すと置き換わり、戻り値を呼ぶと外す。後から読み込むモジュールで登録してもよい
 * （先読みのときに登録され、開いているショートカットのページにも出る）。
 * 部品のキーの扱いを変えたら、同じモジュールの登録も直す（ページの表示と実際の動きがずれないように）
 */

/** 場面の中の1つの操作 */
export type FieldKey = {
  /** 操作の名前（例：「決める」） */
  label: string;
  /** キー（keys.ts の書き方。例：`Enter`・`Escape`・`Alt+ArrowUp`）。すべてページに並べる */
  keys: readonly string[];
};

export type FieldKeyScene = {
  /** 一意の名前（例：`project-picker`）。同じ id で登録し直すと置き換わる */
  id: string;
  /** 場面の名前（ページの小さな見出し。例：「p の候補」） */
  label: string;
  /** ページでの並び順（FIELD_SCENE_ORDER。小さいほど前） */
  order: number;
  keys: readonly FieldKey[];
};

/**
 * 場面の並び順（小さいほど前）。間に入れたいときは間の数を使う
 * （例：p の候補の後ろに ⇧P と e の候補を入れるなら 12・14）
 */
export const FIELD_SCENE_ORDER = {
  projectPicker: 10,
  dateEntry: 20,
  dateCalendar: 25,
  addRow: 30,
  quickAdd: 35,
  taskDetail: 40,
  taskDetailPopover: 45,
  checklist: 50,
  palette: 60,
  projectName: 70,
  projectRename: 72,
  projectColor: 74,
  calendarTask: 80,
  calendarFilter: 82,
  timelineBar: 85,
  timelineFilter: 87,
} as const;

const scenes = new Map<string, FieldKeyScene>();
const atom = createAtom("field-keys");

/** 場面の説明を足す。戻り値を呼ぶと外す。キーの書き方が読めなければ例外（書き間違いに気づけるように） */
export function registerFieldKeys(scene: FieldKeyScene): () => void {
  for (const { keys } of scene.keys) for (const key of keys) parseKey(key);
  scenes.set(scene.id, scene);
  atom.reportChanged();
  return () => {
    if (scenes.get(scene.id) !== scene) return;
    scenes.delete(scene.id);
    atom.reportChanged();
  };
}

/** 登録されている場面（並び順の順）。observer の中で読むと、登録が変わったときに描き直す */
export function fieldKeyScenes(): FieldKeyScene[] {
  atom.reportObserved();
  return Array.from(scenes.values()).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}
