// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ----- Mocks --------------------------------------------------------------

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const prepare = vi.fn()
const signUpload = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/db', () => ({ getDatabase: vi.fn(() => ({ prepare })) }))
vi.mock('@/lib/cloudinary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cloudinary')>('@/lib/cloudinary')
  return { ...actual, signUpload }
})

// ----- DB state -----------------------------------------------------------

type Row = Record<string, unknown>

interface DbState {
  workspaces: Row[]
  projects: Row[]
  assets: Row[]
  brandings: Row[]
  inserted: number[]
  updatedBrandings: Array<{ args: unknown[] }>
}

let state: DbState
let nextRowId = 100

function freshState(): DbState {
  return {
    workspaces: [
      { id: 1, slug: 'default', name: 'Default', tenant_id: 1, created_at: 1, updated_at: 1 },
    ],
    projects: [{ id: 7, slug: 'integration', name: 'Integration', workspace_id: 1 }],
    assets: [],
    brandings: [],
    inserted: [],
    updatedBrandings: [],
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

    // SELECT with filters (list)
    if (sql.match(/SELECT \* FROM project_assets WHERE.*ORDER BY/)) {
      return {
        all: (...args: unknown[]) => {
          // args = [...filters, pageSize, offset]
          let filtered = state.assets.filter((a) => a.project_id === args[0])
          if (sql.includes('asset_type = ?')) {
            filtered = filtered.filter((a) => a.asset_type === args[1])
          }
          return filtered
        },
      }
    }

    // SELECT * by id
    if (sql.match(/SELECT \* FROM project_assets WHERE id = \?/)) {
      return { get: (id: number) => state.assets.find((a) => a.id === id) }
    }

    // Dup check on cloudinary_public_id
    if (sql.match(/SELECT id FROM project_assets WHERE cloudinary_public_id = \?/)) {
      return {
        get: (pid: string) => {
          const a = state.assets.find((x) => x.cloudinary_public_id === pid)
          return a ? { id: a.id } : undefined
        },
      }
    }

    // COUNT
    if (sql.match(/SELECT COUNT\(\*\) as total FROM project_assets WHERE/)) {
      return {
        get: (...args: unknown[]) => {
          let n = state.assets.filter((a) => a.project_id === args[0]).length
          if (sql.includes('asset_type = ?')) {
            n = state.assets.filter(
              (a) => a.project_id === args[0] && a.asset_type === args[1],
            ).length
          }
          return { total: n }
        },
      }
    }

    // INSERT into project_assets
    if (sql.includes('INSERT INTO project_assets')) {
      return {
        run: (...args: unknown[]) => {
          const id = ++nextRowId
          state.inserted.push(id)
          state.assets.push({
            id,
            project_id: args[0],
            workspace_id: args[1],
            cloudinary_public_id: args[2],
            cloudinary_url: args[3],
            asset_type: args[4],
            asset_category: args[5],
            original_filename: args[6],
            tags: args[7],
            metadata: args[8],
            uploaded_by: args[9],
            created_at: 1,
            updated_at: 1,
          })
          return { lastInsertRowid: id, changes: 1 }
        },
      }
    }

    // DELETE asset
    if (sql.match(/DELETE FROM project_assets WHERE id = \? AND project_id = \?/)) {
      return {
        run: (assetId: number, projectId: number) => {
          const before = state.assets.length
          state.assets = state.assets.filter(
            (a) => !(a.id === assetId && a.project_id === projectId),
          )
          return { changes: before - state.assets.length }
        },
      }
    }

    // UPDATE branding to clear logo_asset_id when an asset is deleted
    if (sql.includes('UPDATE project_branding SET logo_asset_id = NULL')) {
      return {
        run: (assetId: number) => {
          let n = 0
          for (const b of state.brandings) {
            if (b.logo_asset_id === assetId) {
              b.logo_asset_id = null
              n++
            }
          }
          state.updatedBrandings.push({ args: [assetId] })
          return { changes: n }
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

async function listAssets(query = '', projectId = '7') {
  const { GET } = await import('@/app/api/projects/[id]/assets/route')
  const req = new NextRequest(
    `http://localhost/api/projects/${projectId}/assets${query ? '?' + query : ''}`,
  )
  return GET(req, { params: Promise.resolve({ id: projectId }) })
}

async function recordAsset(body: unknown, projectId = '7') {
  const { POST } = await import('@/app/api/projects/[id]/assets/route')
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/assets`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req, { params: Promise.resolve({ id: projectId }) })
}

async function signAsset(body: unknown, projectId = '7') {
  const { POST } = await import('@/app/api/projects/[id]/assets/sign/route')
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/assets/sign`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req, { params: Promise.resolve({ id: projectId }) })
}

async function deleteAsset(assetId: string, projectId = '7') {
  const mod = await import('@/app/api/projects/[id]/assets/[assetId]/route')
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/assets/${assetId}`, {
    method: 'DELETE',
  })
  return mod.DELETE(req, { params: Promise.resolve({ id: projectId, assetId }) })
}

// ----- Tests --------------------------------------------------------------

describe('GET /api/projects/[id]/assets', () => {
  it('returns paginated list with total count', async () => {
    state.assets.push(
      {
        id: 1,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'a',
        cloudinary_url: 'https://x/a',
        asset_type: 'image',
        asset_category: null,
        original_filename: null,
        tags: '[]',
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'b',
        cloudinary_url: 'https://x/b',
        asset_type: 'video',
        asset_category: null,
        original_filename: null,
        tags: '[]',
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
    )
    const res = await listAssets()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assets: unknown[]; total: number }
    expect(body.assets).toHaveLength(2)
    expect(body.total).toBe(2)
  })

  it('filters by asset_type', async () => {
    state.assets.push(
      {
        id: 1,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'a',
        cloudinary_url: 'https://x/a',
        asset_type: 'image',
        asset_category: null,
        original_filename: null,
        tags: '[]',
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'b',
        cloudinary_url: 'https://x/b',
        asset_type: 'video',
        asset_category: null,
        original_filename: null,
        tags: '[]',
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
    )
    const res = await listAssets('asset_type=image')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assets: { asset_type: string }[]; total: number }
    expect(body.assets).toHaveLength(1)
    expect(body.assets[0].asset_type).toBe('image')
  })

  it('returns 400 for an unknown asset_type', async () => {
    const res = await listAssets('asset_type=invalid_type')
    expect(res.status).toBe(400)
  })

  it('filters by tag (in-memory filter on the page)', async () => {
    state.assets.push(
      {
        id: 1,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'a',
        cloudinary_url: 'https://x/a',
        asset_type: 'image',
        asset_category: null,
        original_filename: null,
        tags: JSON.stringify(['hero']),
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        project_id: 7,
        workspace_id: 1,
        cloudinary_public_id: 'b',
        cloudinary_url: 'https://x/b',
        asset_type: 'image',
        asset_category: null,
        original_filename: null,
        tags: JSON.stringify(['thumb']),
        metadata: '{}',
        uploaded_by: null,
        created_at: 1,
        updated_at: 1,
      },
    )
    const res = await listAssets('tag=hero')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assets: { tags: string[] }[] }
    expect(body.assets).toHaveLength(1)
    expect(body.assets[0].tags).toEqual(['hero'])
  })

  it('returns 404 when the project is not in scope', async () => {
    state.projects = []
    const res = await listAssets()
    expect(res.status).toBe(404)
  })

  it('returns 401 when requireRole rejects', async () => {
    requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })
    const res = await listAssets()
    expect(res.status).toBe(401)
  })
})

describe('POST /api/projects/[id]/assets (record)', () => {
  it('records an asset (201)', async () => {
    const res = await recordAsset({
      cloudinary_public_id: 'projects/x/images/abc',
      cloudinary_url: 'https://res.cloudinary.com/x/image/upload/v1/projects/x/images/abc.png',
      asset_type: 'image',
      asset_category: 'hero',
      original_filename: 'hero.png',
      tags: ['promo'],
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { asset: { cloudinary_public_id: string; tags: string[] } }
    expect(body.asset.cloudinary_public_id).toBe('projects/x/images/abc')
    expect(body.asset.tags).toEqual(['promo'])
    expect(state.inserted).toHaveLength(1)
  })

  it('returns 409 when cloudinary_public_id already recorded', async () => {
    state.assets.push({
      id: 1,
      project_id: 7,
      workspace_id: 1,
      cloudinary_public_id: 'already-exists',
      cloudinary_url: 'https://x',
      asset_type: 'image',
      asset_category: null,
      original_filename: null,
      tags: '[]',
      metadata: '{}',
      uploaded_by: null,
      created_at: 1,
      updated_at: 1,
    })
    const res = await recordAsset({
      cloudinary_public_id: 'already-exists',
      cloudinary_url: 'https://x',
      asset_type: 'image',
    })
    expect(res.status).toBe(409)
  })

  it('rejects missing cloudinary_public_id (400)', async () => {
    const res = await recordAsset({
      cloudinary_url: 'https://x',
      asset_type: 'image',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/cloudinary_public_id/)
  })

  it('rejects an unknown asset_type (400)', async () => {
    const res = await recordAsset({
      cloudinary_public_id: 'p',
      cloudinary_url: 'https://x',
      asset_type: 'not-a-real-type',
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when project not in scope', async () => {
    state.projects = []
    const res = await recordAsset({
      cloudinary_public_id: 'p',
      cloudinary_url: 'https://x',
      asset_type: 'image',
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/projects/[id]/assets/sign', () => {
  beforeEach(() => {
    signUpload.mockReturnValue({
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      resourceType: 'image',
      uploadUrl: 'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
      signature: 'abc123',
      timestamp: 1700000000,
      folder: 'projects/integration/images',
      publicId: 'xyz',
      tags: ['mission-control', 'integration', 'image'],
      context: {
        project_id: '7',
        project_slug: 'integration',
        asset_type: 'image',
        asset_category: '',
        uploaded_by: 'tester',
        source: 'mission-control',
      },
    })
  })

  it('returns a signed upload payload (200)', async () => {
    const res = await signAsset({ asset_type: 'image' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cloud_name: string
      signature: string
      upload_url: string
      folder: string
    }
    expect(body.cloud_name).toBe('test-cloud')
    expect(body.signature).toBe('abc123')
    expect(body.upload_url.startsWith('https://api.cloudinary.com/')).toBe(true)
    expect(body.folder).toBe('projects/integration/images')
  })

  it('passes the asset_type through to the resource_type folder convention', async () => {
    await signAsset({ asset_type: 'video' })
    // Confirm signUpload was called with the right resourceType (video)
    expect(signUpload).toHaveBeenCalledOnce()
    const call = signUpload.mock.calls[0][0] as { resourceType: string; folder: string }
    expect(call.resourceType).toBe('video')
    expect(call.folder).toBe('projects/integration/videos')
  })

  it('returns 400 for an unknown asset_type', async () => {
    const res = await signAsset({ asset_type: 'not-a-real-type' })
    expect(res.status).toBe(400)
  })

  it('returns 503 when Cloudinary is not configured', async () => {
    const { CloudinaryNotConfiguredError } = await import('@/lib/cloudinary')
    signUpload.mockImplementationOnce(() => {
      throw new CloudinaryNotConfiguredError()
    })
    const res = await signAsset({ asset_type: 'image' })
    expect(res.status).toBe(503)
  })
})

describe('DELETE /api/projects/[id]/assets/[assetId]', () => {
  beforeEach(() => {
    state.assets.push({
      id: 42,
      project_id: 7,
      workspace_id: 1,
      cloudinary_public_id: 'p',
      cloudinary_url: 'https://x',
      asset_type: 'image',
      asset_category: 'logo',
      original_filename: null,
      tags: '[]',
      metadata: '{}',
      uploaded_by: null,
      created_at: 1,
      updated_at: 1,
    })
  })

  it('deletes an existing asset (200)', async () => {
    const res = await deleteAsset('42')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; deleted: boolean }
    expect(body.id).toBe(42)
    expect(body.deleted).toBe(true)
    expect(state.assets).toHaveLength(0)
  })

  it('clears logo_asset_id on any branding profile that referenced this asset', async () => {
    state.brandings.push({
      id: 1,
      project_id: 7,
      workspace_id: 1,
      logo_asset_id: 42,
    })
    const res = await deleteAsset('42')
    expect(res.status).toBe(200)
    expect(state.brandings[0].logo_asset_id).toBeNull()
  })

  it('returns 404 when the asset does not exist', async () => {
    const res = await deleteAsset('999')
    expect(res.status).toBe(404)
  })

  it('returns 400 for non-numeric assetId', async () => {
    const res = await deleteAsset('abc')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the project is not in scope', async () => {
    state.projects = []
    const res = await deleteAsset('42')
    expect(res.status).toBe(404)
  })
})
