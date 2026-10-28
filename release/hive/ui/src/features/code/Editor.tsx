import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { mettaSupport } from './metta'
import { codeLayers, fenceLayers, setLayers, type Layers } from './canvas/layers'

function language(path: string): Extension[] {
  if (/\.metta$/i.test(path)) return mettaSupport()
  if (/\.py$/.test(path)) return [python()]
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) return [javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) })]
  if (/\.json$/.test(path)) return [json()]
  if (/\.(md|markdown)$/.test(path)) return [markdown()]
  return []
}

/** The keys the editor forwards to its host (the Code canvas); each handler returns true when it used the key. */
export const EDITOR_KEYS = ['Mod-k', 'Mod-e', 'Mod-Enter', 'Mod-;', 'Escape', 'Ctrl-Space', 'F12', 'F2', 'Mod-Shift-l'] as const

/** The editor's own completion popup off (no typing trigger, no keys): combined with basicSetup's, these win. */
const OFF = autocompletion({ activateOnTyping: false, defaultKeymap: false })

const look = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgb(170 170 255 / 0.12)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgb(255 255 255 / 0.035)' },
})

/**
 * CodeMirror, controlled by path: a new path loads new content; edits report the text. Cmd/Ctrl+S saves.
 * `onSelect` reports the main selection as editor UTF-16 offsets (the suggestion panel converts them to saved bytes).
 */
export function Editor({ path, content, onChange, onSave, onSelect, readOnly, layers, onView, keys, label, onModClick, onDoubleClick, localCompletion = true }: {
  path: string
  content: string
  onChange: (text: string) => void
  onSave: () => void
  onSelect?: (sel: { from: number; to: number }) => void
  readOnly?: boolean
  /** The Code canvas's layers (the mind's writing, presence and ink; run results): canvas/layers.ts */
  layers?: Layers
  /** The live view, for the canvas's minimap and the actions beside a selection; null when it goes. */
  onView?: (view: EditorView | null) => void
  /** Extra keys, e.g. { 'Mod-k': () => …, 'Mod-Enter': … }; each returns true when it handled the key. */
  keys?: Record<string, () => boolean>
  /** The editor's accessible name. */
  label?: string
  /** ⌘-click (Ctrl-click) at a document offset. */
  onModClick?: (pos: number) => void
  /** A double-click at a document offset (after the editor's own word selection). */
  onDoubleClick?: (pos: number) => void
  /**
   * The editor's own word completions (default on). The Code canvas turns them off when the code service offers its
   * completions, so there is one completion list (the service's, previewed and confirmed) and ⌃Space reaches it.
   */
  localCompletion?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const completion = useRef(new Compartment())
  const view = useRef<EditorView | null>(null)
  const handlers = useRef({ onChange, onSave, onSelect, keys, onView, onModClick, onDoubleClick })
  useEffect(() => {
    handlers.current = { onChange, onSave, onSelect, keys, onView, onModClick, onDoubleClick }
  })
  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        look,
        ...language(path),
        EditorState.readOnly.of(!!readOnly),
        // the canvas's keys come before the editor's own (Ctrl-Space is the service's completions, not local words)
        Prec.high(keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
          ...EDITOR_KEYS.map((key) => ({ key, run: () => handlers.current.keys?.[key]?.() ?? false })),
        ])),
        EditorView.domEventHandlers({
          // ⌘-click (Ctrl-click elsewhere): the canvas's "go to definition"
          mousedown: (e, v) => {
            if (!(e.metaKey || e.ctrlKey) || e.button !== 0 || !handlers.current.onModClick) return false
            const at = v.posAtCoords({ x: e.clientX, y: e.clientY })
            if (at == null) return false
            e.preventDefault()
            handlers.current.onModClick(at)
            return true
          },
          dblclick: (e, v) => {
            const at = v.posAtCoords({ x: e.clientX, y: e.clientY })
            if (at != null) handlers.current.onDoubleClick?.(at)
            return false
          },
        }),
        codeLayers(),
        completion.current.of(localCompletion ? [] : OFF),
        EditorView.contentAttributes.of({ 'aria-label': label ?? `Code: ${path}` }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
          // a mapped range can come back reversed (whole-document replacement); report it ordered
          const { anchor, head } = u.state.selection.main
          if (u.selectionSet || u.docChanged) handlers.current.onSelect?.({ from: Math.min(anchor, head), to: Math.max(anchor, head) })
        }),
      ],
    })
    view.current = new EditorView({ state, parent: host.current })
    handlers.current.onView?.(view.current)
    return () => {
      handlers.current.onView?.(null)
      view.current?.destroy()
    }
    // a new path or a reload from the server replaces the document
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly])
  useEffect(() => {
    const v = view.current
    // a reload from the server collapses the selection to a cursor (a mapped range would span the whole new document)
    if (v && v.state.doc.toString() !== content) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, selection: { anchor: Math.min(v.state.selection.main.head, content.length) } })
  }, [content])
  useEffect(() => {
    // only what was placed on exactly this file and text is drawn (a switch of file or version draws none of it)
    if (layers && view.current) view.current.dispatch({ effects: setLayers.of(fenceLayers(layers, path, view.current.state.doc.toString())) })
  }, [layers, path, content])
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    {/\.metta$/i.test(path) && <p className="shrink-0 border-b border-line px-3 py-1 text-meta text-ink-3">MeTTa · draft delimiter checks only · runtime/type validation requires a run</p>}
    <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
  </div>
}
