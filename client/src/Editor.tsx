import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { api, getToken, WS_URL, API_URL, type ProjectSummary } from './api'
import { useAuth } from './auth'
import { useYMap, useYMapKeys, useYTextNonEmpty } from './yhooks'
import { toast } from './toast'
import { speak, stopSpeaking, speechOutputSupported } from './speech'
import { completionSupported } from './vision'
import {
  applyOpsToContent,
  assemblePreview,
  createBuildWriter,
  exportEntries,
  exportFileName,
  isLineEditPrompt,
  normalizePath,
  replaceTextRanged,
  serializeWorkspace,
  starterContent,
  type LineEdit,
} from './files'
import { asRuntime, entryFile, runtimeLabel, type Runtime } from './runtime'
import { buildPythonRunner } from './python'
import { createZip, downloadBlob } from './zip'
import { describeTarget, instrumentPreview, type PickedElement } from './picker'
import type { CompletionRequest } from './ghost'
import type { Attachment } from './vision'
import { TopBar } from './components/TopBar'
import { Conversation } from './components/Conversation'
import { PreviewPane } from './components/PreviewPane'
import { FileExplorer } from './components/FileExplorer'
import { ShareDialog } from './components/ShareDialog'
import { GitHubDialog } from './components/GitHubDialog'
import { HistoryDialog } from './components/HistoryDialog'
import { DiscoverDialog } from './components/DiscoverDialog'

const uid = () => Math.random().toString(36).slice(2, 10)

// Panel layout: explorer and chat have draggable widths; the workspace flexes.
const PANELS_KEY = 'lumen_panels'
// Whether ghost text is on. Remembered per browser: it is a preference about how
// the editor behaves, not something about the project, so it does not belong in
// the shared document where it would toggle for everyone in the room.
const SUGGEST_KEY = 'lumen_suggestions'
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
    // The runtime is fixed at creation, so it has to be asked for here. A
    // confirm is a blunt instrument for a two-way choice, but it beats the
    // alternative — letting someone build half a project before discovering it
    // can't run Python, at which point the entry file is already wrong.
    const wantsPython = window.confirm(
      'Which runtime should this project use?\n\n' +
        'OK      →  Python — real CPython in the browser, output to a console\n' +
        'Cancel  →  Web — HTML, CSS and JavaScript in a live preview\n\n' +
        "This can't be changed later."
    )
    const runtime: Runtime = wantsPython ? 'python' : 'web'
    try {
      const { project } = await api.createProject(name.trim() || 'Untitled project', runtime)
      await refresh(project.id)
      toast(`Project created · ${runtimeLabel(runtime)}`)
    } catch (e: any) {
      toast(e?.message || 'Could not create project.')
    }
  }

  // A fork lands as a brand-new project owned by whoever forked it, so the
  // project list has to be refetched before switching — it isn't in `projects`
  // yet, and Room would mount against an id the picker doesn't know.
  const openForked = async (id: string) => {
    try {
      await refresh(id)
    } catch (e: any) {
      toast(e?.message || 'Forked, but the project list could not be refreshed.')
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
      onForked={openForked}
    />
  )
}

