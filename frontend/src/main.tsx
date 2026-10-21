import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import { setRenderingDefaults } from "dimos-react/three"
import { App } from "./App.tsx"
import "./app.css"

// voxels within 1.5 m of the camera shrink, so flying up to a wall shows what's behind it (Settings → Rendering overrides)
setRenderingDefaults({ nearShrink: 1.5 })

// Desktop's skin (followed live), the zenoh-gateway data source, toasts and dialogs: dimos-react's AppProvider
createRoot(document.getElementById("root")!).render(
    <AppProvider url={false}>
        <App />
    </AppProvider>,
)
