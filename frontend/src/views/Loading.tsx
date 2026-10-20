// What the list shows while the backend is scanning folders (a first load, a refresh, a folder just added in Settings)
// or reading the recordings it found (each one's streams, duration and warnings, in the background).
import { ListRow, Progress, Skeleton, Spinner, Text } from "dimos-react"

/** Placeholder rows shaped like the list's (a thumbnail, a name, a line under it). */
export function SkeletonRows({ count }: { count: number }) {
    return (
        <div data-testid="skeleton-rows" aria-busy="true">
            {Array.from({ length: count }, (_, index) => (
                <ListRow
                    key={index}
                    className="rec-row rec-row-skeleton"
                    icon={<Skeleton width={96} height={54} />}
                    title={<Skeleton width={`${70 - (index % 3) * 12}%`} height={13} />}
                    subtitle={<Skeleton width={`${45 - (index % 2) * 10}%`} height={10} />}
                />
            ))}
        </div>
    )
}

/** A strip at the top of the list: what the backend is busy with, with a bar (filling as recordings are read). */
export function ScanBar(
    { label, value }: { label: string; value?: number | null },
) {
    return (
        <div className="rec-scan" data-testid="scan-bar" role="status">
            <div className="rec-row-flex">
                <Spinner size={12} label={label} />
                <Text small muted>{label}</Text>
            </div>
            <Progress value={value} label={label} />
        </div>
    )
}
