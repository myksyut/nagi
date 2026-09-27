import { observer } from "mobx-react-lite";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useKeyContext } from "@/keyboard/key-context";
import { KEY_GROUP_ORDER, type KeyBinding, keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { overlaysOf } from "./overlays";

/**
 * `?`：ショートカットの一覧。キーマップの登録から、まとまり（group）ごとに作る（手で書かない）。
 * 1つの操作に割り当てたキーが複数あれば、すべて並べる
 */
export const ShortcutsDialog = observer(function ShortcutsDialog() {
  const { ui } = useKeyContext();
  const overlays = overlaysOf(ui);
  return (
    <Dialog
      open={overlays.shortcuts}
      onOpenChange={(open) => {
        if (open) overlays.openShortcuts();
        else overlays.closeShortcuts();
      }}
    >
      <DialogPopup
        data-keymap="off"
        className="max-w-md transition-none"
        closeProps={{ "aria-label": "閉じる" }}
      >
        <DialogHeader>
          <DialogTitle className="text-base">ショートカット</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5 pb-6">
          {shortcutGroups().map(({ group, bindings }) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">{group}</h3>
              <dl className="flex flex-col gap-1 text-sm">
                {bindings.map((binding) => (
                  <div key={binding.id} className="flex items-center justify-between gap-4">
                    <dt>{binding.label}</dt>
                    <dd className="flex gap-1">
                      {binding.keys.map((key) => (
                        <Kbd key={key}>{formatKey(key)}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
});

/** キーマップの割り当てを、まとまりごとに（まとまりの順は ⌘K と同じ） */
export function shortcutGroups(): { group: string; bindings: KeyBinding[] }[] {
  const bindings = keymap.list();
  return KEY_GROUP_ORDER.flatMap((group) => {
    const inGroup = bindings.filter((binding) => binding.group === group);
    return inGroup.length > 0 ? [{ group, bindings: inGroup }] : [];
  });
}
