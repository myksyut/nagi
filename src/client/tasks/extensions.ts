import type { ComponentType } from "react";
import type { TaskRow } from "@/data";
import type { ListView } from "./list-ui";

/**
 * 行と開いたタスクに項目を足すための登録口。4 は枠だけを作り、中身は各チケットが登録する
 * （登録は features/<名前>/register.ts から。features/index.ts が自動で読み込む）。
 * - 行の右側の情報（registerRowMeta）：Core Flows の並び「プロジェクト名・チェックリストの進み具合・メモの印・締切」
 * - 開いたタスクの欄（registerDetailField）：メモの下に縦に並ぶ欄（section）と、一番下の小さなボタンの列（chip）
 * 部品は、出すものがなければ null を返す。行の部品は observer で包む（読んだ行が変わったときだけ描き直す）
 */

export type TaskSlotProps = {
  task: TaskRow;
  /** 行がある画面（完了ログでは締切を出さない、など画面で出し分けるときに使う） */
  view: ListView;
};

type Registered = { id: string; order: number; Component: ComponentType<TaskSlotProps> };

/** 行の右側の並び順（小さいほど左）。間に入れたいときは間の数を使う */
export const ROW_META_ORDER = {
  project: 10,
  checklist: 20,
  memo: 30,
  deadline: 40,
} as const;

export type RowMetaItem = Registered;

/** 開いたタスクの欄の置き場所 */
export type DetailPlacement = "section" | "chip";

export type DetailField = Registered & { placement: DetailPlacement };

/** 開いたタスクの欄の並び順（placement ごとに、小さいほど上・左） */
export const DETAIL_ORDER = {
  /** section：メモの下 */
  checklist: 10,
  /** chip：一番下の列 */
  when: 10,
  deadline: 20,
  project: 30,
} as const;

class Registry<T extends Registered> {
  readonly #items = new Map<string, T>();
  #sorted: T[] | null = null;

  register(item: T): () => void {
    this.#items.set(item.id, item);
    this.#sorted = null;
    return () => {
      if (this.#items.get(item.id) === item) {
        this.#items.delete(item.id);
        this.#sorted = null;
      }
    };
  }

  list(): readonly T[] {
    this.#sorted ??= Array.from(this.#items.values()).sort(
      (a, b) => a.order - b.order || (a.id < b.id ? -1 : 1),
    );
    return this.#sorted;
  }
}

const rowMeta = new Registry<RowMetaItem>();
const detailFields = new Registry<DetailField>();

/** 行の右側に項目を足す。同じ id で登録し直すと置き換わる。戻り値を呼ぶと外す */
export function registerRowMeta(item: RowMetaItem): () => void {
  return rowMeta.register(item);
}

/** 開いたタスクに欄を足す。同じ id で登録し直すと置き換わる。戻り値を呼ぶと外す */
export function registerDetailField(field: DetailField): () => void {
  return detailFields.register(field);
}

export function rowMetaItems(): readonly RowMetaItem[] {
  return rowMeta.list();
}

export function detailFieldsOf(placement: DetailPlacement): readonly DetailField[] {
  return detailFields.list().filter((field) => field.placement === placement);
}
