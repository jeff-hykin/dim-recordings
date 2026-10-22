import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import process from "node:process"
import { defineConfig, type Plugin } from "vite"

const config = JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8"))

// deno.json's https imports (dimos-react's source at its tag) from vendor/, where `deno install` puts them (vendor: true)
function httpsFromVendor(): Plugin {
    const remote = Object.entries(config.imports as Record<string, string>).filter(([, target]) =>
        target.startsWith("https://")
    )
    const local = (url: string) => new URL(`./vendor/${url.replace(/^https:\/\//, "")}`, import.meta.url).pathname
    return {
        name: "https-from-vendor",
        enforce: "pre",
        resolveId(id) {
            const found = remote.find(([name]) => name === id)
            return found ? local(found[1]) : null
        },
    }
}

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md); `deno task dev` proxies
// Desktop's paths to DESKTOP (default: the dev backend: `deno task dev` on :8787 proxied for /api)
const desktop = process.env.DESKTOP ?? "http://127.0.0.1:8787"
export default defineConfig({
    base: "./",
    plugins: [httpsFromVendor(), react()],
    server: {
        proxy: Object.fromEntries(["/api", "/dimos", "/agent", "/mcp", "/apps"].map((path) => [path, desktop])),
    },
})
