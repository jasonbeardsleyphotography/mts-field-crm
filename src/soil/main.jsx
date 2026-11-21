import React from "react";
import ReactDOM from "react-dom/client";
import SoilApp from "./SoilApp.jsx";

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h2 style={{ marginBottom: 10 }}>Something went wrong</h2>
        <p style={{ color: "#555", marginBottom: 14 }}>{String(this.state.error?.message || this.state.error)}</p>
        <button onClick={() => location.reload()} style={{ padding: "10px 16px" }}>Reload</button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(<Boundary><SoilApp /></Boundary>);
