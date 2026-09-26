import { observer } from "mobx-react-lite";
import { type ReactNode, useEffect } from "react";
import { useStore } from "@/data";

/**
 * リストの画面の枠：見出しと、その下の小さな一行（今日なら日付）。
 * 中身（一覧）は、手元の控えを読み終えてから描く（それまではキーの操作も受け付けない）
 */
export const ListScreen = observer(function ListScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  const store = useStore();
  useEffect(() => {
    document.title = `${title} — nagi`;
  }, [title]);

  return (
    <>
      <h1 className="font-semibold text-[22px] tracking-tight">{title}</h1>
      {subtitle !== undefined && subtitle !== "" && (
        <p className="mt-0.5 text-muted-foreground text-sm">{subtitle}</p>
      )}
      {store.loaded && children}
    </>
  );
});
