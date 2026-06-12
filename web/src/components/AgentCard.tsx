import { clsx } from 'clsx'
import { StatusDot } from './StatusDot'
import { timeAgo } from '../lib/time'
import type { Agent } from '../types/hub'

interface Props {
  agent: Agent
  selected?: boolean
  onClick?: () => void
  onDelete?: (id: string) => void
  slaves?: Agent[]
}

export function AgentCard({ agent, selected, onClick, onDelete, slaves }: Props) {
  const name = agent.display_name || agent.agent_id
  const typeBadge = agent.agent_type === 'slave' ? 'slave' : 'solo'

  return (
    <div
      onClick={onClick}
      className={clsx(
        'bg-hub-surface border rounded-[10px] p-3.5 cursor-pointer transition-colors relative group',
        selected ? 'border-hub-accent bg-[#1c2333]' : 'border-hub-border hover:border-hub-accent',
      )}
    >
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(agent.agent_id) }}
          className="absolute top-2 right-2 w-[22px] h-[22px] rounded flex items-center justify-center border border-hub-border text-hub-text-muted hover:bg-hub-red hover:border-hub-red hover:text-white opacity-0 group-hover:opacity-100 transition-all text-sm leading-none"
          title="Delete this agent"
        >
          ×
        </button>
      )}
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot alive={agent.alive} />
        <span className="text-[0.9rem] font-semibold break-all">{name}</span>
        <span className={clsx(
          'inline-block text-[0.65rem] px-1.5 py-px rounded font-semibold uppercase ml-1.5',
          typeBadge === 'solo'
            ? 'bg-[#1f3d2b] text-hub-green border border-[#238636]'
            : 'bg-[#2d2a10] text-hub-yellow border border-[#9e6a03]',
        )}>
          {typeBadge}
        </span>
      </div>
      <div className="text-xs text-hub-text-muted mb-1">
        {agent.role} ({agent.role_status})
      </div>
      <div className="text-[0.7rem] text-[#484f58]">
        {agent.label || ''} {agent.label ? '·' : ''} ping {timeAgo(agent.last_ping)}
      </div>

      {/* Embedded slave chips */}
      {slaves && slaves.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-dashed border-hub-border">
          {slaves.map((s) => (
            <SlaveChip key={s.agent_id} slave={s} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  )
}

function SlaveChip({ slave, onDelete }: { slave: Agent; onDelete?: (id: string) => void }) {
  const name = slave.display_name || slave.agent_id
  return (
    <span className="group/chip inline-flex items-center gap-1.5 bg-[#1c2128] border border-hub-border rounded-md px-2.5 py-1 text-[0.72rem] text-hub-text hover:border-hub-yellow hover:bg-[#2d2a10] transition-colors max-w-[180px] relative">
      <span className={clsx(
        'w-1.5 h-1.5 rounded-full flex-shrink-0',
        slave.alive
          ? 'bg-hub-green shadow-[0_0_3px_var(--tw-shadow-color)] shadow-hub-green'
          : 'bg-hub-red shadow-[0_0_3px_var(--tw-shadow-color)] shadow-hub-red',
      )} />
      <span className="truncate max-w-[120px]" title={name}>{name}</span>
      <span className="bg-[#2d2a10] text-hub-yellow border border-[#9e6a03] text-[0.55rem] px-1 rounded font-bold uppercase leading-tight flex-shrink-0">
        slave
      </span>
      {onDelete && (
        <span
          onClick={(e) => { e.stopPropagation(); onDelete(slave.agent_id) }}
          className="hidden group-hover/chip:inline ml-auto text-hub-text-muted hover:text-hub-red cursor-pointer text-xs flex-shrink-0"
          title="Remove"
        >
          ×
        </span>
      )}
    </span>
  )
}
