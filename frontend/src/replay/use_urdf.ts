// The recording's robot model, the way the Controller gets it live: the URDF from its urdf_info stream (the latest
// message) and each mesh from its mesh_info stream (MeshFile, named by URI). The Controller asks for meshes on
// /mesh_request; a recording holds whatever was asked for while it ran (dim-controller's recorder asks for every mesh
// its URDF names), read here once, two at a time.
import { useEffect, useMemo, useState } from "react"
import type * as THREE from "three"
import type { Overview } from "./api.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf, type UrdfDescription } from "./urdf.ts"

const MESHES_IN_FLIGHT = 2

export interface RecordingUrdf {
    xml: string | null
    description: UrdfDescription | null
    /** loaded meshes by URI, shared by every model built from the description */
    geometries: Map<string, THREE.BufferGeometry>
    /** bumped whenever a mesh is loaded */
    meshVersion: number
    meshesLoaded: number
    meshesWanted: number
    /** mesh_info messages in the recording (0: the URDF's meshes weren't recorded) */
    meshesRecorded: number
    problem: string | null
}

const streamNamed = (overview: Overview, name: string) =>
    overview.streams.find((each) => new RegExp(`(^|/)${name}$`).test(each.name) && each.count > 0)

export function useRecordingUrdf(overview: Overview): RecordingUrdf {
    const geometries = useMemo(() => new Map<string, THREE.BufferGeometry>(), [overview])
    const [xml, setXml] = useState<string | null>(null)
    const [meshVersion, setMeshVersion] = useState(0)
    const [problem, setProblem] = useState<string | null>(null)
    const meshStream = streamNamed(overview, "mesh_info")

    useEffect(() => {
        const stream = streamNamed(overview, "urdf_info")
        if (!stream) {
            return
        }
        let gone = false
        const url = `api/replay/${encodeURIComponent(overview.id)}/message?stream=${
            encodeURIComponent(stream.name)
        }&t=${overview.end - overview.start}`
        fetch(url)
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => !gone && typeof body?.message?.data === "string" && setXml(body.message.data))
            .catch(() => {})
        return () => {
            gone = true
        }
    }, [overview])

    const { description, parseProblem } = useMemo(() => {
        if (!xml) {
            return { description: null, parseProblem: null }
        }
        try {
            return { description: parseUrdf(xml), parseProblem: null }
        } catch (error) {
            return { description: null, parseProblem: `urdf_info: ${error instanceof Error ? error.message : error}` }
        }
    }, [xml])
    const wanted = useMemo(() => new Set(description ? meshUris(description) : []), [description])

    useEffect(() => {
        if (!meshStream || !wanted.size) {
            return
        }
        let gone = false
        let next = 0
        const failures: string[] = []
        const load = async () => {
            while (!gone && next < meshStream.count && [...wanted].some((uri) => !geometries.has(uri))) {
                const index = next++
                const response = await fetch(
                    `api/replay/${encodeURIComponent(overview.id)}/raw?stream=${
                        encodeURIComponent(meshStream.name)
                    }&index=${index}`,
                )
                if (gone || !response.ok) {
                    continue
                }
                try {
                    const mesh = decodeMeshFile(new Uint8Array(await response.arrayBuffer()))
                    if (gone || geometries.has(mesh.uri) || !wanted.has(mesh.uri)) {
                        continue
                    }
                    geometries.set(mesh.uri, meshGeometry(mesh.uri, mesh.data))
                    setMeshVersion((version) => version + 1)
                } catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error))
                    setProblem(`mesh_info: ${failures.length} unreadable (${failures[0]})`)
                }
            }
        }
        for (let worker = 0; worker < MESHES_IN_FLIGHT; worker++) {
            load()
        }
        return () => {
            gone = true
        }
    }, [overview, meshStream, wanted, geometries])

    useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries])

    return {
        xml,
        description,
        geometries,
        meshVersion,
        meshesLoaded: [...wanted].filter((uri) => geometries.has(uri)).length,
        meshesWanted: wanted.size,
        meshesRecorded: meshStream?.count ?? 0,
        problem: parseProblem ?? problem,
    }
}
