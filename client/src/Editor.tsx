import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { api, getToken, WS_URL, API_URL, type ProjectSummary } from './api'
import { useAuth } from './auth'
import { useYMap, useYMapKeys, useYTextNonEmpty } from './yhooks'
import { toast } from './toast'
import { speak, stopSpeaking, speechOutputSupported } from './speech'
import {
  applyOpsToContent,
  assemblePreview,
  createBuildWriter,
  exportEntries,
  exportFileName,
  INDEX_FILE,
  isLineEditPrompt,
  normalizePath,
  replaceTextRanged,
  serializeWorkspace,
  starterContent,
  type LineEdit,
} from './files'
import { createZip, downloadBlob } from './zip'
import { describeTarget, instrumentPreview, type PickedElement } from './picker'
import type { Attachment } from './vision'
import { TopBar } from './components/TopBar'
import { Conversation } from './components/Conversation'
import { PreviewPane } from './components/PreviewPane'
import { FileExplorer } from './components/FileExplorer'
import { ShareDialog } from './components/ShareDialog'

const uid = () => Math.random().toString(36).slice(2, 10)

// Panel layout: explorer and chat have draggable widths; the workspace flexes.
const PANELS_KEY = 'lumen_panels'
// Number.isFinite (not ||) so a mid-drag width of exactly 0 clamps to the floor
// instead of snapping back to the default for a frame.
const finite = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const clampPanels = (p: { explorer?: unknown; conv?: unknown }) => ({
  explorer: Math.min(640, Math.max(96, finite(p?.explorer, 232))),
  conv: Math.min(820, Math.max(240, finite(p?.conv, 380))),
})
const projectFromUrl = () => new URLSearchParams(location.search).get('p')
function setUrlProject(id: string) {
  const u = new URL(location.href)
  u.searchParams.set('p', id)
  history.replaceState(null, '', u.toString())
}

