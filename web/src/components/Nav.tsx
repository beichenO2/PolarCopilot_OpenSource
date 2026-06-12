import { NavLink } from 'react-router-dom'
import { clsx } from 'clsx'

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/start-agent', label: 'Start Agent' },
  { to: '/prompts', label: 'Agent Control' },
  { to: '/ssot', label: 'SSoT' },
  { to: '/prolusion', label: 'Prolusion' },
  { to: '/yolo', label: 'YOLO' },
  { to: '/pilot', label: 'Pilot 状态' },
  { to: '/evolution', label: 'Evolution' },
  { to: '/checkup-events', label: '检修历史' },
]

export function Nav() {
  return (
    <nav className="flex gap-2 flex-wrap">
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          className={({ isActive }) =>
            clsx(
              'px-3 py-1.5 rounded-md text-sm border transition-all',
              isActive
                ? 'bg-hub-border border-hub-accent text-hub-accent'
                : 'bg-hub-surface border-hub-border text-hub-text hover:border-hub-accent hover:text-hub-accent',
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  )
}
