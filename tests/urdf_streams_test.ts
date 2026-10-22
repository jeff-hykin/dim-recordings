// The Replayer finds a recording's robot model under dimos's names (robot_description, file_info/**) and the old ones.
import { assertEquals } from "@std/assert"
import { descriptionStream, fileStreams } from "../frontend/src/replay/urdf_streams.ts"

const streams = (...names: string[]) => names.map((name) => ({ name, count: 1 }))

Deno.test("urdf streams: robot_description over urdf_info; urdf_info when it's the only one", () => {
    assertEquals(descriptionStream(streams("/urdf_info", "/robot_description"))?.name, "/robot_description")
    assertEquals(descriptionStream(streams("odom", "urdf_info"))?.name, "urdf_info")
    assertEquals(descriptionStream(streams("robot_description_old", "tf")), undefined)
    assertEquals(descriptionStream([{ name: "/robot_description", count: 0 }]), undefined)
})

Deno.test("urdf streams: every file_info stream (the recorder keeps each answer's topic), mesh_info only without them", () => {
    const names = (list: { name: string }[]) => list.map((each) => each.name)
    assertEquals(
        names(
            fileStreams(streams("/file_info", "/file_info/r1", "/file_info/a/b", "/mesh_info", "/file_infos", "/tf")),
        ),
        ["/file_info", "/file_info/r1", "/file_info/a/b"],
    )
    assertEquals(names(fileStreams(streams("/mesh_info", "/tf"))), ["/mesh_info"])
    assertEquals(names(fileStreams(streams("/file_request"))), [])
})
