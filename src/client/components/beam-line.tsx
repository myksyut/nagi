import type { ReactNode } from "react";
import { defer, useDeferred } from "@/lib/deferred";
import { useReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";

const borderBeam = defer(() => import("border-beam"));

/** 光が下の辺を1往復する時間（秒。border-beam の line の既定と同じ） */
const TRAVEL_SECONDS = 3.1;

/**
 * border-beam の line は、出るときに 600ms、消えるときに 500ms かけてフェードする。
 * 動きのルール（出るときは 100ms、消えるときだけ 150ms）に合わせて、出入りのフェードだけを上書きする
 * （流れ続ける動きは、ライブラリの line の指定と同じ）。`{id}` は border-beam が部品ごとの id に置き換える
 */
function fadeOverride(t: number): string {
  const loops = [
    `beam-travel-{id} ${t}s linear infinite`,
    `beam-edge-fade-{id} ${t}s linear infinite`,
    `beam-breathe-{id} ${(t * 1.3).toFixed(1)}s ease-in-out infinite`,
    `beam-spike-{id} ${(t * 1.33).toFixed(1)}s ease-in-out infinite`,
    `beam-spike2-{id} ${(t * 1.7).toFixed(1)}s ease-in-out infinite`,
  ].join(", ");
  return `
[data-beam="{id}"][data-active] { animation: ${loops}, beam-fade-in-{id} 100ms ease-out forwards; }
[data-beam="{id}"][data-fading] { animation: ${loops}, beam-fade-out-{id} 150ms ease-out forwards; }
`;
}

const FADE_OVERRIDE = fadeOverride(TRAVEL_SECONDS);

/**
 * 下の辺だけを光が流れる飾り（libraries.dev の border-beam、`size="line"`）。
 * 使うのは ⌘K の入力欄と、入力しているあいだの追加欄の2か所だけ（UI の土台と手触りの「動きのルール」）。
 * active のあいだだけ流し、止めると 150ms のフェードで消える。
 * prefers-reduced-motion のあいだは、border-beam そのものを外す（CSS の動きを止めると、border-beam は
 * フェードの終わりを受け取れず止まったままになるので、外して、設定を戻したら付け直す）。
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
  const { module } = useDeferred(borderBeam, active && !reduced);
  const Beam = reduced ? undefined : module?.BorderBeam;
  return (
    <div className={cn("relative", className)}>
      {children}
      {Beam && (
        <Beam
          size="line"
          colorVariant="ocean"
          strength={0.5}
          duration={TRAVEL_SECONDS}
          active={active}
          borderRadius={radius}
          css={FADE_OVERRIDE}
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
