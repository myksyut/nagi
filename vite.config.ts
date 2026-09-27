import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const alias = {
  "@": fileURLToPath(new URL("./src/client", import.meta.url)),
  "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
};

// Mac からは `ssh -L 5317:localhost:5317 <M7>` で localhost として開く（README）
const port = 5317;

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: { alias },
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  environments: {
    // 画面（client）だけの設定。Worker の出力は変えない
    client: {
      build: {
        // 起動に要るモジュール（入口から静的にたどれるもの。`$initial`）を1つのファイルにまとめる。
        // 自動の分け方では、後から読み込む部品と共有するモジュールが小さなファイルに分かれ、
        // import の往復と gzip の効き（ファイルごとに圧縮する）の分だけ、起動に要る JS が増える（17 で 8KB ほど）。
        // 後から読み込む部品（lib/deferred.ts の defer）は、これまでどおり別のファイルに残る
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [{ name: "startup", tags: ["$initial"] }],
            },
          },
        },
        // 上のまとめで、起動のファイルは 1 つで約 640KB（gzip で約 195KB）になる。
        // 目安は起動に要る JS の gzip の合計（205KB 以下）で見るので、1 ファイル 500KB の警告の上限を上げる
        chunkSizeWarningLimit: 800,
      },
    },
  },
});
