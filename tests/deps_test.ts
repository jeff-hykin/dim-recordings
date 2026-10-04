// backend/deps.ts (what `deno run backend/main.ts` imports) and backend/bundle/package.json (what the nix build
// bundles) must name the same package versions.
import { assertEquals } from "@std/assert"

Deno.test("deps.ts and the bundle's package.json pin the same versions", async () => {
    const deps = await Deno.readTextFile(new URL("../backend/deps.ts", import.meta.url))
    const pinned = Object.fromEntries(
        [...deps.matchAll(/"npm:(@?[^@"]+)@([^"/]+)"/g)].map(([, name, version]) => [name, version]),
    )
    const pkg = JSON.parse(await Deno.readTextFile(new URL("../backend/bundle/package.json", import.meta.url)))
    assertEquals(pinned, pkg.dependencies)
})
