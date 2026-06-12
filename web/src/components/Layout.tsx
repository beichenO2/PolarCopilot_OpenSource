import { Outlet } from 'react-router-dom'
import { Nav } from './Nav'

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-4 border-b border-hub-border flex items-center gap-3">
        <h1 className="text-lg font-semibold text-hub-accent">PolarCopilot</h1>
        <span className="text-xs text-hub-text-muted">Hub Control</span>
        <div className="ml-auto">
          <Nav />
        </div>
      </header>
      <main className="flex-1 w-full p-6">
        <Outlet />
      </main>
    </div>
  )
}
