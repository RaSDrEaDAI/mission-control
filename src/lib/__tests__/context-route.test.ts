// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ----- Mocks --------------------------------------------------------------

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const prepare = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/db', () => ({ getDatabase: vi.fn(() => ({ prepare })) }))

// ----- DB state -----------------------------------------------------------

type Row = Record<string, unknown>

interface DbState {
  workspaces: Row[]
  projects: Row[]
  entries: Row[]
  inserted: number[]
}

let state: DbState
let nextRowId = 100

function freshState(): DbState {
  return {
    workspaces: [
      { id: 1, slug: 'default', name: 'Default', tenant_id: 1, created_at: 1, updated_at: 1 },
    ],
    projects: [{ id: 7, slug: 'integration', name: 'Integration', workspace_id: 1 }],
    entries: [],
    inserted: [],
  }
}

function buildPrepareMock(): (sql: string) => Record<string, unknown> {
  return (sql: string) => {
    if (sql.includes('FROM workspaces') && sql.includes('WHERE id = ? AND tenant_id = ?')) {
      return {
        get: (workspaceId: number, tenantId: number) =>
          state.workspaces.find((w) => w.id === workspaceId && w.tenant_id === tenantId),
      }
    }
    if (sql.includes('FROM projects p') && sql.includes('JOIN workspaces w')) {
      return {
        get: (projectId: number, workspaceId: number, tenantId: number) => {
          const project = state.projects.find(
            (p) => p.id === projectId && p.workspace_id === workspaceId,
          )
          const workspace = state.workspaces.find(
            (w) => w.id === workspaceId && w.tenant_id === tenantId,
          )
          return project && workspace
            ? { id: project.id, slug: project.slug, name: project.name }
            : undefined
        },
      }
    }

    if (sql.match(/SELECT \* FROM project_context_entries WHERE.*ORDER BY/)) {
      return {
        all: (...args: unknown[]) => {
          let rows = state.entries.filter((e) => e.project_id === args[0])
          if (sql.includes('entry_type = ?')) {
            rows = rows.filter((e) => e.entry_type === args[1])
          }
          return rows
        },
      }
    }
    if (sql.match(/SELECT \* FROM project_context_entries WHERE id = \?/)) {
      return { get: (id: number) => state.entries.find((e) => e.id === id) }
    }
    if (sql.match(/SELECT COUNT\(\*\) as total FROM project_context_entries/)) {
      return {
        get: (...args: unknown[]) => {
          let rows = state.entries.filter((e) => e.project_id === args[0])
          if (sql.includes('entry_type = ?')) {
            rows = rows.filter((e) => e.entry_type === args[1])
          }
          return { total: rows.length }
        },
      }
    }
    if (sql.includes('INSERT INTO project_context_entries')) {
      return {
        run: (...args: unknown[]) => {
          const id = ++nextRowId
          state.inserted.push(id)
          state.entries.push({
            id,
            project_id: args[0],
            workspace_id: args[1],
            entry_type: args[2],
            title: args[3],
            content: args[4],
            source: args[5],
            metadata: args[6],
            created_by: args[7],
            created_at: 1,
            updated_at: 1,
          })
          return { lastInsertRowid: id, changes: 1 }
        },
      }
    }
    if (sql.match(/DELETE FROM project_context_entries WHERE id = \? AND project_id = \?/)) {
      return {
        run: (entryId: number, projectId: number) => {
          const before = state.entries.length
          state.entries = state.entries.filter(
            (e) => !(e.id === entryId && e.project_id === projectId),
          )
          return { changes: before - state.entries.length }
        },
      }
    }

    throw new Error(`Unexpected SQL in test: ${sql.slice(0, 100)}`)
  }
}

// ----- Helpers ------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state = freshState()
  nextRowId = 100
  requireRole.mockReturnValue({
    user: { id: 1, username: 'tester', role: 'operator', workspace_id: 1, tenant_id: 1 },
  })
  mutationLimiter.mockReturnValue(null)
  prepare.mockImplementation(buildPrepareMock())
})

async function listContext(query = '', projectId = '7') {
  const { GET } = await import('@/app/api/projects/[id]/context/route')
  const req = new NextRequest(
    `http://localhost/api/projects/${projectId}/context${query ? '?' + query : ''}`,
  )
  return GET(req, { params: Promise.resolve({ id: projectId }) })
}

async function createContext(body: unknown, projectId = '7') {
  const { POST } = await import('@/app/api/projects/[id]/context/route')
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/context`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req, { params: Promise.resolve({ id: projectId }) })
}

async function deleteContext(entryId: string, projectId = '7') {
  const mod = await import('@/app/api/projects/[id]/context/[entryId]/route')
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/context/${entryId}`, {
    method: 'DELETE',
  })
  return mod.DELETE(req, { params: Promise.resolve({ id: projectId, entryId }) })
}

