// Which of a recording's streams hold its robot model: the URDF on robot_description (urdf_info in older recordings) and
// its files on file_info and every topic under it (mesh_info in older recordings), the recorder keeping each answer
// under its own topic (/file_info, /file_info/r1, ...).

interface Stream {
    name: string
    count: number
}

const named = <S extends Stream>(streams: S[], pattern: RegExp) =>
    streams.filter((each) => pattern.test(each.name) && each.count > 0)

/** The stream the URDF's XML is on, robot_description over urdf_info. */
export const descriptionStream = <S extends Stream>(streams: S[]): S | undefined =>
    named(streams, /(^|\/)robot_description$/)[0] ?? named(streams, /(^|\/)urdf_info$/)[0]

/** Every stream mesh files are on: file_info and those under it, else mesh_info. */
export function fileStreams<S extends Stream>(streams: S[]): S[] {
    const files = named(streams, /(^|\/)file_info(\/.+)?$/)
    return files.length ? files : named(streams, /(^|\/)mesh_info$/)
}
