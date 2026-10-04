import react from "@vitejs/plugin-react"
import process from "node:process"
import { defineConfig } from "vite"

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md); `npm run dev` proxies
// Desktop's paths to DESKTOP (default: the dev backend: `deno task dev` on :8787 proxied for /api)
const desktop = process.env.DESKTOP ?? "http://127.0.0.1:8787"
export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        proxy: Object.fromEntries(["/api", "/dimos", "/agent", "/mcp", "/apps"].map((path) => [path, desktop])),
    },
})
