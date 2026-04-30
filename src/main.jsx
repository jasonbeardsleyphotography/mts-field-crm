import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { vlogError } from './videoLog'

/* ═══════════════════════════════════════════════════════════════════════════
   Error Boundary — catches uncaught render errors and shows them on screen
   instead of leaving the user with a blank black screen. Without this,
   any Rules-of-Hooks violation, TDZ access, or runtime crash inside the
   App tree results in React quietly unmounting everything.

   The shown error includes the message and a "Reload app" button. If the
   user is technical they can also tap "Show details" to see the stack.
   ═══════════════════════════════════════════════════════════════════════════ */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, showDetails: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error("[AppErrorBoundary]", error, info); } catch {}
    // Also write to videoLog so the diagnostic panel can pick it up later
    try {
      vlogError("app.boundary", { msg: error?.message || String(error), stack: (error?.stack || "").slice(0, 800) });
    } catch {}
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { error, info, showDetails } = this.state;
    return (
      <div style={{
        minHeight: "100dvh",
        background: "#0a0b10",
        color: "#e0e8f0",
        padding: 20,
        fontFamily: "system-ui, sans-serif",
        boxSizing: "border-box",
      }}>
        <div style={{ maxWidth: 480, margin: "40px auto" }}>
          <div style={{
            fontSize: 24, fontWeight: 900, letterSpacing: 2,
            textTransform: "uppercase", color: "#FF5555", marginBottom: 12,
            fontFamily: "'Oswald', sans-serif",
          }}>App Error</div>
          <div style={{ fontSize: 13, color: "#a0b0c0", lineHeight: 1.5, marginBottom: 16 }}>
            Something crashed before the app could load. This is almost certainly a bug.
            Try reloading first; if it happens again, tap "Show details" and screenshot the result.
          </div>
          <div style={{
            background: "#1a0a0a",
            border: "1px solid rgba(255,85,85,.3)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            color: "#FF8888",
            wordBreak: "break-word",
          }}>
            {error?.message || String(error)}
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button
              onClick={() => { try { location.reload(); } catch {} }}
              style={{
                flex: 1, padding: "12px 0", borderRadius: 8,
                background: "rgba(59,130,246,.18)",
                border: "1px solid rgba(59,130,246,.4)",
                color: "#3B82F6", fontSize: 13, fontWeight: 700,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >Reload app</button>
            <button
              onClick={() => this.setState({ showDetails: !showDetails })}
              style={{
                flex: 1, padding: "12px 0", borderRadius: 8,
                background: "transparent", border: "1px solid #252d47",
                color: "#5a6580", fontSize: 13, fontWeight: 600,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >{showDetails ? "Hide details" : "Show details"}</button>
          </div>
          {showDetails && (
            <div style={{
              background: "#080a14",
              border: "1px solid #1a2030",
              borderRadius: 8,
              padding: 10,
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 10,
              color: "#7a8090",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 320,
              overflowY: "auto",
            }}>
              {error?.stack || "no stack"}
              {info?.componentStack ? "\n\n--- React component stack ---\n" + info.componentStack : ""}
            </div>
          )}
          <div style={{ fontSize: 10, color: "#4a5a70", marginTop: 24, textAlign: "center" }}>
            If reloading doesn't fix it, force-quit the browser and reopen.
          </div>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
)