// ----- Tests --------------------------------------------------------------

describe('GET /api/projects/[id]/context', () => {
  it('returns paginated context entries', async () => {
    state.entries.push(
      {
        id: 1,
        project_id: 7,
        workspace_id: 1,
        entry_type: 'decision',
        title: 'BFF auth pattern',
        content: 'Session cookies + BFF.',
        source: null,
        metadata: '{}',
        created_by: 'tester',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        project_id: 7,
        workspace_id: 1,
        entry_type: 'meeting',
        title: 'Kickoff notes',
        content: 'Standup.',
        source: null,
        metadata: '{}',
        created_by: 'tester',
        created_at: 1,
        updated_at: 1,
      },
    )
    const res = await listContext()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: unknown[]; total: number }
    expect(body.entries).toHaveLength(2)
    expect(body.total).toBe(2)
  })

  it('filters by entry_type', async () => {
    state.entries.push(
      {
        id: 1,
        project_id: 7,
        workspace_id: 1,
        entry_type: 'decision',
        title: 'X',
        content: '',
        source: null,
        metadata: '{}',
        created_by: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        project_id: 7,
        workspace_id: 1,
        entry_type: 'meeting',
        title: 'Y',
        content: '',
        source: null,
        metadata: '{}',
        created_by: null,
        created_at: 1,
        updated_at: 1,
      },
    )
    const res = await listContext('entry_type=decision')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: { entry_type: string }[]; total: number }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].entry_type).toBe('decision')
    expect(body.total).toBe(1)
  })

  it('returns 400 for an unknown entry_type', async () => {
    const res = await listContext('entry_type=garbage')
    expect(res.status).toBe(400)
  })

  it('returns 404 when project not in scope', async () => {
    state.projects = []
    const res = await listContext()
    expect(res.status).toBe(404)
  })
})

describe('POST /api/projects/[id]/context (append)', () => {
  it('creates an entry (201)', async () => {
    const res = await createContext({
      entry_type: 'decision',
      title: 'BFF auth pattern locked in',
      content: 'Session cookies + BFF on Vercel + Bearer to VPS.',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      entry: { entry_type: string; title: string; created_by: string }
    }
    expect(body.entry.entry_type).toBe('decision')
    expect(body.entry.title).toBe('BFF auth pattern locked in')
    expect(body.entry.created_by).toBe('tester')
    expect(state.inserted).toHaveLength(1)
  })

  it('rejects missing title (400)', async () => {
    const res = await createContext({ entry_type: 'decision' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/title/)
  })

  it('rejects unknown entry_type (400)', async () => {
    const res = await createContext({ entry_type: 'random-type', title: 'X' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when project not in scope', async () => {
    state.projects = []
    const res = await createContext({ entry_type: 'decision', title: 'X' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/projects/[id]/context/[entryId]', () => {
  beforeEach(() => {
    state.entries.push({
      id: 42,
      project_id: 7,
      workspace_id: 1,
      entry_type: 'decision',
      title: 'X',
      content: '',
      source: null,
      metadata: '{}',
      created_by: null,
      created_at: 1,
      updated_at: 1,
    })
  })

  it('requires admin role (403 for operator)', async () => {
    // The default operator user is set in the outer beforeEach. The route
    // uses requireRole('admin'); simulate the auth-layer rejection.
    requireRole.mockReturnValue({ error: 'Requires admin role or higher', status: 403 })
    const res = await deleteContext('42')
    expect(res.status).toBe(403)
    // Entry must still be present
    expect(state.entries).toHaveLength(1)
  })

  it('admin can delete (200)', async () => {
    requireRole.mockReturnValue({
      user: { id: 1, username: 'admin', role: 'admin', workspace_id: 1, tenant_id: 1 },
    })
    const res = await deleteContext('42')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; deleted: boolean }
    expect(body.id).toBe(42)
    expect(body.deleted).toBe(true)
    expect(state.entries).toHaveLength(0)
  })

  it('returns 404 when entry does not exist', async () => {
    requireRole.mockReturnValue({
      user: { id: 1, username: 'admin', role: 'admin', workspace_id: 1, tenant_id: 1 },
    })
    const res = await deleteContext('999')
    expect(res.status).toBe(404)
  })

  it('returns 400 for non-numeric entryId', async () => {
    requireRole.mockReturnValue({
      user: { id: 1, username: 'admin', role: 'admin', workspace_id: 1, tenant_id: 1 },
    })
    const res = await deleteContext('abc')
    expect(res.status).toBe(400)
  })

  it('returns 404 when project not in scope', async () => {
    requireRole.mockReturnValue({
      user: { id: 1, username: 'admin', role: 'admin', workspace_id: 1, tenant_id: 1 },
    })
    state.projects = []
    const res = await deleteContext('42')
    expect(res.status).toBe(404)
  })
})
