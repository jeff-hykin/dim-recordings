// One Desktop notification per plugged-in drive with recordings on it (Desktop's POST /api/notifications); its action
// opens this app on the transfer dialog (`open:<app>/#/transfer`: Desktop's shell opens the app at that path).
import type { Config } from "../config.ts"
import type { Drive } from "./drives.ts"

export function driveNotification(appName: string, drive: Drive) {
    const bytes = drive.files.reduce((sum, file) => sum + file.size, 0)
    const count = drive.files.length
    return {
        title: "Transfer recordings",
        body: `${count} recording${count === 1 ? "" : "s"} on ${drive.name} (${(bytes / 1e9).toFixed(1)} GB)`,
        app: appName,
        kind: "ok",
        actions: [["Transfer recordings", `open:${appName}/#/transfer`]],
        details: { drive: drive.mount, files: drive.files.slice(0, 20).map((file) => file.relative) },
    }
}

export async function notifyDrive(config: Config, drive: Drive) {
    console.error(`drives: ${drive.mount} has ${drive.files.length} recording(s)`)
    if (!config.desktopUrl) {
        return
    }
    const response = await fetch(`${config.desktopUrl}/api/notifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(driveNotification(config.appName, drive)),
    })
    await response.body?.cancel()
    if (!response.ok) {
        console.error(`drives: Desktop's notifications answered ${response.status}`)
    }
}
