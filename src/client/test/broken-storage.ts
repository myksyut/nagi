/** localStorage のうち、例外を投げるものに替えるメソッド */
const METHODS = ["getItem", "setItem", "removeItem"] as const;

type Method = (typeof METHODS)[number];

/**
 * localStorage の読み書き（getItem・setItem・removeItem）を、例外を投げるものに替える（使えない・容量切れを真似る）。
 * calls に、呼ばれたメソッドと引数を控える。戻り値の restore で元に戻す（テストの終わりに必ず呼ぶ）。
 * happy-dom の Storage は、一度読んだメソッドを実体に直接付け、代入は黙って捨て、vi.spyOn の戻し（delete）も
 * 受け付けない（偽物が次のテストまで残る）。そのため defineProperty で替え、元の関数も defineProperty で戻す
 */
export function breakLocalStorage() {
  const calls: { method: Method; args: unknown[] }[] = [];
  const originals = METHODS.map((method) => [method, localStorage[method]] as const);
  for (const method of METHODS) {
    Object.defineProperty(localStorage, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        calls.push({ method, args });
        throw new DOMException("storage is disabled", "SecurityError");
      },
    });
  }
  return {
    calls,
    restore: () => {
      for (const [method, original] of originals) {
        Object.defineProperty(localStorage, method, {
          configurable: true,
          writable: true,
          value: original,
        });
      }
    },
  };
}
