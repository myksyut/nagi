import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useRef, useState } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { type AppStore, useStore } from "@/data";
import { ProjectDot } from "@/features/projects/project-dot";
import { projectColorOf } from "@/lib/project-color";
import { cn } from "@/lib/utils";
import { ALL_PROJECTS, type ProjectFilter, type TimelineModel } from "./timeline-model";

/**
 * 上の絞り込み（「すべてのプロジェクト ▾」）。押すと、すべて・各プロジェクト・プロジェクトなしが小さく開き、
 * 選ぶとタイムラインに出すタスクが変わる。↑↓ で移り、Enter か Space で決める。Esc で閉じてボタンへ戻る。
 * 並べるプロジェクトはサイドバーと同じ（アーカイブ済みは出さない。絞り込んでいたプロジェクトがアーカイブされたら、
 * 絞り込みは「すべて」に戻る。timeline-model.ts）
 */

type Option = { filter: ProjectFilter; label: string; projectId: string | null };

function sameFilter(a: ProjectFilter, b: ProjectFilter): boolean {
  if (a.kind === "project" && b.kind === "project") return a.id === b.id;
  return a.kind === b.kind;
}

function filterLabel(store: AppStore, filter: ProjectFilter): string {
  switch (filter.kind) {
    case "all":
      return "すべてのプロジェクト";
    case "none":
      return "プロジェクトなし";
    case "project":
      return store.project(filter.id)?.name ?? "プロジェクト";
  }
}

function optionsOf(store: AppStore): Option[] {
  const projects: Option[] = store.lists.projects.map((project) => ({
    filter: { kind: "project", id: project.id },
    label: project.name,
    projectId: project.id,
  }));
  return [
    { filter: ALL_PROJECTS, label: filterLabel(store, ALL_PROJECTS), projectId: null },
    ...projects,
    { filter: { kind: "none" }, label: filterLabel(store, { kind: "none" }), projectId: null },
  ];
}

export const ProjectFilterButton = observer(function ProjectFilterButton({
  model,
}: {
  model: TimelineModel;
}) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const current = model.filter;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef<HTMLButtonElement | null>(null);
  const options = open ? optionsOf(store) : [];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const list = buttons.current.slice(0, options.length);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = (Math.max(index, 0) + delta + list.length) % list.length;
    list[next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`プロジェクトで絞り込む：${filterLabel(store, current)}`}
        className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 py-1 font-medium text-[12.5px] text-sidebar-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-accent"
      >
        {current.kind === "project" && (
          <ProjectDot color={projectColorOf(store, current.id)} className="size-2" />
        )}
        <span className="truncate">{filterLabel(store, current)}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 flex-none opacity-70" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        aria-label="プロジェクトで絞り込む"
        data-keymap="off"
        initialFocus={initialFocus}
        // 出るときは 100ms、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="w-60 duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div
          role="radiogroup"
          aria-label="プロジェクトで絞り込む"
          className="-mx-2 -my-2 flex max-h-80 flex-col gap-px overflow-y-auto"
          onKeyDown={onKeyDown}
        >
          {options.map((option, i) => {
            const checked = sameFilter(option.filter, current);
            return (
              // biome-ignore lint/a11y/useSemanticElements: 絞り込みの1つとして読み上げる（選ぶと閉じる）
              <button
                key={option.projectId ?? option.filter.kind}
                ref={(element) => {
                  buttons.current[i] = element;
                  if (checked) initialFocus.current = element;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent focus-visible:outline-1 focus-visible:outline-ring",
                  option.projectId === null && "text-muted-foreground",
                )}
                onClick={() => {
                  model.setFilter(option.filter);
                  setOpen(false);
                }}
              >
                {option.projectId === null ? (
                  <span aria-hidden="true" className="size-2 flex-none" />
                ) : (
                  <ProjectDot color={projectColorOf(store, option.projectId)} className="size-2" />
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {checked && (
                  <CheckIcon aria-hidden="true" className="size-3.5 flex-none text-primary-text" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
