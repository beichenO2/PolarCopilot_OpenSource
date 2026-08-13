/**
 * tools/router.ts — Host tool proxy for PolarUI workflow executor.
 *
 * Browser/Electron clients cannot access the filesystem or shell directly.
 * Hub runs on localhost and proxies safe, scoped operations.
 */

import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { SseHub } from '../broadcast/sse-hub.js'
import { pushAlert } from '../alerts/router.js'

const execFileAsync = promisify(execFile)

const POLARISOR_ROOT = resolve(
  process.env.POLARISOR_ROOT ?? join(homedir(), 'Polarisor')
)

function assertLocal(req: { socket?: { remoteAddress?: string | null } }): void {
  const addr = req.socket?.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
    throw new Error('tools proxy is localhost-only')
  }
}

function resolveWithinRoot(rawPath: string, cwd?: string): string {
  const base = cwd ? resolveWithinRoot(cwd) : POLARISOR_ROOT
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath)
  const rel = relative(POLARISOR_ROOT, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path outside Polarisor root: ${rawPath}`)
  }
  return abs
}

function globSimple(pattern: string, cwd: string): string[] {
  const results: string[] = []
  const root = resolveWithinRoot(cwd)

  function walk(dir: string, parts: string[], depth: number): void {
    if (depth >= parts.length) {
      results.push(relative(POLARISOR_ROOT, dir) || '.')
      return
    }
    const part = parts[depth]
    if (part === '**') {
      walk(dir, parts, depth + 1)
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const next = join(dir, entry.name)
          if (entry.isDirectory()) walk(next, parts, depth)
        }
      } catch { /* unreadable */ }
      return
    }
    if (part.includes('*')) {
      const re = new RegExp('^' + part.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (re.test(entry.name)) {
            const next = join(dir, entry.name)
            if (depth === parts.length - 1) {
              results.push(relative(POLARISOR_ROOT, next))
            } else if (entry.isDirectory()) {
              walk(next, parts, depth + 1)
            }
          }
        }
      } catch { /* unreadable */ }
      return
    }
    const next = join(dir, part)
    if (!existsSync(next)) return
    walk(next, parts, depth + 1)
  }

  const normalized = pattern.replace(/^\.\//, '')
  const parts = normalized.split('/').filter(Boolean)
  walk(root, parts, 0)
  return [...new Set(results)].sort()
}

async function runRipgrep(pattern: string, searchPath: string, caseInsensitive: boolean): Promise<string[]> {
  const abs = resolveWithinRoot(searchPath)
  const args = ['--no-heading', '--line-number', '--color=never', '-m', '200']
  if (caseInsensitive) args.push('-i')
  args.push(pattern, abs)

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: POLARISOR_ROOT,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout.split('\n').filter(Boolean)
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string }
    if (e.code === 1) return []
    if (e.code === 'ENOENT') {
      const grepArgs = ['-rn', '--', pattern, abs]
      if (caseInsensitive) grepArgs.unshift('-i')
      try {
        const { stdout } = await execFileAsync('grep', grepArgs, {
          cwd: POLARISOR_ROOT,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
        return stdout.split('\n').filter(Boolean)
      } catch (grepErr: unknown) {
        const ge = grepErr as { code?: number; stdout?: string }
        if (ge.code === 1) return []
        throw grepErr
      }
    }
    throw err
  }
}

export function createToolsRouter(deps: { sseHub?: SseHub } = {}): Router {
  const router = Router()

  router.post('/ui/tools/file-read', (req, res) => {
    try {
      assertLocal(req)
      const path = String(req.body?.path ?? '')
      if (!path) return res.status(400).json({ error: 'path required' })
      const abs = resolveWithinRoot(path)
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return res.status(404).json({ error: `file not found: ${path}` })
      }
      const encoding = String(req.body?.encoding ?? 'utf-8')
      const content = readFileSync(abs, encoding as BufferEncoding)
      return res.json({
        content,
        metadata: { path: relative(POLARISOR_ROOT, abs), size: Buffer.byteLength(content) },
      })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/file-write', (req, res) => {
    try {
      assertLocal(req)
      const path = String(req.body?.path ?? '')
      const content = String(req.body?.content ?? '')
      const createDirs = req.body?.create_dirs !== false
      if (!path) return res.status(400).json({ error: 'path required' })
      const abs = resolveWithinRoot(path)
      if (createDirs) mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content, 'utf-8')
      return res.json({ success: true, path: relative(POLARISOR_ROOT, abs) })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/shell-exec', async (req, res) => {
    try {
      assertLocal(req)
      const command = String(req.body?.command ?? '')
      if (!command.trim()) return res.status(400).json({ error: 'command required' })
      const cwdRaw = String(req.body?.cwd ?? '.')
      const cwd = resolveWithinRoot(cwdRaw)
      const timeoutMs = Math.min(Number(req.body?.timeout_s ?? 30) * 1000, 120_000)

      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, POLARISOR_ROOT },
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.stderr?.on('data', (d) => { stderr += String(d) })

      const exitCode: number = await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`command timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        child.on('close', (code) => {
          clearTimeout(timer)
          resolvePromise(code ?? 1)
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })

      return res.json({
        stdout,
        stderr,
        exit_code: exitCode,
        success: exitCode === 0,
      })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/git-commit', async (req, res) => {
    try {
      assertLocal(req)
      const message = String(req.body?.message ?? '').trim()
      if (!message) return res.status(400).json({ error: 'message required' })
      const push = req.body?.push !== false
      const branch = String(req.body?.branch ?? 'main')
      const cwdRaw = String(req.body?.cwd ?? '.')
      const cwd = resolveWithinRoot(cwdRaw)
      const files = req.body?.files

      if (Array.isArray(files) && files.length) {
        await execFileAsync('git', ['add', ...files.map(String)], { cwd, timeout: 30_000 })
      } else {
        await execFileAsync('git', ['add', '-A'], { cwd, timeout: 30_000 })
      }

      const { stdout: commitOut } = await execFileAsync(
        'git',
        ['commit', '-m', message],
        { cwd, timeout: 30_000 }
      )

      let pushOut = ''
      if (push) {
        const r = await execFileAsync('git', ['push', 'origin', branch], { cwd, timeout: 120_000 })
        pushOut = r.stdout
      }

      const { stdout: hashOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10_000 })

      return res.json({
        commit_hash: hashOut.trim(),
        commit_output: commitOut.trim(),
        push_output: pushOut.trim(),
        pushed: push,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('nothing to commit')) {
        return res.status(409).json({ error: msg })
      }
      return res.status(400).json({ error: msg })
    }
  })

  router.post('/ui/tools/glob-search', (req, res) => {
    try {
      assertLocal(req)
      const pattern = String(req.body?.pattern ?? '')
      if (!pattern) return res.status(400).json({ error: 'pattern required' })
      const cwd = String(req.body?.cwd ?? '.')
      const files = globSimple(pattern, cwd)
      return res.json({ files, count: files.length })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/grep-search', async (req, res) => {
    try {
      assertLocal(req)
      const pattern = String(req.body?.pattern ?? '')
      const searchPath = String(req.body?.path ?? '.')
      if (!pattern) return res.status(400).json({ error: 'pattern required' })
      const lines = await runRipgrep(pattern, searchPath, req.body?.case_insensitive === true)
      const matches = lines.map((line) => {
        const m = line.match(/^(.+?):(\d+):(.*)$/)
        return m
          ? { file: m[1], line: Number(m[2]), text: m[3] }
          : { file: searchPath, line: 0, text: line }
      })
      return res.json({ matches, count: matches.length })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/notification', async (req, res) => {
    try {
      assertLocal(req)
      const message = String(req.body?.message ?? '')
      const channel = String(req.body?.channel ?? 'desktop')
      const title = String(req.body?.title ?? 'PolarUI')
      if (!message.trim()) return res.status(400).json({ error: 'message required' })

      if (channel === 'desktop') {
        const escaped = message.replace(/"/g, '\\"')
        await execFileAsync('osascript', [
          '-e',
          `display notification "${escaped}" with title "${title.replace(/"/g, '\\"')}"`,
        ], { timeout: 10_000 })
        return res.json({ sent: true, channel })
      }

      if (channel === 'webhook') {
        const url = String(req.body?.webhook_url ?? '')
        if (!url) return res.status(400).json({ error: 'webhook_url required for webhook channel' })
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, message }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!r.ok) throw new Error(`webhook ${r.status}`)
        return res.json({ sent: true, channel })
      }

      if (channel === 'feishu') {
        const alert = {
          id: randomUUID(),
          source: 'polarui-notification',
          severity: 'info' as const,
          title,
          detail: message,
          timestamp: new Date().toISOString(),
        }
        if (deps.sseHub) {
          try { deps.sseHub.broadcast('alert_new', JSON.stringify(alert)) } catch { /* best effort */ }
        }
        return res.json({ sent: true, channel: 'feishu', note: 'feishu relay via Hub alert SSE' })
      }

      return res.status(400).json({ error: `unknown channel: ${channel}` })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/output-display', (req, res) => {
    try {
      assertLocal(req)
      const content = req.body?.content
      const format = String(req.body?.format ?? 'auto')
      const title = String(req.body?.title ?? '工作流中间结果')
      let detail: string
      if (format === 'json' || (format === 'auto' && typeof content === 'object')) {
        detail = JSON.stringify(content, null, 2)
      } else {
        detail = String(content ?? '')
      }
      const alert = pushAlert(
        {
          source: 'polarui-output-display',
          severity: 'info',
          title,
          detail: detail.slice(0, 8000),
          timestamp: new Date().toISOString(),
        },
        deps.sseHub,
      )
      return res.json({ displayed: true, alert_id: alert.id })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/session-search', (req, res) => {
    try {
      assertLocal(req)
      const query = String(req.body?.query ?? '').toLowerCase()
      const limit = Math.min(Number(req.body?.limit ?? 10), 50)
      if (!query) return res.status(400).json({ error: 'query required' })

      const transcriptsRoot = join(
        homedir(),
        '.cursor',
        'projects',
        'Users-mac-Polarisor',
        'agent-transcripts'
      )
      const matches: Array<{ session_id: string; line: number; snippet: string }> = []

      function walk(dir: string): void {
        if (!existsSync(dir)) return
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          if (!entry.name.endsWith('.jsonl')) continue
          const sessionId = entry.name.replace(/\.jsonl$/, '')
          const lines = readFileSync(full, 'utf-8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (!line.toLowerCase().includes(query)) continue
            matches.push({
              session_id: sessionId,
              line: i + 1,
              snippet: line.slice(0, 300),
            })
            if (matches.length >= limit) return
          }
        }
      }

      walk(transcriptsRoot)
      return res.json({ matches, count: matches.length })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/ui/tools/ecosystem-scan', (req, res) => {
    try {
      assertLocal(req)
      const root = POLARISOR_ROOT
      const projects: Array<Record<string, unknown>> = []
      const ssotMap: Record<string, unknown> = {}

      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const polarisPath = join(root, entry.name, 'polaris.json')
        if (!existsSync(polarisPath)) continue
        try {
          const polaris = JSON.parse(readFileSync(polarisPath, 'utf-8')) as Record<string, unknown>
          const name = String(polaris.name ?? entry.name)
          const reqs = Array.isArray(polaris.requirements) ? polaris.requirements : []
          let done = 0
          let total = 0
          for (const r of reqs) {
            const features = (r as { features?: Array<{ status?: string }> }).features ?? []
            for (const f of features) {
              total++
              if (f.status === 'done') done++
            }
          }
          const summary = {
            name,
            path: entry.name,
            status: polaris.status ?? 'unknown',
            version: polaris.version ?? '',
            requirement_count: reqs.length,
            feature_done: done,
            feature_total: total,
          }
          projects.push(summary)
          ssotMap[name] = polaris
        } catch { /* skip bad polaris */ }
      }

      projects.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      return res.json({ projects, ssot_map: ssotMap, count: projects.length })
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
