/**
 * alerts/router.ts — Hub alerts endpoint.
 *
 * POST /api/ui/alerts — receive alert from Watchdog / PolarPilot / etc.
 * GET  /api/ui/alerts — list alerts (optional ?severity=critical&limit=20)
 * DELETE /api/ui/alerts/:id — acknowledge/clear alert
 *
 * Stores in memory (v1). Pushes SSE event on new alert.
 */

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import type { SseHub } from '../broadcast/sse-hub.js'

export interface Alert {
  id: string
  source: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detail: string
  timestamp: string
  acknowledged: boolean
}

const alerts: Alert[] = []
const MAX_ALERTS = 500

export type NewAlert = Omit<Alert, 'id' | 'acknowledged'> & { id?: string }

/** Persist alert for listActiveAlerts and optional SSE broadcast. */
export function pushAlert(alert: NewAlert, sseHub?: SseHub): Alert {
  const stored: Alert = {
    id: alert.id ?? randomUUID(),
    source: alert.source,
    severity: alert.severity,
    title: alert.title,
    detail: alert.detail,
    timestamp: alert.timestamp,
    acknowledged: false,
  }
  alerts.unshift(stored)
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS
  if (sseHub) {
    try {
      sseHub.broadcast('alert_new', JSON.stringify(stored))
    } catch { /* best effort */ }
  }
  return stored
}

/** Read active alerts for cross-module status (e.g. checkup history). */
export function listActiveAlerts(): Alert[] {
  return alerts.filter((a) => !a.acknowledged)
}

export function createAlertsRouter(deps: { sseHub?: SseHub }): Router {
  const router = Router()

  router.post('/ui/alerts', (req, res) => {
    const { source, severity, title, detail, timestamp } = req.body ?? {}
    if (!source || !title) {
      return res.status(400).json({ error: 'source and title are required' })
    }

    const alert = pushAlert(
      {
        source: String(source),
        severity: (['info', 'warning', 'critical'].includes(severity) ? severity : 'info') as Alert['severity'],
        title: String(title),
        detail: String(detail ?? ''),
        timestamp: String(timestamp ?? new Date().toISOString()),
      },
      deps.sseHub,
    )

    return res.status(201).json(alert)
  })

  router.get('/ui/alerts', (_req, res) => {
    const severity = _req.query.severity as string | undefined
    const limit = Math.min(Number(_req.query.limit) || 50, MAX_ALERTS)
    let result = alerts.filter(a => !a.acknowledged)
    if (severity) result = result.filter(a => a.severity === severity)
    return res.json(result.slice(0, limit))
  })

  router.delete('/ui/alerts/:id', (req, res) => {
    const alert = alerts.find(a => a.id === req.params.id)
    if (!alert) return res.status(404).json({ error: 'alert not found' })
    alert.acknowledged = true
    return res.json({ ok: true })
  })

  return router
}
