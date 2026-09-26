import { type ReactNode, useEffect } from "react";

/** リストの画面。中身は 4 以降で作るので、今は見出しと、仮の表示（children）だけ */
export function ListScreen({ title, children }: { title: string; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — nagi`;
  }, [title]);

  return (
    <>
      <h1 className="font-semibold text-[22px] tracking-tight">{title}</h1>
      {children}
    </>
  );
}
