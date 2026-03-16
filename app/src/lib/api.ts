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

// --- File types matching SVAR Filemanager data format ---

export interface FileItem {
  id: string
  size: number
  date: string
  type: 'file' | 'folder'
  lazy?: boolean
}

export interface DriveInfo {
  used: number
  total: number
}

// --- File management server functions ---

/** Create a new file or folder. */
export const createFile = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { token: string; parentId: string; name: string; type: string }) =>
      input,
  )
  .handler(async ({ data: { token, parentId, name, type } }): Promise<FileItem> => {
    const stripped = parentId.replace(/^\//, '')
    const url = stripped
      ? `${API_BASE}/files/${encodeURIComponent(stripped)}`
      : `${API_BASE}/files`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, type }),
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to create file'))
    }
    return res.json()
  })

/** Rename a file or folder. */
export const renameFile = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { token: string; fileId: string; name: string }) => input,
  )
  .handler(async ({ data: { token, fileId, name } }): Promise<FileItem> => {
    const encodedId = encodeURIComponent(fileId.replace(/^\//, ''))
    const res = await fetch(`${API_BASE}/files/${encodedId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to rename file'))
    }
    return res.json()
  })

/** Move or copy files. */
export const moveFiles = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: {
      token: string
      ids: string[]
      target: string
      copy: boolean
    }) => input,
  )
  .handler(
    async ({
      data: { token, ids, target, copy },
    }): Promise<FileItem[]> => {
      const res = await fetch(`${API_BASE}/files`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids, target, copy }),
      })
      if (!res.ok) {
        throw new Error(await parseError(res, 'Failed to move files'))
      }
      return res.json()
    },
  )

/** Delete files/folders. */
export const deleteFiles = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string; ids: string[] }) => input)
  .handler(async ({ data: { token, ids } }): Promise<void> => {
    const res = await fetch(`${API_BASE}/files`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to delete files'))
    }
  })

/** Get drive storage info. */
export const getDriveInfo = createServerFn({ method: 'GET' })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }): Promise<{ stats: DriveInfo }> => {
    const res = await fetch(`${API_BASE}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to get drive info'))
    }
    return res.json()
  })

/** Download a file. Returns { base64, contentType, filename } for the browser to save. */
export const downloadFile = createServerFn({ method: 'GET' })
  .inputValidator((input: { token: string; fileId: string }) => input)
  .handler(
    async ({
      data: { token, fileId },
    }): Promise<{ base64: string; contentType: string; filename: string }> => {
      const encodedId = encodeURIComponent(fileId.replace(/^\//, ''))
      const res = await fetch(`${API_BASE}/download/${encodedId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(await parseError(res, 'Failed to download file'))
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const contentType =
        res.headers.get('content-type') || 'application/octet-stream'
      // Extract filename from Content-Disposition or fall back to path basename
      const disposition = res.headers.get('content-disposition') || ''
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename =
        filenameMatch?.[1] || fileId.split('/').pop() || 'download'
      return {
        base64: buffer.toString('base64'),
        contentType,
        filename,
      }
    },
  )

/**
 * Returns the backend API endpoint URL for direct browser connections (WebSocket).
 * Reads from the server-side API_ENDPOINT env var at runtime — not baked at build time.
 */
export const getApiEndpoint = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    return API_BASE
  },
)

/** Read file content for the editor. Returns text for text files, base64 for binary. */
export const readFileContent = createServerFn({ method: 'GET' })
  .inputValidator((input: { token: string; fileId: string }) => input)
  .handler(
    async ({
      data: { token, fileId },
    }): Promise<{ content: string; contentType: string; encoding: 'text' | 'base64' }> => {
      const encodedId = encodeURIComponent(fileId.replace(/^\//, ''))
      const res = await fetch(`${API_BASE}/download/${encodedId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(await parseError(res, 'Failed to read file'))
      }
      const contentType =
        res.headers.get('content-type') || 'application/octet-stream'
      const buffer = Buffer.from(await res.arrayBuffer())

      // For images, PDFs, and binary files, return base64
      if (
        contentType.startsWith('image/') ||
        contentType === 'application/pdf' ||
        contentType === 'application/octet-stream'
      ) {
        return {
          content: buffer.toString('base64'),
          contentType,
          encoding: 'base64',
        }
      }
      // For text files, return as text
      return {
        content: buffer.toString('utf-8'),
        contentType,
        encoding: 'text',
      }
    },
  )

/** Save file content back to the backend. */
export const saveFileContent = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { token: string; fileId: string; content: string; contentType?: string }) =>
      input,
  )
  .handler(async ({ data: { token, fileId, content, contentType } }): Promise<void> => {
    const encodedId = encodeURIComponent(fileId.replace(/^\//, ''))
    const ct = contentType || 'text/plain'
    const buffer = Buffer.from(content, 'utf-8')
    const blob = new Blob([buffer], { type: ct })
    const formData = new FormData()
    // Extract filename from fileId
    const filename = fileId.split('/').pop() || 'file'
    formData.append('file', blob, filename)

    // Use the upload endpoint with parent path to overwrite
    const parts = fileId.replace(/^\//, '').split('/')
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    const url = parentPath
      ? `${API_BASE}/upload/${encodeURIComponent(parentPath)}`
      : `${API_BASE}/upload`
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to save file'))
    }
  })

// --- Workspace layout persistence ---

/** Get saved workspace layout snapshot. */
export const getWorkspaceLayout = createServerFn({ method: 'GET' })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }): Promise<Record<string, unknown>> => {
    const res = await fetch(`${API_BASE}/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to get workspace layout'))
    }
    return res.json()
  })

/** Save workspace layout snapshot. */
export const saveWorkspaceLayout = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { token: string; snapshot: Record<string, unknown> }) => input,
  )
  .handler(async ({ data: { token, snapshot } }): Promise<void> => {
    const res = await fetch(`${API_BASE}/workspace`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(snapshot),
    })
    if (!res.ok) {
      throw new Error(await parseError(res, 'Failed to save workspace layout'))
    }
  })
