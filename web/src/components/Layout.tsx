import { Outlet, useLocation } from 'react-router-dom'
import { Nav } from './Nav'

export function Layout() {
  const { pathname } = useLocation()
  const isRr = pathname === '/rr' || pathname.endsWith('/rr')

  return (
    <div className={isRr ? 'flex h-screen flex-col overflow-hidden' : 'flex min-h-screen flex-col'}>
      <header className="flex shrink-0 items-center gap-3 border-b border-hub-border px-6 py-4">
        <h1 className="text-lg font-semibold text-hub-accent">PolarCopilot</h1>
        <span className="text-xs text-hub-text-muted">Hub Control</span>
        <div className="ml-auto">
          <Nav />
        </div>
      </header>
      <main className={isRr ? 'min-h-0 w-full flex-1 overflow-hidden p-0' : 'w-full flex-1 p-6'}>
        <Outlet />
      </main>
    </div>
  )
}
