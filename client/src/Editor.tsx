import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { api, getToken, WS_URL, API_URL, type ProjectSummary } from './api'
import { useAuth } from './auth'
import { useYMap } from './yhooks'
import { toast } from './toast'
import { speak, stopSpeaking, speechOutputSupported } from './speech'
import { TopBar } from './components/TopBar'
import { Conversation } from './components/Conversation'
import { PreviewPane } from './components/PreviewPane'

const uid = () => Math.random().toString(36).slice(2, 10)
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

  const ytext = useMemo(() => ydoc.getText('code'), [ydoc])
  const ychat = useMemo(() => ydoc.getArray<Y.Map<any>>('chat'), [ydoc])
  const ymeta = useMemo(() => ydoc.getMap<any>('meta'), [ydoc])

  const meta = useYMap(ymeta)
  const building = !!meta.building

  const [previewCode, setPreviewCode] = useState('')
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [voiceOut, setVoiceOut] = useState(false)
  const wasBuilding = useRef(false)

  // Identify ourselves to other people in the room (drives cursors + presence).
  useEffect(() => {
    provider.awareness?.setLocalStateField('user', { name: user!.name, color: user!.color, id: user!.id })
    return () => {
      provider.destroy()
      ydoc.destroy()
    }
  }, [provider, ydoc, user])

  // Show persisted code once the document has synced from the server.
  useEffect(() => {
    const onSynced = () => {
      const code = ytext.toString()
      if (code && !ymeta.get('building')) setPreviewCode(code)
    }
    provider.on('synced', onSynced)
    return () => provider.off('synced', onSynced)
  }, [provider, ytext, ymeta])

  // Refresh the preview when a build finishes (building flips true → false).
  useEffect(() => {
    if (wasBuilding.current && !building) {
      setPreviewCode(ytext.toString())
      setTab('preview')
    }
    wasBuilding.current = building
  }, [building, ytext])

  const pushMessage = (msg: Record<string, any>) => {
    const m = new Y.Map<any>()
    Object.entries(msg).forEach(([k, v]) => m.set(k, v))
    ychat.push([m])
  }

  // The build: stream generated code into the shared Y.Text so everyone watches it write.
  const runBuild = async (prompt: string) => {
    if (ymeta.get('building')) return
    const currentCode = ytext.toString()

    pushMessage({ id: uid(), role: 'user', authorName: user!.name, color: user!.color, text: prompt, ts: Date.now() })
    ydoc.transact(() => {
      ymeta.set('building', { by: user!.name, color: user!.color, at: Date.now() })
      ytext.delete(0, ytext.length)
    })
    setTab('code')

    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ prompt, currentCode }),
      })
      if (!res.ok || !res.body) throw new Error('The build could not start.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastFlush = 0
      let summary: string | null = null

      const flush = (force: boolean) => {
        const now = Date.now()
        if ((force || now - lastFlush > 90) && pending) {
          const chunk = pending
          pending = ''
          ydoc.transact(() => ytext.insert(ytext.length, chunk))
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
          }
        }
      }
      flush(true)
      const reply = summary || "Here's your app, running live on the right. Tell me what to change."
      pushMessage({
        id: uid(),
        role: 'assistant',
        text: reply,
        hasBuild: true,
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
    }
  }

  const runPreview = () => {
    setPreviewCode(ytext.toString())
    setTab('preview')
  }

  const share = async () => {
    const email = window.prompt('Invite a teammate by their Lumen email')
    if (!email) {
      navigator.clipboard?.writeText(`${location.origin}?p=${projectId}`).then(
        () => toast('Project link copied'),
        () => {}
      )
      return
    }
    try {
      await api.invite(projectId, email.trim())
      await navigator.clipboard?.writeText(`${location.origin}?p=${projectId}`).catch(() => {})
      toast(`Invited ${email.trim()} · link copied`)
    } catch (e: any) {
      toast(e?.message || 'Could not invite that person.')
    }
  }

  const toggleVoice = () => {
    setVoiceOut((on) => {
      if (on) stopSpeaking()
      else toast('Lumen will speak its replies')
      return !on
    })
  }

  return (
    <div className="app">
      <TopBar
        projects={projects}
        projectId={projectId}
        onSwitch={onSwitch}
        onNew={onNew}
        onShare={share}
        onRun={runPreview}
        awareness={provider.awareness}
        voiceOut={voiceOut}
        onToggleVoice={toggleVoice}
        voiceOutSupported={speechOutputSupported()}
      />
      <div className="main">
        <Conversation messages={ychat} meta={ymeta} onBuild={runBuild} />
        <PreviewPane
          tab={tab}
          onTab={setTab}
          previewCode={previewCode}
          building={building}
          builderName={meta.building?.by}
          ytext={ytext}
          awareness={provider.awareness}
          onRun={runPreview}
        />
      </div>
    </div>
  )
}
