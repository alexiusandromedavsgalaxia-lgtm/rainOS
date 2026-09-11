import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.js"),
        "kernel/index": resolve(__dirname, "src/kernel/index.js"),
        "bootstrap/index": resolve(__dirname, "src/bootstrap/index.js"),
        "bootloader/index": resolve(__dirname, "src/bootloader/index.js"),
        "safeboot/index": resolve(__dirname, "src/safeboot/index.js"),
        "startupinstaller/index": resolve(
          __dirname,
          "src/startupinstaller/index.js"
        ),
        "initialconfig/index": resolve(__dirname, "src/initialconfig/index.js"),
        "initsystem/index": resolve(__dirname, "src/initsystem/index.js"),
        "lockscreen/index": resolve(__dirname, "src/lockscreen/index.js"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        format === "es" ? `${entryName}.js` : `${entryName}.cjs`,
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "react/jsx-runtime": "jsxRuntime",
        },
      },
    },
    sourcemap: true,
    emptyOutDir: true,
    target: "es2020",
    minify: "esbuild",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{js,jsx}"],
      exclude: ["**/index.js", "**/*.test.js"],
    },
  },
});
