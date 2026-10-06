// The app's long-lived pieces, built once from the config (tests build their own over a temporary folder).
import type { Config } from "./config.ts"
import { Jobs } from "./recordings/convert.ts"
import { Transfers } from "./recordings/drive_routes.ts"
import { Drives } from "./recordings/drives.ts"
import { notifyDrive } from "./recordings/notify.ts"
import { Library } from "./recordings/library.ts"
import type { Services } from "./recordings/routes.ts"
import { Thumbnailer } from "./recordings/thumb_worker.ts"
import { Uploads } from "./recordings/uploads.ts"

export function makeServices(config: Config): Services {
    const library = new Library(config)
    const jobs = new Jobs()
    jobs.onChange = (job) => library.emit({ type: "job", job })
    const thumbnails = new Thumbnailer(library)
    const drives = new Drives(config.dataDir, (drive) => notifyDrive(config, drive))
    // a drive's recordings get previews too, first, so the transfer dialog can show which is which
    thumbnails.extra = () => drives.files()
    const transfers = new Transfers(library, drives)
    return { library, jobs, thumbnails, uploads: new Uploads(config), drives, transfers }
}
