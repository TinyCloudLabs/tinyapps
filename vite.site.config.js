import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/site",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overview: resolve(__dirname, "overview/index.html"),
      },
    },
  },
});
