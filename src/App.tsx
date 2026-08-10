import { Component, type ReactNode } from 'react'
import AppFrame from './components/AppFrame.tsx'
import ChatView from './components/ChatView.tsx'

interface EBState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null }

  static getDerivedStateFromError(error: Error): EBState {
    return { error }
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div className="flex h-full items-center justify-center bg-bg font-mono">
          <div className="max-w-lg border border-amber-hi p-6">
            <div className="mb-3 text-[11px] tracking-[2px] text-amber-hi">ERROR DE RENDERIZADO</div>
            <div className="mb-2 text-xs text-ink">{error.message}</div>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 border border-line px-3 py-1 text-[11px] text-faint hover:border-amber hover:text-ink"
            >
              reintentar
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <AppFrame>
      <ErrorBoundary>
        <ChatView />
      </ErrorBoundary>
    </AppFrame>
  )
}
