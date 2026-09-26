import { useEffect } from "react";

/** リストの画面。中身は 4 以降で作るので、今は見出しだけ */
export function ListScreen({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} — nagi`;
  }, [title]);

  return <h1 className="font-semibold text-[22px] tracking-tight">{title}</h1>;
}
