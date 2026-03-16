/**
 * useFiles — Firestore realtime subscription for the file manager.
 *
 * Subscribes to `users/{uid}/files` collection and returns all file
 * metadata as a flat array. The SVAR Filemanager uses this as its
 * `data` prop — combined with the tree structure derived from `id` paths.
 *
 * This replaces the previous fetch-based approach, giving instant updates
 * when the agent (or another tab) creates/modifies/deletes files.
 */

import { useEffect, useState } from 'react'
import {
  collection,
  onSnapshot,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from './firebase'
import type { FileItem } from './api'

function formatDoc(doc: DocumentData): FileItem {
  const data = doc.data()
  const result: FileItem = {
    id: data.id,
    size: data.size || 0,
    date: data.date?.toDate?.()?.toISOString?.() ?? data.date ?? new Date().toISOString(),
    type: data.type || 'file',
  }
  // Don't set lazy — we provide all files upfront via Firestore realtime,
  // so SVAR doesn't need to request-data for folder contents.
  return result
}

interface UseFilesResult {
  /** All files for the user (flat list, all depths) */
  allFiles: FileItem[]
  /** Get direct children of a parent path */
  getChildren: (parentId: string) => FileItem[]
  /** Whether the initial snapshot has loaded */
  loading: boolean
  /** Error message if subscription failed */
  error: string | null
}

export function useFiles(uid: string | null): UseFilesResult {
  const [allFiles, setAllFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) {
      setAllFiles([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    const colRef = collection(db, 'users', uid, 'files')

    const unsub: Unsubscribe = onSnapshot(
      colRef,
      (snapshot) => {
        const files = snapshot.docs.map(formatDoc)
        setAllFiles(files)
        setLoading(false)
      },
      (err) => {
        console.error('[asisto] firestore subscription error:', err)
        setError(err.message)
        setLoading(false)
      },
    )

    return () => {
      unsub()
    }
  }, [uid])

  // Get direct children of a parent path
  const getChildren = (parentId: string): FileItem[] => {
    const prefix = parentId.replace(/\/+$/, '') + '/'
    const parentDepth = parentId.replace(/^\//, '').split('/').length
    return allFiles.filter((f) => {
      if (!f.id.startsWith(prefix)) return false
      const parts = f.id.replace(/^\//, '').split('/')
      return parts.length === parentDepth + 1
    })
  }

  return { allFiles, getChildren, loading, error }
}
