// Phone layout when the screen is narrow or the only pointer is a finger.
import { useEffect, useState } from "react"

const QUERY = "(max-width: 720px), (pointer: coarse) and (max-width: 1024px)"

export function useMobile(): boolean {
    const [mobile, setMobile] = useState(() => matchMedia(QUERY).matches)
    useEffect(() => {
        const media = matchMedia(QUERY)
        const onChange = () => setMobile(media.matches)
        media.addEventListener("change", onChange)
        return () => media.removeEventListener("change", onChange)
    }, [])
    return mobile
}
