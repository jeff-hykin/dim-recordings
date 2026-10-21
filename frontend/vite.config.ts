import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import process from "node:process"
import { defineConfig, type Plugin } from "vite"

const config = JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8"))

// deno.json's `jsr:` imports (dimos-react) from vendor/, where `deno install` puts them (vendor: true): the package's
// export map (its _meta.json) picks the file, so `dimos-react/three` is its ./three export
function jsrFromVendor(): Plugin {
    const packages = Object.entries(config.imports as Record<string, string>).flatMap(([name, target]) => {
        const match = target.match(/^jsr:(@[^/@]+\/[^/@]+)@(.+)$/)
        if (!match) {
            return []
        }
        const folder = new URL(`./vendor/jsr.io/${match[1]}/`, import.meta.url)
        const exports = JSON.parse(readFileSync(new URL(`${match[2]}_meta.json`, folder), "utf8")).exports
        return [{ name, root: new URL(`${match[2]}/`, folder), exports: exports as Record<string, string> }]
    })
    return {
        name: "jsr-from-vendor",
        enforce: "pre",
        resolveId(id) {
            for (const { name, root, exports } of packages) {
                const subpath = id === name ? "." : id.startsWith(`${name}/`) ? `.${id.slice(name.length)}` : null
                if (subpath && exports[subpath]) {
                    return new URL(exports[subpath], root).pathname
                }
            }
            return null
        },
    }
}

// that source imports `npm:<package>@<range>/<path>`: resolve it as the bare `<package>/<path>`, from node_modules
function npmSpecifiers(): Plugin {
    return {
        name: "npm-specifiers",
        enforce: "pre",
        resolveId(id, importer) {
            const match = id.match(/^npm:\/?((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(\/.*)?$/)
            return match ? this.resolve(match[1] + (match[2] ?? ""), importer, { skipSelf: true }) : null
        },
    }
}

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md); `deno task dev` proxies
// Desktop's paths to DESKTOP (default: the dev backend: `deno task dev` on :8787 proxied for /api)
const desktop = process.env.DESKTOP ?? "http://127.0.0.1:8787"
export default defineConfig({
    base: "./",
    plugins: [jsrFromVendor(), npmSpecifiers(), react()],
    server: {
        proxy: Object.fromEntries(["/api", "/dimos", "/agent", "/mcp", "/apps"].map((path) => [path, desktop])),
    },
})