// ── The collaborative room for a single project. ──
function Room({
  projectId,
  projects,
  onSwitch,
  onNew,
  onForked,
}: {
  projectId: string
  projects: ProjectSummary[]
  onSwitch: (id: string) => void
  onNew: () => void
  onForked: (id: string) => void
}) {
  const { user } = useAuth()

  const project = projects.find((p) => p.id === projectId)
  // Which engine runs this project, and therefore which file is the one that
  // runs. Everything below treats `entry` as an ordinary path — that is what
  // keeps the build stream, the version snapshots, the export and the GitHub
  // push from needing to know a runtime exists at all.
  const runtime: Runtime = asRuntime(project?.runtime)
  const entry = entryFile(runtime)
  const isPython = runtime === 'python'

  // One Yjs document + provider per project (remounted via key on switch).
  const ydoc = useMemo(() => new Y.Doc(), [projectId])
  const provider = useMemo(
    () => new HocuspocusProvider({ url: WS_URL, name: projectId, token: getToken() || '', document: ydoc }),
    [projectId, ydoc]
  )

  const ytext = useMemo(() => ydoc.getText('code'), [ydoc]) // the entry file — the build target
  const yfiles = useMemo(() => ydoc.getMap<Y.Text>('files'), [ydoc]) // extra files by path
  const ychat = useMemo(() => ydoc.getArray<Y.Map<any>>('chat'), [ydoc])
  const ymeta = useMemo(() => ydoc.getMap<any>('meta'), [ydoc])

  const meta = useYMap(ymeta)
  const building = !!meta.building

  const fileKeys = useYMapKeys(yfiles)
  // The entry file only shows in the explorer once something has been generated
  // (or a collaborator created other files) — a fresh project starts empty.
  const hasIndex = useYTextNonEmpty(ytext)
  const files = useMemo(() => {
    const rest = fileKeys.filter((k) => k !== entry)
    return hasIndex || rest.length > 0 ? [entry, ...rest] : rest
  }, [fileKeys, hasIndex, entry])
  const [activeFile, setActiveFile] = useState(entry)

  const [previewCode, setPreviewCode] = useState('')
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [voiceOut, setVoiceOut] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [picking, setPicking] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  // Bumped on every explicit Run. The preview iframe is keyed on it, which is
  // what restarts a Python interpreter that has already finished — and the only
  // way out of one that hasn't.
  const [runNonce, setRunNonce] = useState(0)
  // Template settings are owner-only and edited in the Share dialog; kept here
  // so the dialog reflects a change immediately rather than after a refetch.
  const [template, setTemplate] = useState({
    isTemplate: !!project?.isTemplate,
    description: project?.description ?? null,
  })
  // Default on: the feature is only discoverable by seeing it happen.
  const [suggestions, setSuggestions] = useState(() => localStorage.getItem(SUGGEST_KEY) !== 'off')
  // Whether this deployment has a completion model at all. Starts false so a
  // slow probe never briefly offers a toggle that then disappears.
  const [canComplete, setCanComplete] = useState(false)
  // Bumped after every build so the cache stats in the explorer refresh.
  const [cacheTick, setCacheTick] = useState(0)
  const [pickTarget, setPickTarget] = useState<PickedElement | null>(null)
  const wasBuilding = useRef(false)
  // An inline edit changes a few lines the user is looking at — refresh the
  // preview when it lands, but don't yank them off the code tab to show it.
  const stayOnCode = useRef(false)

  // If the file we're editing is deleted by a collaborator, fall back to the entry.
  useEffect(() => {
    if (activeFile !== entry && !fileKeys.includes(activeFile)) setActiveFile(entry)
  }, [fileKeys, activeFile, entry])

  const textFor = (path: string): Y.Text => (path === entry ? ytext : yfiles.get(path) ?? ytext)

  const filesSnapshot = (): Record<string, string> => {
    const snap: Record<string, string> = {}
    yfiles.forEach((text, path) => {
      if (path !== entry) snap[path] = text.toString()
    })
    return snap
  }

  /**
   * The document the preview iframe runs.
   *
   * For the web runtime it is the workspace inlined into one page plus the
   * element picker — instrumentation that lives only in this string, never in
   * the Yjs files, the version snapshots or the exported ZIP.
   *
   * For Python it is a console page that loads Pyodide, writes the project into
   * the interpreter's filesystem and runs the entry module. Both go into the
   * same sandboxed iframe with the same flags, so adding a runtime added no new
   * trust boundary to reason about.
   */
  const assemble = () => {
    const rest = filesSnapshot()
    if (isPython) return buildPythonRunner({ [entry]: ytext.toString(), ...rest }, entry)
    return instrumentPreview(assemblePreview(ytext.toString(), rest))
  }

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
  // The entry file is part of the path universe even while hidden from the explorer.
  const collision = (path: string) =>
    [entry, ...files].find((f) => f !== path && (f.startsWith(path + '/') || path.startsWith(f + '/')))

  const createFile = (input: string) => {
    const path = normalizePath(input)
    if (!path) {
      toast(isPython ? 'Use a simple path with an extension, like helpers/board.py' : 'Use a simple path with an extension, like styles/theme.css')
      return
    }
    if (path === entry || files.includes(path)) {
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
    if (from === entry) return
    const input = window.prompt('Rename file', from)
    if (input === null || input.trim() === from) return
    const to = normalizePath(input)
    if (!to) {
      toast(isPython ? 'Use a simple path with an extension, like helpers/board.py' : 'Use a simple path with an extension, like styles/theme.css')
      return
    }
    if (to === entry || files.includes(to)) {
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
    if (path === entry) return
    if (!window.confirm(`Delete ${path} for everyone in the room?`)) return
    yfiles.delete(path)
    if (activeFile === path) setActiveFile(entry)
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
    const currentCode = indexNow.trim() ? serializeWorkspace(entry, indexNow, filesSnapshot()) : ''
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
    setActiveFile(entry)
    setTab('code')

    const writer = createBuildWriter({
      runtime,
      reset: (path) => {
        if (path === entry) {
          ytext.delete(0, ytext.length)
          return
        }
        const existing = yfiles.get(path)
        if (existing) existing.delete(0, existing.length)
        else yfiles.set(path, new Y.Text())
      },
      append: (path, text) => {
        const t = path === entry ? ytext : yfiles.get(path)
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
      // A build finishing means something different per runtime: the web preview
      // is already showing the result, while a Python program has only just been
      // handed to an interpreter that is about to start.
      if (isPython) setRunNonce((n) => n + 1)
      const reply =
        summary ||
        (isPython
          ? "Here's your program. It's running in the console — press Run to start it again."
          : "Here's your app, running live in the preview. Tell me what to change.")
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
    const currentCode = serializeWorkspace(entry, ytext.toString(), filesSnapshot())
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
          const target = file === entry ? ytext : yfiles.get(file)
          if (!target) continue // deleted by a collaborator mid-request
          replaceTextRanged(target, applyOpsToContent(target.toString(), ops))
        }
      })
      const firstFile = edits[0]?.file
      if (firstFile && (firstFile === entry || yfiles.has(firstFile))) setActiveFile(firstFile)

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
    const currentCode = serializeWorkspace(entry, ytext.toString(), filesSnapshot())
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
      const text = file === entry ? ytext : yfiles.get(file)
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
    // Bumping the nonce remounts the frame. For the web runtime that's the
    // reload Run always meant; for Python it starts a fresh interpreter, which
    // is the only way to re-run a program that has already exited.
    setRunNonce((n) => n + 1)
    setTab('preview')
  }

  /**
   * Apply a restored checkpoint to the shared document.
   *
   * Three things have to be true for this to be a *restore* rather than an
   * overwrite. It runs in one Yjs transaction, so collaborators see one change
   * instead of a flurry. It uses a ranged replace on each file, so anyone with a
   * cursor in an untouched region keeps it. And it deletes files the checkpoint
   * doesn't have — without that, restoring to a point before a file existed
   * would leave that file behind, and the "restored" project would be a state
   * the project was never actually in.
   */
  const restoreWorkspace = async (restored: Record<string, string>, label: string) => {
    const entryContent = restored[entry] ?? ''
    ydoc.transact(() => {
      replaceTextRanged(ytext, entryContent)
      for (const [path, content] of Object.entries(restored)) {
        if (path === entry) continue
        const existing = yfiles.get(path)
        if (existing) replaceTextRanged(existing, content)
        else yfiles.set(path, new Y.Text(content))
      }
      for (const path of [...yfiles.keys()]) {
        if (path !== entry && !(path in restored)) yfiles.delete(path)
      }
    })
    setActiveFile(entry)
    setPreviewCode(assemble())
    setRunNonce((n) => n + 1)
    setTab('preview')
    pushMessage({
      id: uid(),
      role: 'assistant',
      text: `Restored the project to “${label}”. The code from before is saved as its own checkpoint, so you can go back.`,
      ts: Date.now(),
    })
  }

  const projectName = project?.name ?? 'Project'

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
    const entries = exportEntries(entry, ytext.toString(), filesSnapshot())
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
  //
  // A Python project publishes its console page, which carries the interpreter
  // loader and the program's own source. That is the honest thing to serve: the
  // published link runs the program in the reader's browser exactly as it ran in
  // the author's, with no server executing anything on either side.
  const publishableHtml = () => {
    const rest = filesSnapshot()
    if (isPython) return buildPythonRunner({ [entry]: ytext.toString(), ...rest }, entry)
    return assemblePreview(ytext.toString(), rest)
  }

  // What a commit contains: the same real files the ZIP export writes, at the
  // same paths. Deliberately shared with the export rather than assembled
  // separately — a repository and a downloaded folder disagreeing about what the
  // project is would be a bug nobody would think to look for.
  const pushableFiles = () => exportEntries(entry, ytext.toString(), filesSnapshot())

  // The live workspace in marker format. The history panel sends this along with
  // a restore so the server can snapshot it first.
  const currentWorkspace = () => (ytext.toString().trim() ? serializeWorkspace(entry, ytext.toString(), filesSnapshot()) : '')

  // Ghost text asks for this on a pause in typing. It stays quiet by design:
  // failures return null rather than throwing, so a provider hiccup means "no
  // suggestion" instead of an error card in a chat nobody was talking to. The
  // abort is passed straight through, which is what lets the server drop its own
  // upstream call the moment the next keystroke supersedes this one.
  const completeAt = useCallback(
    async (req: CompletionRequest): Promise<string | null> => {
      // Mid-build the file is still arriving; a suggestion would be computed
      // against half a document.
      if (ymeta.get('building')) return null
      try {
        const { completion } = await api.complete(
          projectId,
          { file: req.file, prefix: req.prefix, suffix: req.suffix },
          req.signal
        )
        return completion
      } catch {
        return null
      }
    },
    [projectId, ymeta]
  )

  useEffect(() => {
    let alive = true
    completionSupported().then((ok) => alive && setCanComplete(ok))
    return () => {
      alive = false
    }
  }, [])

  const toggleSuggestions = () => {
    setSuggestions((on) => {
      const next = !on
      localStorage.setItem(SUGGEST_KEY, next ? 'on' : 'off')
      toast(next ? 'Inline suggestions on — Tab to accept' : 'Inline suggestions off')
      return next
    })
  }

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
        onGithub={() => setGithubOpen(true)}
        onHistory={() => setHistoryOpen(true)}
        onDiscover={() => setDiscoverOpen(true)}
        runtime={runtime}
        awareness={provider.awareness}
        voiceOut={voiceOut}
        onToggleVoice={toggleVoice}
        voiceOutSupported={speechOutputSupported()}
        suggestions={suggestions}
        onToggleSuggestions={toggleSuggestions}
        suggestionsSupported={canComplete}
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
          entry={entry}
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
          runtime={runtime}
          runNonce={runNonce}
          building={building}
          builderName={meta.building?.by}
          activeFile={activeFile}
          activeText={textFor(activeFile)}
          awareness={provider.awareness}
          onRun={runPreview}
          onInlineEdit={runInlineEdit}
          onComplete={completeAt}
          suggestions={suggestions && canComplete}
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
          isOwner={project?.ownerId === user!.id}
          publishableHtml={publishableHtml}
          hasApp={hasIndex}
          isTemplate={template.isTemplate}
          description={template.description}
          onTemplateChange={setTemplate}
          onClose={() => setShareOpen(false)}
        />
      )}
      {githubOpen && (
        <GitHubDialog
          projectId={projectId}
          projectName={projectName}
          isOwner={project?.ownerId === user!.id}
          files={pushableFiles}
          hasApp={hasIndex}
          onClose={() => setGithubOpen(false)}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          projectId={projectId}
          projectName={projectName}
          runtime={runtime}
          currentWorkspace={currentWorkspace}
          onRestore={restoreWorkspace}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {discoverOpen && <DiscoverDialog onForked={onForked} onClose={() => setDiscoverOpen(false)} />}
    </div>
  )
}
