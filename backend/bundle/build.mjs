// backend/main.ts and everything it imports → dist/server.js, one ES module deno runs with no downloads.
// `npm:<name>@<version>` specifiers (backend/deps.ts) resolve to this folder's node_modules; `node:` stays external.
import { build } from "esbuild"

const npmSpecifier = {
    name: "npm-specifiers",
    setup(context) {
        context.onResolve({ filter: /^npm:/ }, (args) => {
            const name = args.path.slice(4).replace(/^(@?[^@]+)@[^/]+/, "$1")
            return context.resolve(name, { kind: args.kind, resolveDir: import.meta.dirname })
        })
    },
}

await build({
    entryPoints: ["../main.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    // dim-app's zenoh.js (vendored for checkTopic) lazily imports the browser's zenoh-gateway client; a backend never does
    external: ["node:*", "./zenoh_gateway_client.js"],
    outfile: "dist/server.js",
    plugins: [npmSpecifier],
    logLevel: "info",
})
