'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** Content to render when no error is caught. */
  children: ReactNode;
  /** Custom fallback override. Defaults to a minimal panel with retry. */
  fallback?: ReactNode;
  /** Called when an error is caught (for logging / analytics). */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Generic error boundary that catches render errors within its subtree.
 * Renders a compact "Something went wrong" panel with a retry button.
 * Mirrors the Bulk reference's inline error state (small, monospace, no
 * full-page takeover).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          data-testid="error-boundary-fallback"
          className="flex flex-col items-center gap-2 rounded border border-border bg-surface-1 p-4 text-center"
        >
          <p className="text-text-muted font-mono text-xs">
            Something went wrong.
          </p>
          <p className="text-text-faint font-mono text-[10px] max-w-xs truncate">
            {this.state.error.message}
          </p>
          <button
            type="button"
            data-testid="error-boundary-retry"
            onClick={this.handleRetry}
            className="rounded border border-border bg-surface-2 px-3 py-1 text-[11px] uppercase tracking-wider text-text-muted hover:text-text transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
