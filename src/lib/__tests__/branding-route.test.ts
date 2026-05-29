// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ----- Mocks (set up before any route imports) ----------------------------

const requireRole = vi.fn()
const mutationLimiter = vi.fn(() => null)
const prepare = vi.fn()
const uploadBuffer = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/db', () => ({ getDatabase: vi.fn(() => ({ prepare })) }))
vi.mock('@/lib/cloudinary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cloudinary')>('@/lib/cloudinary')
  return {
    ...actual,
    // Pure helpers (pngHasAlpha, folder builders, etc.) remain real; only
    // network-touching helpers are mocked.
    uploadBuffer,
  }
})

// ----- Test fixtures ------------------------------------------------------

type Row = Record<string, unknown>

interface DbState {
  workspaces: Row[]
  projects: Row[]
  brandings: Row[]
  assets: Row[]
  insertedAssetIds: number[]
  insertedBrandingIds: number[]
  updates: Array<{ table: string; sql: string; args: unknown[] }>
  deletes: Array<{ table: string; sql: string; args: unknown[] }>
}

function freshState(): DbState {
  return {
    workspaces: [
      { id: 1, slug: 'default', name: 'Default', tenant_id: 1, created_at: 1, updated_at: 1 },
    ],
    projects: [{ id: 7, slug: 'integration', name: 'Integration', workspace_id: 1 }],
    brandings: [],
    assets: [],
    insertedAssetIds: [],
    insertedBrandingIds: [],
    updates: [],
    deletes: [],
  }
}

let state: DbState
let nextRowId = 100

function buildPrepareMock(): (sql: string) => Record<string, unknown> {
  return (sql: string) => {
    // 1. ensureTenantWorkspaceAccess → workspaces lookup
    if (sql.includes('FROM workspaces') && sql.includes('WHERE id = ? AND tenant_id = ?')) {
      return {
        get: (workspaceId: number, tenantId: number) =>
          state.workspaces.find((w) => w.id === workspaceId && w.tenant_id === tenantId),
      }
    }

    // 2. findProjectInScope
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

    // 3. Branding SELECT (full row)
    if (sql.match(/SELECT \* FROM project_branding WHERE project_id = \?/)) {
      return {
        get: (projectId: number) => state.brandings.find((b) => b.project_id === projectId),
      }
    }
    if (sql.match(/SELECT id FROM project_branding WHERE project_id = \?/)) {
      return {
        get: (projectId: number) => {
          const b = state.brandings.find((bb) => bb.project_id === projectId)
          return b ? { id: b.id } : undefined
        },
      }
    }
    if (sql.match(/SELECT \* FROM project_branding WHERE id = \?/)) {
      return { get: (id: number) => state.brandings.find((b) => b.id === id) }
    }

    // 4. Branding INSERT
    if (sql.includes('INSERT INTO project_branding')) {
      return {
        run: (...args: unknown[]) => {
          const id = ++nextRowId
          state.insertedBrandingIds.push(id)
          // Reconstruct the row based on insertion shape. The route uses two
          // shapes: the upsert insert (lots of columns) and the logo insert
          // (just project_id, workspace_id, logo_asset_id).
          if (sql.includes('logo_asset_id')) {
            state.brandings.push({
              id,
              project_id: args[0],
              workspace_id: args[1],
              logo_asset_id: args[2],
              accent_colors: '[]',
              approved_fonts: '[]',
              created_at: 1,
              updated_at: 1,
            })
          } else {
            state.brandings.push({
              id,
              project_id: args[0],
              workspace_id: args[1],
              brand_name: args[2],
              primary_color: args[3],
              secondary_color: args[4],
              accent_colors: args[5],
              heading_font: args[6],
              body_font: args[7],
              approved_fonts: args[8],
              brand_notes: args[9],
              tone_notes: args[10],
              logo_asset_id: null,
              created_at: 1,
              updated_at: 1,
            })
          }
          return { lastInsertRowid: id, changes: 1 }
        },
      }
    }

    // 5. Branding UPDATE — generic handler that parses SET clauses from the
    //    SQL and applies the positional args in order, with the last arg as
    //    the row id.
    if (sql.startsWith('UPDATE project_branding')) {
      return {
        run: (...args: unknown[]) => {
          const id = args[args.length - 1] as number
          const row = state.brandings.find((b) => b.id === id) as
            | Record<string, unknown>
            | undefined
          if (!row) return { changes: 0 }
          state.updates.push({ table: 'project_branding', sql, args })
          const setSection = sql.replace(/^[\s\S]*?\bSET\b/, '').replace(/\bWHERE[\s\S]*$/, '')
          const cols = setSection
            .split(',')
            .map((c) => c.trim())
            .map((c) => c.match(/^([a-z_]+)\s*=\s*\?/i))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map((m) => m[1])
          cols.forEach((col, idx) => {
            row[col] = args[idx]
          })
          return { changes: 1 }
        },
      }
    }

    // 6. Assets INSERT (used by logo route)
    if (sql.includes('INSERT INTO project_assets')) {
      return {
        run: (...args: unknown[]) => {
          const id = ++nextRowId
          state.insertedAssetIds.push(id)
          state.assets.push({
            id,
            project_id: args[0],
            workspace_id: args[1],
            cloudinary_public_id: args[2],
            cloudinary_url: args[3],
            asset_type: 'image',
            asset_category: 'logo',
            original_filename: args[4],
            tags: args[5],
            metadata: args[6],
            uploaded_by: args[7],
            created_at: 1,
            updated_at: 1,
          })
          return { lastInsertRowid: id, changes: 1 }
        },
      }
    }

    throw new Error(`Unexpected SQL in test: ${sql.slice(0, 100)}`)
  }
}

