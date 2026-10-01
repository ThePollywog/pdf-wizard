import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { Button, EmptyState } from '@/core/ui';

interface Props {
  /** Shown in the fallback, e.g. "the Comments panel". */
  name: string;
  children: ReactNode;
  /** Render a compact fallback (panels, toolbars). */
  compact?: boolean;
  /** Changing this value resets the boundary (e.g. the document or task id). */
  resetKey?: unknown;
  /** Render nothing on error (for small, optional UI like option bars). */
  silent?: boolean;
}

interface State {
  error: Error | null;
  key: unknown;
}

/**
 * Isolates feature UI so one broken component never takes the shell down.
 * The error is logged; the fallback offers "Try again".
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[shell] ${this.props.name} crashed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className={this.props.compact ? 'error-boundary is-compact' : 'error-boundary'} role="alert" data-testid="error-boundary">
        <EmptyState
          compact={this.props.compact}
          icon={CircleAlert}
          title={`Something went wrong in ${this.props.name}`}
          description={<span className="error-boundary-msg">{error.message || 'Unknown error'}</span>}
          action={
            <Button size="sm" icon={RotateCcw} onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
