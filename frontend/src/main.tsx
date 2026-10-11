import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import { App } from "./App.tsx"
import "./app.css"

// Desktop's skin (followed live), the zenoh-gateway data source, toasts and dialogs: dimos-react's AppProvider
createRoot(document.getElementById("root")!).render(
    <AppProvider url={false}>
        <App />
    </AppProvider>,
)
