/**
 * FileViewer — opens files based on type:
 *   - Code/text: CodeMirror 6 editor with syntax highlighting
 *   - Markdown: CodeMirror + live preview side-by-side
 *   - Images: <img> display
 *
 * Props:
 *   fileId: full path like '/readme.md'
 *   token: Firebase ID token
 *   onClose: callback to close the viewer
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { readFileContent, saveFileContent } from '../lib/api'

// --- File type detection ---

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'])
const MD_EXTS = new Set(['md', 'mdx', 'markdown'])

function getExt(fileId: string): string {
  const parts = fileId.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function getFileType(fileId: string): 'image' | 'markdown' | 'code' {
  const ext = getExt(fileId)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (MD_EXTS.has(ext)) return 'markdown'
  return 'code'
}

function getLanguageExtension(fileId: string) {
  const ext = getExt(fileId)
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
      return css()
    case 'json':
      return json()
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown()
    case 'py':
      return python()
    case 'xml':
    case 'xsl':
      return xml()
    case 'yaml':
    case 'yml':
      return yaml()
    default:
      return []
  }
}

// Content type for saving
function getContentType(fileId: string): string {
  const ext = getExt(fileId)
  const map: Record<string, string> = {
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
    html: 'text/html', htm: 'text/html', css: 'text/css',
    json: 'application/json', md: 'text/markdown', mdx: 'text/markdown',
    py: 'text/x-python', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml',
    txt: 'text/plain', svg: 'image/svg+xml',
  }
  return map[ext] || 'text/plain'
}

// --- Component ---

interface FileViewerProps {
  fileId: string
  token: string
  onClose: () => void
}

export default function FileViewer({ fileId, token, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [encoding, setEncoding] = useState<'text' | 'base64'>('text')
  const [contentType, setContentType] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const [previewContent, setPreviewContent] = useState('')

  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fileType = useMemo(() => getFileType(fileId), [fileId])
  const filename = useMemo(() => fileId.split('/').pop() || fileId, [fileId])

  // Load file content
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setLoading(true)
        setError(null)
        const result = await readFileContent({ data: { token, fileId } })
        if (cancelled) return
        setContent(result.content)
        setEncoding(result.encoding)
        setContentType(result.contentType)
        contentRef.current = result.content
        setPreviewContent(result.content)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load file')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [fileId, token])

  // Initialize CodeMirror
  useEffect(() => {
    if (loading || error || fileType === 'image' || !editorRef.current) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const text = update.state.doc.toString()
        contentRef.current = text
        setDirty(true)
        // Debounced live preview for markdown
        if (fileType === 'markdown') {
          if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
          previewTimerRef.current = setTimeout(() => setPreviewContent(text), 150)
        }
      }
    })

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle),
        oneDark,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        getLanguageExtension(fileId),
        updateListener,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '13px',
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          },
          '.cm-scroller': {
            overflow: 'auto',
          },
          '.cm-content': {
            caretColor: '#58a6ff',
          },
          '&.cm-focused .cm-cursor': {
            borderLeftColor: '#58a6ff',
          },
          '.cm-gutters': {
            backgroundColor: '#0d1117',
            borderRight: '1px solid #21262d',
            color: '#484f58',
          },
          '.cm-activeLineGutter': {
            backgroundColor: '#161b22',
          },
          '.cm-activeLine': {
            backgroundColor: '#161b2266',
          },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [loading, error, fileType, content, fileId])

  // Save handler
  const handleSave = useCallback(async () => {
    if (!dirty || saving) return
    try {
      setSaving(true)
      await saveFileContent({
        data: {
          token,
          fileId,
          content: contentRef.current,
          contentType: getContentType(fileId),
        },
      })
      setDirty(false)
      console.log('[asisto] file saved:', fileId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [dirty, saving, token, fileId])

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave])

  // --- Render ---

  return (
    <div className="flex h-full flex-col bg-[#0d1117]">
      {/* Toolbar — compact strip for save/preview controls */}
      <div className="shrink-0 flex items-center justify-between border-b border-[#21262d] bg-[#161b22] px-2">
        <div className="flex items-center gap-2 py-1">
          {dirty && (
            <span className="text-xs text-[#d29922]">modified</span>
          )}
          {saving && (
            <span className="text-xs text-[#8b949e]">saving...</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {fileType === 'markdown' && (
            <button
              type="button"
              onClick={() => setShowPreview((p) => !p)}
              className={`rounded px-2 py-0.5 text-xs transition ${
                showPreview
                  ? 'bg-[#21262d] text-[#c9d1d9]'
                  : 'text-[#484f58] hover:text-[#c9d1d9]'
              }`}
            >
              preview
            </button>
          )}
          {fileType !== 'image' && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="rounded px-2 py-0.5 text-xs text-[#484f58] transition hover:text-[#c9d1d9] disabled:opacity-30"
            >
              save
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 border-b border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-xs text-[#f85149]">
          {error}
        </div>
      )}

      {/* Content area */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-[#484f58]">loading...</span>
        </div>
      ) : fileType === 'image' ? (
        /* Image viewer */
        <div className="flex flex-1 items-center justify-center overflow-auto p-8">
          <img
            src={
              encoding === 'base64'
                ? `data:${contentType};base64,${content}`
                : `data:image/svg+xml;utf8,${encodeURIComponent(content)}`
            }
            alt={filename}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : fileType === 'markdown' && showPreview ? (
        /* Markdown: editor + preview split */
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden border-r border-[#21262d]" ref={editorRef} />
          <div className="flex-1 overflow-auto p-4 prose-dark">
            <Markdown remarkPlugins={[remarkGfm]}>
              {previewContent}
            </Markdown>
          </div>
        </div>
      ) : (
        /* Code/text editor */
        <div className="flex-1 overflow-hidden" ref={editorRef} />
      )}
    </div>
  )
}
