import { Fragment } from "react";

/** メモの中の URL を、新しいタブで開くリンクにして出す */

const URL_PATTERN = /https?:\/\/[^\s<>"'「」『』（）]+/g;
/** URL の直後に付きがちな句読点や閉じかっこは、URL に含めない */
const TRAILING = /[.,;:!?。、，．）)\]」』]+$/;
const LONG_URL = 48;

export type TextPart = { type: "text"; text: string } | { type: "url"; url: string };

export function splitUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING, "");
    const start = match.index;
    if (url.length <= "https://".length) continue;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "url", url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** 表示用に短くした URL（例：`github.com/…/pull/412`） */
export function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (bare.length <= LONG_URL) return bare;
  const segments = bare.split("/").filter((segment) => segment !== "");
  const host = segments[0] ?? bare;
  const tail = segments.slice(-2).join("/");
  return segments.length > 3 ? `${host}/…/${tail}` : `${bare.slice(0, LONG_URL - 1)}…`;
}

export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitUrls(text).map((part, i) =>
        part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 文字の並びは中身から決まり、並べ替えない
          <Fragment key={i}>{part.text}</Fragment>
        ) : (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: 同じ URL が2回出てもよいように位置で区別する
            key={i}
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            title={part.url}
            className="text-primary underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {shortUrl(part.url)}
          </a>
        ),
      )}
    </>
  );
}
