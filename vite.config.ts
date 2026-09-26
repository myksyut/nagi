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
});
