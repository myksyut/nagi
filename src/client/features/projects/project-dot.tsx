import type { CSSProperties } from "react";
import { type ProjectColor, projectColorVar } from "@/lib/project-color";
import { cn } from "@/lib/utils";

/** プロジェクトの色の点（ほのかな光付き）。大きさは className で決める。読み上げには出さない */
export function ProjectDot({ color, className }: { color: ProjectColor; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-project-color={color}
      className={cn("project-dot inline-block", className)}
      style={{ "--dot": projectColorVar(color) } as CSSProperties}
    />
  );
}
