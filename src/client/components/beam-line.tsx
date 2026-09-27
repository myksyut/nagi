import type { ReactNode } from "react";
import { defer, useDeferred } from "@/lib/deferred";
import { useReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";

const borderBeam = defer(() => import("border-beam"));

/**
 * 下の辺だけを光が流れる飾り（libraries.dev の border-beam、`size="line"`）。
 * 使うのは ⌘K の入力欄と、入力しているあいだの追加欄の2か所だけ（UI の土台と手触りの「動きのルール」）。
 * active のあいだだけ流し、止めるとフェードで消える。prefers-reduced-motion のときは出さない。
 * border-beam は後から読み込み、中身（children）の上に重ねて描く（読み込みの前後で中身を描き直さないように。
 * 入力欄のフォーカスや打った文字がそのまま残る）
 */
export function BeamLine({
  active,
  radius,
  className,
  children,
}: {
  active: boolean;
  /** 中身の角丸（px） */
  radius: number;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const on = active && !reduced;
  const module = useDeferred(borderBeam, on);
  const Beam = module?.BorderBeam;
  return (
    <div className={cn("relative", className)}>
      {children}
      {Beam && (
        <Beam
          size="line"
          colorVariant="ocean"
          strength={0.5}
          active={on}
          borderRadius={radius}
          aria-hidden="true"
          data-slot="beam-line"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <div className="size-full" />
        </Beam>
      )}
    </div>
  );
}
