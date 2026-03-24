"use client"

import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * React error boundary — catches render errors in the subtree and shows
 * a clean fallback instead of a blank screen.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePageComponent />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center">
          <div className="h-12 w-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-4">
            <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-2">Something went wrong</h2>
          <p className="text-sm text-zinc-400 max-w-sm mb-6">
            This section failed to load. The error has been logged automatically.
          </p>
          {process.env.NODE_ENV === "development" && this.state.error && (
            <pre className="text-left text-xs text-red-400 bg-zinc-900 border border-zinc-800 rounded-lg p-4 max-w-lg overflow-auto mb-6 max-h-40">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-3">
            <button onClick={this.handleReset} className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">
              Try again
            </button>
            <button onClick={() => window.location.reload()} className="px-4 py-2 text-sm font-medium rounded-lg bg-green-500 text-zinc-950 hover:bg-green-400 transition-colors">
              Reload page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
