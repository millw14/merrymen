import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/blockscout": {
        target: "https://robinhoodchain.blockscout.com/api/v2",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/blockscout/, ""),
      },
      "/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/yahoo/, ""),
        headers: { "User-Agent": "Mozilla/5.0" },
      },
    },
  },
});
