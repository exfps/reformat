import { Component, type ErrorInfo, type ReactNode } from "react";
import { LogoMark } from "./LogoMark";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Reformat UI error", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <LogoMark size={54} />
          <span className="eyebrow">RECOVERY</span>
          <h1>The workbench hit a snag.</h1>
          <p>Your files were not touched. Reload the window to get back to the queue.</p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            <span>Reload Reformat</span>
            <span className="primary-arrow">↻</span>
          </button>
        </div>
      </div>
    );
  }
}
