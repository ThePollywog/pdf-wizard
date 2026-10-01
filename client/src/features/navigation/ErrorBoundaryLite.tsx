/** Minimal error boundary for the navigation overlay root (outside the app's own boundaries). */
import { Component, type ReactNode } from 'react';

export class ErrorBoundaryLite extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn(`[navigation] ${this.props.name} crashed`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
