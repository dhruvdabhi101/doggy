import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, proxy: Object.fromEntries(["/api", "/mcp", "/oauth/register", "/oauth/token", "/oauth/client", "/oauth/approve", "/.well-known", "/downloads"].map((p) => [p, "http://localhost:8787"])) },
});