// Constructs a minimal PNG-shaped byte buffer. Only the first 26 bytes are
// inspected by pngHasAlpha; we append a few extra bytes so the buffer is a
// plausible length but the validator only reads the IHDR.
function minimalPng(colorType: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0d]) // 13
  const ihdrType = Buffer.from('IHDR', 'ascii')
  const width = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const height = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const bitDepth = Buffer.from([0x08])
  const ct = Buffer.from([colorType])
  const tail = Buffer.alloc(8, 0) // pad
  return Buffer.concat([sig, ihdrLen, ihdrType, width, height, bitDepth, ct, tail])
}

// ----- Suite setup --------------------------------------------------------

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

async function postBranding(body: unknown, projectId = '7') {
  const { POST } = await import('@/app/api/projects/[id]/branding/route')
  const req = new NextRequest('http://localhost/api/projects/' + projectId + '/branding', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return POST(req, { params: Promise.resolve({ id: projectId }) })
}

async function getBranding(projectId = '7') {
  const { GET } = await import('@/app/api/projects/[id]/branding/route')
  const req = new NextRequest('http://localhost/api/projects/' + projectId + '/branding')
  return GET(req, { params: Promise.resolve({ id: projectId }) })
}

async function patchBranding(body: unknown, projectId = '7') {
  const { PATCH } = await import('@/app/api/projects/[id]/branding/route')
  const req = new NextRequest('http://localhost/api/projects/' + projectId + '/branding', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return PATCH(req, { params: Promise.resolve({ id: projectId }) })
}

async function postLogo(file: Buffer | null, projectId = '7') {
  const { POST } = await import('@/app/api/projects/[id]/branding/logo/route')
  const fd = new FormData()
  if (file) fd.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'logo.png')
  const req = new NextRequest('http://localhost/api/projects/' + projectId + '/branding/logo', {
    method: 'POST',
    body: fd as unknown as BodyInit,
  })
  return POST(req, { params: Promise.resolve({ id: projectId }) })
}

// ----- Tests --------------------------------------------------------------

describe('GET /api/projects/[id]/branding', () => {
  it('returns the branding profile when it exists', async () => {
    state.brandings.push({
      id: 1,
      project_id: 7,
      workspace_id: 1,
      brand_name: 'Deep Vibe',
      primary_color: '#0B5FFF',
      secondary_color: '#111111',
      accent_colors: '["#FF6B00"]',
      heading_font: 'Satoshi',
      body_font: 'Inter',
      approved_fonts: '["Satoshi","Inter"]',
      logo_asset_id: null,
      brand_notes: null,
      tone_notes: null,
      created_at: 1,
      updated_at: 1,
    })
    const res = await getBranding()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { branding: { brand_name: string; accent_colors: string[] } }
    expect(body.branding.brand_name).toBe('Deep Vibe')
    expect(body.branding.accent_colors).toEqual(['#FF6B00'])
  })

  it('returns 404 when the branding profile is missing', async () => {
    const res = await getBranding()
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/Branding profile not found/)
  })

  it('returns 404 when the project is not in the workspace scope', async () => {
    state.projects = []
    const res = await getBranding()
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/Project not found/)
  })

  it('returns 400 for non-numeric project id', async () => {
    const res = await getBranding('abc')
    expect(res.status).toBe(400)
  })

  it('returns 401 when requireRole rejects', async () => {
    requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })
    const res = await getBranding()
    expect(res.status).toBe(401)
  })
})

