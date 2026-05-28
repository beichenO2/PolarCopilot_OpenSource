import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { PromptsPage } from './pages/PromptsPage'
import { YoloPage } from './pages/YoloPage'

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
            <Route path="/" element={<Navigate to="/prompts" replace />} />
            <Route path="/prompts" element={<PromptsPage />} />
            <Route path="/yolo" element={<YoloPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
