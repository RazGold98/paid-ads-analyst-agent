import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The GUI is built into the agent's dist/public, and the agent's Express server serves it.
// In development, `npm run dev:web` serves it with hot reload and forwards /api to the local agent.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
