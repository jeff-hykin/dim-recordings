// The recording's robot model, the way the Controller gets it live: the URDF from its robot_description stream (the
// latest message) and each mesh from its file_info streams (files.MeshFile, named by URI). The Controller asks for files
// on /file_request and they're answered on /file_info or any topic under it; dim-controller's recorder asks for every
// mesh its URDF names and keeps each answer under its own topic, so every file_info stream is read, once, two at a time.
// Older recordings' urdf_info and mesh_info (shape_msgs.MeshFile, the same bytes) are read when the new names are absent.
import { useEffect, useMemo, useState } from "react"
import type * as THREE from "three"
import type { Overview } from "./api.ts"
import { descriptionStream, fileStreams } from "./urdf_streams.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf, type RobotDescription } from "dimos-react/three"

const MESHES_IN_FLIGHT = 2

export interface RecordingUrdf {
    xml: string | null
    description: RobotDescription | null
    /** loaded meshes by URI, shared by every model built from the description */
    geometries: Map<string, THREE.BufferGeometry>
    /** bumped whenever a mesh is loaded */
    meshVersion: number
    meshesLoaded: number
    meshesWanted: number
    /** file_info (or mesh_info) messages in the recording (0: the URDF's meshes weren't recorded) */
    meshesRecorded: number
    problem: string | null
}

export function useRecordingUrdf(overview: Overview): RecordingUrdf {
    const geometries = useMemo(() => new Map<string, THREE.BufferGeometry>(), [overview])
    const [xml, setXml] = useState<string | null>(null)
    const [meshVersion, setMeshVersion] = useState(0)
    const [problem, setProblem] = useState<string | null>(null)
    const meshStreams = useMemo(() => fileStreams(overview.streams), [overview])
    const descriptionTopic = descriptionStream(overview.streams)?.name ?? "robot_description"

    useEffect(() => {
        const stream = descriptionStream(overview.streams)
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
            return {
                description: null,
                parseProblem: `${descriptionTopic}: ${error instanceof Error ? error.message : error}`,
            }
        }
    }, [xml, descriptionTopic])
    const wanted = useMemo(() => new Set(description ? meshUris(description) : []), [description])

    useEffect(() => {
        if (!meshStreams.length || !wanted.size) {
            return
        }
        let gone = false
        const messages = meshStreams.flatMap((stream) =>
            Array.from({ length: stream.count }, (_, index) => ({ stream: stream.name, index }))
        )
        let next = 0
        const failures: string[] = []
        const load = async () => {
            while (!gone && next < messages.length && [...wanted].some((uri) => !geometries.has(uri))) {
                const { stream, index } = messages[next++]
                const response = await fetch(
                    `api/replay/${encodeURIComponent(overview.id)}/raw?stream=${
                        encodeURIComponent(stream)
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
                    setProblem(`${stream}: ${failures.length} unreadable (${failures[0]})`)
                }
            }
        }
        for (let worker = 0; worker < MESHES_IN_FLIGHT; worker++) {
            load()
        }
        return () => {
            gone = true
        }
    }, [overview, meshStreams, wanted, geometries])

    useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries])

    return {
        xml,
        description,
        geometries,
        meshVersion,
        meshesLoaded: [...wanted].filter((uri) => geometries.has(uri)).length,
        meshesWanted: wanted.size,
        meshesRecorded: meshStreams.reduce((total, stream) => total + stream.count, 0),
        problem: parseProblem ?? problem,
    }
}
