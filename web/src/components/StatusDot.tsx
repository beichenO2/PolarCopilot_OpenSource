import { clsx } from 'clsx'

export function StatusDot({ alive, className }: { alive: boolean; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block w-2 h-2 rounded-full shrink-0',
        alive
          ? 'bg-hub-green shadow-[0_0_4px_theme(colors.hub.green)]'
          : 'bg-hub-red',
        className,
      )}
    />
  )
}
