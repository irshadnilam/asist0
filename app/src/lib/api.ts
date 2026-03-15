/**
 * Server functions for the Asisto backend API.
 *
 * These run on the TanStack Start server (Nitro/Bun), not in the browser.
 * This avoids CORS entirely — browser talks to the frontend server,
 * which proxies to the FastAPI backend server-to-server.
 *
 * The Firebase ID token is passed from the client via server function args,
 * then forwarded as a Bearer token to the backend.
 */

import { createServerFn } from '@tanstack/react-start'

const API_BASE = process.env.API_ENDPOINT || 'http://localhost:8080'

export interface WorkspaceInfo {
  workspace_id: string
}

/**
 * Parse error response from backend, returning a descriptive message.
 */
async function parseError(res: Response, action: string): Promise<string> {
  let detail = ''
  try {
    const body = await res.json()
    detail = body.detail || JSON.stringify(body)
  } catch {
    detail = res.statusText
  }
  return `${action}: ${res.status} ${detail}`
}

export const listWorkspaces = createServerFn({ method: 'GET' })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }): Promise<WorkspaceInfo[]> => {
    const res = await fetch(`${API_BASE}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to list workspaces'))
    }
    return res.json()
  })

export const createWorkspace = createServerFn({ method: 'POST' })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }): Promise<WorkspaceInfo> => {
    const res = await fetch(`${API_BASE}/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to create workspace'))
    }
    const data = await res.json()
    return { workspace_id: data.workspace_id }
  })

/**
 * Returns the backend API endpoint URL for direct browser connections (WebSocket).
 * Reads from the server-side API_ENDPOINT env var at runtime — not baked at build time.
 */
export const getApiEndpoint = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    return API_BASE
  },
)

// TanStack Start server functions only support GET/POST methods for the
// client-to-SSR transport. The actual DELETE is issued server-to-server.
export const deleteWorkspace = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string; workspaceId: string }) => input)
  .handler(async ({ data: { token, workspaceId } }): Promise<void> => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to delete workspace'))
    }
  })