// ── Outer component: ensures a project is selected, then mounts the room. ──
export function Editor() {
  const [projectId, setProjectId] = useState<string | null>(projectFromUrl())
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async (preferred?: string | null) => {
    let { projects } = await api.projects()
    if (projects.length === 0) {
      const { project } = await api.createProject('My first project')
      projects = [{ ...project }]
    }
    setProjects(projects)
    const target = preferred && projects.find((p) => p.id === preferred) ? preferred : projects[0].id
    setProjectId(target)
    setUrlProject(target)
  }

  useEffect(() => {
    ;(async () => {
      try {
        await refresh(projectFromUrl())
      } catch (e: any) {
        toast(e?.message || 'Could not load projects.')
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchProject = (id: string) => {
    setProjectId(id)
    setUrlProject(id)
  }
  const newProject = async () => {
    const name = window.prompt('Name your new project', 'Untitled project')
    if (name === null) return
    try {
      const { project } = await api.createProject(name.trim() || 'Untitled project')
      await refresh(project.id)
      toast('Project created')
    } catch (e: any) {
      toast(e?.message || 'Could not create project.')
    }
  }

  if (loading || !projectId) {
    return (
      <div className="splash">
        <div className="s-mark">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
          </svg>
        </div>
      </div>
    )
  }

  return (
    <Room
      key={projectId}
      projectId={projectId}
      projects={projects}
      onSwitch={switchProject}
      onNew={newProject}
    />
  )
}

// ── The collaborative room for a single project. ──
function Room({
  projectId,
  projects,
  onSwitch,
  onNew,
}: {
  projectId: string
  projects: ProjectSummary[]
  onSwitch: (id: string) => void
  onNew: () => void
}) {
  const { user } = useAuth()

  // One Yjs document + provider per project (remounted via key on switch).
  const ydoc = useMemo(() => new Y.Doc(), [projectId])
  const provider = useMemo(
    () => new HocuspocusProvider({ url: WS_URL, name: projectId, token: getToken() || '', document: ydoc }),
    [projectId, ydoc]
  )

  const ytext = useMemo(() => ydoc.getText('code'), [ydoc]) // index.html — the build target
  const yfiles = useMemo(() => ydoc.getMap<Y.Text>('files'), [ydoc]) // extra files by path
  const ychat = useMemo(() => ydoc.getArray<Y.Map<any>>('chat'), [ydoc])
  const ymeta = useMemo(() => ydoc.getMap<any>('meta'), [ydoc])

  const meta = useYMap(ymeta)
  const building = !!meta.building

  const fileKeys = useYMapKeys(yfiles)
  // index.html only shows in the explorer once something has been generated
  // (or a collaborator created other files) — a fresh project starts empty.
  const hasIndex = useYTextNonEmpty(ytext)
  const files = useMemo(() => {
    const rest = fileKeys.filter((k) => k !== INDEX_FILE)
    return hasIndex || rest.length > 0 ? [INDEX_FILE, ...rest] : rest
  }, [fileKeys, hasIndex])
  const [activeFile, setActiveFile] = useState(INDEX_FILE)

  const [previewCode, setPreviewCode] = useState('')
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [voiceOut, setVoiceOut] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [picking, setPicking] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  // Bumped after every build so the cache stats in the explorer refresh.
  const [cacheTick, setCacheTick] = useState(0)
  const [pickTarget, setPickTarget] = useState<PickedElement | null>(null)
  const wasBuilding = useRef(false)
  // An inline edit changes a few lines the user is looking at — refresh the
  // preview when it lands, but don't yank them off the code tab to show it.
  const stayOnCode = useRef(false)

  // If the file we're editing is deleted by a collaborator, fall back to index.html.
  useEffect(() => {
    if (activeFile !== INDEX_FILE && !fileKeys.includes(activeFile)) setActiveFile(INDEX_FILE)
  }, [fileKeys, activeFile])

  const textFor = (path: string): Y.Text => (path === INDEX_FILE ? ytext : yfiles.get(path) ?? ytext)

  const filesSnapshot = (): Record<string, string> => {
    const snap: Record<string, string> = {}
    yfiles.forEach((text, path) => {
      if (path !== INDEX_FILE) snap[path] = text.toString()
    })
    return snap
  }

  // The preview document = the workspace inlined into one page, plus the element
  // picker. Instrumentation lives only in this string — never in the Yjs files,
  // the version snapshots, or the exported ZIP.
  const assemble = () => instrumentPreview(assemblePreview(ytext.toString(), filesSnapshot()))

  // Identify ourselves to other people in the room (drives cursors + presence).
  // Re-announces on profile edits, so keep it separate from the teardown below —
  // a user change must never destroy the live connection.
  useEffect(() => {
    provider.awareness?.setLocalStateField('user', { name: user!.name, color: user!.color, id: user!.id })
  }, [provider, user])

  useEffect(
    () => () => {
      provider.destroy()
      ydoc.destroy()
    },
    [provider, ydoc]
  )

  // Show persisted code once the document has synced from the server.
  useEffect(() => {
    const onSynced = () => {
      const code = ytext.toString()
      if (code && !ymeta.get('building')) setPreviewCode(assemble())
    }
    provider.on('synced', onSynced)
    return () => {
      provider.off('synced', onSynced)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, ytext, ymeta])

  // Refresh the preview when a build finishes (building flips true → false).
  useEffect(() => {
    if (wasBuilding.current && !building) {
      setPreviewCode(assemble())
      if (!stayOnCode.current) setTab('preview')
      stayOnCode.current = false
    }
    wasBuilding.current = building
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, ytext])

  const pushMessage = (msg: Record<string, any>) => {
    const m = new Y.Map<any>()
    Object.entries(msg).forEach(([k, v]) => m.set(k, v))
    ychat.push([m])
  }

  // ── File operations (all through Yjs, so the whole room stays in sync). ──
  // index.html is part of the path universe even while hidden from the explorer.
  const collision = (path: string) =>
    [INDEX_FILE, ...files].find((f) => f !== path && (f.startsWith(path + '/') || path.startsWith(f + '/')))

  const createFile = (input: string) => {
    const path = normalizePath(input)
    if (!path) {
      toast('Use a simple path with an extension, like styles/theme.css')
      return
    }
    if (path === INDEX_FILE || files.includes(path)) {
      setActiveFile(path)
      setTab('code')
      return
    }
    const clash = collision(path)
    if (clash) {
      toast(`That path conflicts with "${clash}".`)
      return
    }
    yfiles.set(path, new Y.Text(starterContent(path)))
    setActiveFile(path)
    setTab('code')
  }

  const renameFile = (from: string) => {
    if (from === INDEX_FILE) return
    const input = window.prompt('Rename file', from)
    if (input === null || input.trim() === from) return
    const to = normalizePath(input)
    if (!to) {
      toast('Use a simple path with an extension, like styles/theme.css')
      return
    }
    if (to === INDEX_FILE || files.includes(to)) {
      toast('A file with that name already exists.')
      return
    }
    const clash = collision(to)
    if (clash) {
      toast(`That path conflicts with "${clash}".`)
      return
    }
    const current = yfiles.get(from)
    if (!current) return
    const content = current.toString()
    ydoc.transact(() => {
      yfiles.delete(from)
      yfiles.set(to, new Y.Text(content))
    })
    if (activeFile === from) setActiveFile(to)
  }

  const deleteFile = (path: string) => {
    if (path === INDEX_FILE) return
    if (!window.confirm(`Delete ${path} for everyone in the room?`)) return
    yfiles.delete(path)
    if (activeFile === path) setActiveFile(INDEX_FILE)
  }

  const selectFile = (path: string) => {
    setActiveFile(path)
    setTab('code')
  }

  // The build: stream generated code into the shared Yjs files so everyone watches it write.
  // The model emits `===== FILE: path =====` sections; the writer splits the stream into
  // index.html, styles.css, app.js, … live, so files pop into the explorer as they're written.
  //
  // `image` is a sketch drawn in the pad or a screenshot that was dropped in. It
  // carries the request that words were bad at, so it changes three things here:
  // the words become optional, the line-edit shortcut is off, and the reply says
  // where the app came from.
  const runBuild = async (prompt: string, image?: Attachment, opts?: { noCache?: boolean }) => {
    if (ymeta.get('building')) return
    const indexNow = ytext.toString()
    const target = pickTarget
    // With no words typed, the picture is the whole request — give it a sentence
    // so the chat, the version history, and the model all read the same thing.
    const said =
      prompt.trim() ||
      (image ? (image.kind === 'sketch' ? 'Build this sketch.' : 'Rebuild this screen.') : '')
    // Prompts that name specific line numbers become precise line edits —
    // nothing is cleared or regenerated, only the named lines change. A picked
    // element already names its own target, so it never takes that path, and
    // neither does an image: a picture is never a line edit.
    if (!target && !image && indexNow.trim() && isLineEditPrompt(said)) return runLineEdit(said)
    // Hand the model every current file (marker format) so it can modify the project.
    const currentCode = indexNow.trim() ? serializeWorkspace(indexNow, filesSnapshot()) : ''
    // What the user typed is what the chat shows; the model gets the element too.
    const request = target ? describeTarget(target, said) : said
    setPickTarget(null)
    setPicking(false)

    pushMessage({
      id: uid(),
      role: 'user',
      authorName: user!.name,
      color: user!.color,
      text: said,
      context: target?.label,
      // The thumbnail, never the full image: this lives in the CRDT forever and
      // syncs to everyone in the room. What was sent to the model is a few
      // hundred KB; what the chat needs is a few.
      image: image?.thumb,
      imageKind: image?.kind,
      ts: Date.now(),
    })
    ydoc.transact(() => {
      ymeta.set('building', { by: user!.name, color: user!.color, at: Date.now() })
      ytext.delete(0, ytext.length)
    })
    setActiveFile(INDEX_FILE)
    setTab('code')

    const writer = createBuildWriter({
      reset: (path) => {
        if (path === INDEX_FILE) {
          ytext.delete(0, ytext.length)
          return
        }
        const existing = yfiles.get(path)
        if (existing) existing.delete(0, existing.length)
        else yfiles.set(path, new Y.Text())
      },
      append: (path, text) => {
        const t = path === INDEX_FILE ? ytext : yfiles.get(path)
        t?.insert(t.length, text)
      },
      onFile: (path) => setActiveFile(path), // follow the file being written
    })

    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          prompt: request,
          currentCode,
          noCache: opts?.noCache === true,
          image: image ? { mime: image.mime, data: image.data, kind: image.kind } : undefined,
        }),
      })
      if (!res.ok || !res.body) {
        // A rejected build answers with JSON before the stream opens — an
        // unreadable attachment or a server with no vision model says exactly
        // what is wrong, and that is worth more than "it didn't start".
        let message = 'The build could not start.'
        try {
          message = (await res.json())?.error || message
        } catch {
          /* not JSON — keep the generic line */
        }
        throw new Error(message)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastFlush = 0
      let summary: string | null = null
      let fromCache = false
      let reusedFrom: string | null = null
      let similarity: number | null = null

      const flush = (force: boolean) => {
        const now = Date.now()
        if ((force || now - lastFlush > 90) && pending) {
          const chunk = pending
          pending = ''
          ydoc.transact(() => writer.push(chunk))
          lastFlush = now
        }
      }

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          let obj: any
          try {
            obj = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          if (obj.delta) {
            pending += obj.delta
            flush(false)
          } else if (obj.error) {
            throw new Error(obj.error)
          } else if (obj.done) {
            summary = obj.summary ?? null
            fromCache = obj.cached === true
            reusedFrom = typeof obj.reusedFrom === 'string' ? obj.reusedFrom : null
            similarity = typeof obj.similarity === 'number' ? obj.similarity : null
          }
        }
      }
      flush(true)
      ydoc.transact(() => writer.end())
      const reply = summary || "Here's your app, running live in the preview. Tell me what to change."
      pushMessage({
        id: uid(),
        role: 'assistant',
        text: reply,
        hasBuild: true,
        fromCache,
        fromImage: image?.kind,
        // Only set when the cache matched loosely — the chat has to say so, and
        // offer a way out, rather than quietly serving somebody else's app.
        reusedFrom,
        similarity,
        prompt: said,
        ts: Date.now(),
      })
      if (voiceOut) speak(reply)
    } catch (err: any) {
      pushMessage({
        id: uid(),
        role: 'error',
        text: err?.message ? `That build didn't finish: ${err.message}` : "That build didn't come through. Try describing it again.",
        ts: Date.now(),
      })
    } finally {
      ydoc.transact(() => ymeta.set('building', null))
      setCacheTick((n) => n + 1)
    }
  }

  // The reused build wasn't what they meant. Run the same prompt again with the
  // cache bypassed, so they get one generated for them. Only ever offered for a
  // text build — an image build never consulted the cache in the first place.
  const rebuildFresh = (prompt: string) => runBuild(prompt, undefined, { noCache: true })

  // Precise line edits: the server turns "change line 14 in index.html" into
  // validated line operations against a snapshot of the current files, and we
  // apply exactly those ranges to the shared Yjs document — no clearing, no
  // rebuild, untouched lines stay byte-identical. The building flag drives the
  // same indicator + preview-refresh effect the build flow uses.
  const runLineEdit = async (prompt: string) => {
    const currentCode = serializeWorkspace(ytext.toString(), filesSnapshot())
    pushMessage({ id: uid(), role: 'user', authorName: user!.name, color: user!.color, text: prompt, ts: Date.now() })
    ydoc.transact(() => ymeta.set('building', { by: user!.name, color: user!.color, at: Date.now(), mode: 'edit' }))
    try {
      const { summary, edits, skipped, detail } = await api.edit(projectId, prompt, currentCode)

      const byFile = new Map<string, LineEdit[]>()
      for (const op of edits) {
        const list = byFile.get(op.file) ?? []
        list.push(op)
        byFile.set(op.file, list)
      }
      ydoc.transact(() => {
        for (const [file, ops] of byFile) {
          const target = file === INDEX_FILE ? ytext : yfiles.get(file)
          if (!target) continue // deleted by a collaborator mid-request
          replaceTextRanged(target, applyOpsToContent(target.toString(), ops))
        }
      })
      const firstFile = edits[0]?.file
      if (firstFile && (firstFile === INDEX_FILE || yfiles.has(firstFile))) setActiveFile(firstFile)

      let reply = summary || (detail ? `Updated ${detail}.` : 'Done — lines updated.')
      if (skipped.length > 0) {
        reply += ` (${skipped.length} requested change${skipped.length > 1 ? 's' : ''} couldn't be applied: ${skipped[0]})`
      }
      pushMessage({ id: uid(), role: 'assistant', text: reply, hasEdit: true, editNote: detail, ts: Date.now() })
      if (voiceOut) speak(reply)
    } catch (err: any) {
      pushMessage({
        id: uid(),
        role: 'error',
        text: err?.message
          ? `That edit didn't go through: ${err.message}`
          : "That edit didn't go through. Try naming the file and line, like \"change line 14 in index.html\".",
        ts: Date.now(),
      })
    } finally {
      ydoc.transact(() => ymeta.set('building', null))
    }
  }

  // Ctrl-K in the editor. The user highlighted an exact span, so its bounds
  // travel with the request and the reply replaces exactly those lines — no
  // line numbers inferred from wording, nothing else in the file disturbed.
  // Rejects on failure so the editor keeps its prompt open for a reword.
  const runInlineEdit = async (file: string, start: number, end: number, instruction: string) => {
    if (ymeta.get('building')) {
      toast('Wait for the current change to finish.')
      throw new Error('Something else is already running.')
    }
    const currentCode = serializeWorkspace(ytext.toString(), filesSnapshot())
    const span = start === end ? `line ${start}` : `lines ${start}–${end}`
    stayOnCode.current = true

    pushMessage({
      id: uid(),
      role: 'user',
      authorName: user!.name,
      color: user!.color,
      text: instruction,
      context: `${file} · ${span}`,
      ts: Date.now(),
    })
    ydoc.transact(() => ymeta.set('building', { by: user!.name, color: user!.color, at: Date.now(), mode: 'edit' }))

    try {
      const { summary, edit, detail } = await api.inlineEdit(projectId, { file, start, end, instruction, currentCode })
      const text = file === INDEX_FILE ? ytext : yfiles.get(file)
      if (!text) throw new Error('That file was removed from the project.')
      // Ranged replace: collaborators editing elsewhere in the file keep their
      // cursors, and the untouched lines stay byte-identical.
      ydoc.transact(() => replaceTextRanged(text, applyOpsToContent(text.toString(), [edit])))

      const reply = summary || `Updated ${detail}.`
      pushMessage({ id: uid(), role: 'assistant', text: reply, hasEdit: true, editNote: detail, ts: Date.now() })
      if (voiceOut) speak(reply)
    } catch (err: any) {
      pushMessage({
        id: uid(),
        role: 'error',
        text: `That edit didn't go through: ${err?.message || 'the request failed'}`,
        ts: Date.now(),
      })
      throw err
    } finally {
      ydoc.transact(() => ymeta.set('building', null))
    }
  }

  // Picking is one-shot: choosing an element disarms the picker and stages it
  // for the next message, so the chat is where you say what to do with it.
  const onPick = useCallback((el: PickedElement) => {
    setPickTarget(el)
    setPicking(false)
  }, [])

  const runPreview = () => {
    setPreviewCode(assemble())
    setTab('preview')
  }

  const projectName = projects.find((p) => p.id === projectId)?.name ?? 'Project'

  // Download the workspace as a real .zip: every file at its real path, folders
  // intact, no build step — unzip it and open index.html. Packaged in the
  // browser from the live Yjs document, so it always matches what's on screen.
  const exportZip = async () => {
    if (exporting) return
    // Mid-build the files are still being streamed in — packaging now would
    // hand the user a half-written project.
    if (building) {
      toast('Hold on — Lumen is still writing the files.')
      return
    }
    const entries = exportEntries(ytext.toString(), filesSnapshot())
    if (entries.length === 0) {
      toast('Nothing to export yet — describe an app in the chat first.')
      return
    }
    setExporting(true)
    try {
      const blob = await createZip(entries)
      downloadBlob(blob, exportFileName(projectName))
      toast(`Exported ${entries.length} file${entries.length === 1 ? '' : 's'}`)
    } catch (e: any) {
      toast(e?.message || 'Could not package the project.')
    } finally {
      setExporting(false)
    }
  }

  // What a published page serves: the app assembled exactly as the preview
  // assembles it, minus the element picker — that script exists only for the
  // in-app iframe and has no business on someone else's public link.
  const publishableHtml = () => assemblePreview(ytext.toString(), filesSnapshot())

  const toggleVoice = () => {
    setVoiceOut((on) => {
      if (on) stopSpeaking()
      else toast('Lumen will speak its replies')
      return !on
    })
  }

  // ── Resizable panels: drag the splitters; sizes persist across sessions. ──
  const [panels, setPanels] = useState(() => {
    try {
      return clampPanels(JSON.parse(localStorage.getItem(PANELS_KEY) || '{}'))
    } catch {
      return clampPanels({})
    }
  })
  useEffect(() => {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels))
  }, [panels])

  const dragRef = useRef<{ which: 'explorer' | 'conv'; startX: number; startW: number } | null>(null)
  const startDrag = (which: 'explorer' | 'conv') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    // Capture keeps the drag alive even over the preview iframe.
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { which, startX: e.clientX, startW: panels[which] }
  }
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    setPanels((prev) => clampPanels({ ...prev, [d.which]: d.which === 'explorer' ? d.startW + dx : d.startW - dx }))
  }
  const endDrag = () => {
    dragRef.current = null
  }

  return (
    <div className="app">
      <TopBar
        projects={projects}
        projectId={projectId}
        onSwitch={onSwitch}
        onNew={onNew}
        onShare={() => setShareOpen(true)}
        onRun={runPreview}
        onExport={exportZip}
        exporting={exporting}
        awareness={provider.awareness}
        voiceOut={voiceOut}
        onToggleVoice={toggleVoice}
        voiceOutSupported={speechOutputSupported()}
      />
      {/* Widths flow through CSS variables (not an inline grid template) so the
          responsive breakpoints in styles.css can still restructure the grid. */}
      <div
        className="main"
        style={{ '--explorer-w': `${panels.explorer}px`, '--conv-w': `${panels.conv}px` } as React.CSSProperties}
      >
        <FileExplorer
          projectName={projectName}
          files={files}
          active={activeFile}
          onSelect={selectFile}
          onCreate={createFile}
          onRename={renameFile}
          onDelete={deleteFile}
          cacheTick={cacheTick}
        />
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file explorer"
          onPointerDown={startDrag('explorer')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <PreviewPane
          tab={tab}
          onTab={setTab}
          previewCode={previewCode}
          building={building}
          builderName={meta.building?.by}
          activeFile={activeFile}
          activeText={textFor(activeFile)}
          awareness={provider.awareness}
          onRun={runPreview}
          onInlineEdit={runInlineEdit}
          picking={picking}
          onPicking={setPicking}
          onPick={onPick}
        />
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          onPointerDown={startDrag('conv')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <Conversation
          projectId={projectId}
          messages={ychat}
          meta={ymeta}
          onBuild={runBuild}
          onRebuild={rebuildFresh}
          target={pickTarget}
          onClearTarget={() => setPickTarget(null)}
        />
      </div>
      {shareOpen && (
        <ShareDialog
          projectId={projectId}
          projectName={projectName}
          isOwner={projects.find((p) => p.id === projectId)?.ownerId === user!.id}
          publishableHtml={publishableHtml}
          hasApp={hasIndex}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}
