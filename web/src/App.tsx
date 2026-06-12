import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage } from './pages/DashboardPage'
import { PromptsPage } from './pages/PromptsPage'
import { YoloPage } from './pages/YoloPage'
import { EvolutionPage } from './pages/EvolutionPage'
import { SSOTPage } from './pages/SSOTPage'
import { PilotPage } from './pages/PilotPage'
import ProlusionPage from './pages/ProlusionPage'
import { StartAgentPage } from './pages/StartAgentPage'
import { CheckupEventsPage } from './pages/CheckupEventsPage'
// Self-host the checkup widget (dogfood). Side-effect import registers the
// <polar-checkup> custom element so the JSX tag below works.
import './checkup'

declare module 'react' {
  // Allow <polar-checkup> in JSX with the data-* attributes we expose.
  namespace JSX {
    interface IntrinsicElements {
      'polar-checkup': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'data-project'?: string
        'data-hub-url'?: string
        'data-position'?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
      }
    }
  }
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#e6edf3', background: '#0d1117', minHeight: '100vh' }}>
          <h2 style={{ color: '#f85149', marginBottom: 16 }}>页面出错</h2>
          <pre style={{ background: '#161b22', padding: 16, borderRadius: 8, overflow: 'auto', fontSize: 13, lineHeight: 1.6 }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button onClick={() => { this.setState({ error: null }); window.location.reload() }}
            style={{ marginTop: 16, padding: '8px 16px', background: '#238636', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            刷新页面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter basename={basename}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
            <Route path="/ssot" element={<SSOTPage />} />
            <Route path="/prolusion" element={<ProlusionPage />} />
            <Route path="/yolo" element={<YoloPage />} />
            <Route path="/pilot" element={<PilotPage />} />
            <Route path="/evolution" element={<EvolutionPage />} />
            <Route path="/start-agent" element={<StartAgentPage />} />
            <Route path="/checkup-events" element={<CheckupEventsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      {/* Dogfood: same widget that ships to all hosts is also embedded here. */}
      <polar-checkup
        data-project="PolarCopilot"
        data-position="bottom-right"
      />
    </ErrorBoundary>
  )
}
