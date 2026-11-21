import React from "react";
import ReactDOM from "react-dom/client";
import DispatchApp from "./DispatchApp.jsx";

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, color: "#E7E2D6", fontFamily: "system-ui", background: "#14181C", minHeight: "100vh" }}>
        <h2 style={{ marginBottom: 10 }}>Dispatch hit an error</h2>
        <p style={{ color: "#98A3AB", marginBottom: 14 }}>{String(this.state.error?.message || this.state.error)}</p>
        <button onClick={() => location.reload()} style={{ padding: "8px 14px" }}>Reload</button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(<Boundary><DispatchApp /></Boundary>);
