// The app's long-lived pieces, built once from the config (tests build their own over a temporary folder).
import type { Config } from "./config.ts"
import { Jobs } from "./recordings/convert.ts"
import { Library } from "./recordings/library.ts"
import type { Services } from "./recordings/routes.ts"
import { Thumbnailer } from "./recordings/thumb_worker.ts"
import { Uploads } from "./recordings/uploads.ts"

export function makeServices(config: Config): Services {
    const library = new Library(config)
    const jobs = new Jobs()
    jobs.onChange = (job) => library.emit({ type: "job", job })
    return { library, jobs, thumbnails: new Thumbnailer(library), uploads: new Uploads(config) }
}