describe('POST /api/projects/[id]/branding (upsert)', () => {
  it('creates a new branding profile (201) when none exists', async () => {
    const res = await postBranding({
      brand_name: 'Deep Vibe',
      primary_color: '#0B5FFF',
      accent_colors: ['#FF6B00'],
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { branding: { brand_name: string; primary_color: string } }
    expect(body.branding.brand_name).toBe('Deep Vibe')
    expect(body.branding.primary_color).toBe('#0B5FFF')
    expect(state.insertedBrandingIds.length).toBe(1)
  })

  it('updates an existing branding profile (200)', async () => {
    state.brandings.push({
      id: 1,
      project_id: 7,
      workspace_id: 1,
      brand_name: 'Old',
      primary_color: '#000000',
      secondary_color: null,
      accent_colors: '[]',
      heading_font: null,
      body_font: null,
      approved_fonts: '[]',
      logo_asset_id: null,
      brand_notes: null,
      tone_notes: null,
      created_at: 1,
      updated_at: 1,
    })
    const res = await postBranding({ brand_name: 'New', primary_color: '#FFFFFF' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { branding: { brand_name: string; primary_color: string } }
    expect(body.branding.brand_name).toBe('New')
    expect(body.branding.primary_color).toBe('#FFFFFF')
    expect(state.insertedBrandingIds.length).toBe(0)
  })

  it('rejects invalid primary_color (400)', async () => {
    const res = await postBranding({ primary_color: 'not-a-hex' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/primary_color/)
  })

  it('rejects non-array accent_colors (400)', async () => {
    const res = await postBranding({ accent_colors: 'red' })
    expect(res.status).toBe(400)
  })

  it('rejects accent_colors with an invalid hex (400)', async () => {
    const res = await postBranding({ accent_colors: ['#FF6B00', 'not-hex'] })
    expect(res.status).toBe(400)
  })

  it('returns 404 when project is not in scope', async () => {
    state.projects = []
    const res = await postBranding({ brand_name: 'x' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when requireRole returns Forbidden', async () => {
    requireRole.mockReturnValue({ error: 'Requires operator role or higher', status: 403 })
    const res = await postBranding({ brand_name: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/projects/[id]/branding', () => {
  beforeEach(() => {
    state.brandings.push({
      id: 1,
      project_id: 7,
      workspace_id: 1,
      brand_name: 'Old',
      primary_color: '#000000',
      secondary_color: null,
      accent_colors: '[]',
      heading_font: null,
      body_font: null,
      approved_fonts: '[]',
      logo_asset_id: null,
      brand_notes: null,
      tone_notes: null,
      created_at: 1,
      updated_at: 1,
    })
  })

  it('patches a single field and returns the updated row', async () => {
    const res = await patchBranding({ primary_color: '#222222' })
    expect(res.status).toBe(200)
    expect((await res.json()).branding.primary_color).toBe('#222222')
  })

  it('returns 400 when no fields are provided', async () => {
    const res = await patchBranding({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when the branding profile does not exist yet', async () => {
    state.brandings = []
    const res = await patchBranding({ primary_color: '#222222' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when primary_color is not a valid hex', async () => {
    const res = await patchBranding({ primary_color: 'oops' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/projects/[id]/branding/logo', () => {
  beforeEach(() => {
    // Cloudinary creds present so ensureCloudinaryConfigured doesn't throw
    process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
    process.env.CLOUDINARY_API_KEY = 'test-key'
    process.env.CLOUDINARY_API_SECRET = 'test-secret'
    uploadBuffer.mockResolvedValue({
      publicId: 'projects/integration/branding/abc',
      secureUrl: 'https://res.cloudinary.com/test/image/upload/v1/projects/integration/branding/abc.png',
      bytes: 1234,
      format: 'png',
    })
  })

  it('uploads a PNG with alpha (color type 6) and links it into branding (201)', async () => {
    const res = await postLogo(minimalPng(6))
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      asset: { cloudinary_public_id: string }
      branding: { logo_asset_id: number }
    }
    expect(body.asset.cloudinary_public_id).toBe('projects/integration/branding/abc')
    expect(body.branding.logo_asset_id).toBe(state.insertedAssetIds[0])
    expect(uploadBuffer).toHaveBeenCalledOnce()
  })

  it('uploads a PNG with grayscale+alpha (color type 4)', async () => {
    const res = await postLogo(minimalPng(4))
    expect(res.status).toBe(201)
  })

  it('rejects a PNG without alpha (color type 2: RGB only) with 400', async () => {
    const res = await postLogo(minimalPng(2))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/alpha channel/)
    expect(uploadBuffer).not.toHaveBeenCalled()
  })

  it('rejects bytes that are not a PNG with 400', async () => {
    const notPng = Buffer.from('not a png at all hello world hello world')
    const res = await postLogo(notPng)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/PNG/)
  })

  it('returns 400 when the file field is missing', async () => {
    const res = await postLogo(null)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing "file" field/)
  })

  it('returns 503 when Cloudinary is not configured', async () => {
    // The mocked uploadBuffer would have to call ensureCloudinaryConfigured
    // internally to detect missing env — we simulate that by having the mock
    // throw the same error type the real helper throws. Importing the class
    // dynamically inside the test avoids breaking vi.mock hoisting.
    const { CloudinaryNotConfiguredError } = await import('@/lib/cloudinary')
    uploadBuffer.mockRejectedValueOnce(new CloudinaryNotConfiguredError())
    const res = await postLogo(minimalPng(6))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Cloudinary credentials/)
  })
})
