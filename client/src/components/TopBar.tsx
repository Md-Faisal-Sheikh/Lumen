import { useAuth } from '../auth'
import { useAwareness } from '../yhooks'
import { type ProjectSummary } from '../api'
import { Spark, Share, Play, Plus, SignOut, Volume, VolumeOff } from '../icons'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

export function TopBar({
  projects,
  projectId,
  onSwitch,
  onNew,
  onShare,
  onRun,
  awareness,
  voiceOut,
  onToggleVoice,
  voiceOutSupported,
}: {
  projects: ProjectSummary[]
  projectId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onShare: () => void
  onRun: () => void
  awareness: any
  voiceOut: boolean
  onToggleVoice: () => void
  voiceOutSupported: boolean
}) {
  const { user, logout } = useAuth()
  const peers = useAwareness(awareness)

  // De-duplicate everyone currently in the room by user id (you + peers).
  const seen = new Set<string>()
  const people: { id: string; name: string; color: string; you?: boolean }[] = []
  if (user) {
    people.push({ id: user.id, name: user.name, color: user.color, you: true })
    seen.add(user.id)
  }
  for (const p of peers) {
    if (p.user && !seen.has(p.user.id)) {
      seen.add(p.user.id)
      people.push({ id: p.user.id, name: p.user.name, color: p.user.color })
    }
  }
  const others = people.length - 1

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark">
          <Spark width={17} height={17} />
        </div>
        <div className="wordmark">
          Lum<b>en</b>
        </div>
      </div>

      <div className="proj">
        <select
          value={projectId}
          onChange={(e) => {
            if (e.target.value === '__new__') onNew()
            else onSwitch(e.target.value)
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new__">+ New project…</option>
        </select>
      </div>

      <button className="btn ghost icon" onClick={onNew} title="New project" aria-label="New project">
        <Plus width={16} height={16} />
      </button>

      <div className="spacer" />

      <div className="presence">
        <div className="live">
          <span className="dot" />
          <span>{others > 0 ? `${others} other${others > 1 ? 's' : ''} here` : 'Live'}</span>
        </div>
        <div className="avatars">
          {people.slice(0, 4).map((p) => (
            <div key={p.id} className="avatar" style={{ background: p.color }} title={p.you ? `${p.name} (you)` : p.name}>
              {initials(p.name)}
            </div>
          ))}
        </div>
      </div>

      <button className="btn ghost" onClick={onRun}>
        <Play width={14} height={14} /> Run
      </button>
      {voiceOutSupported && (
        <button
          className={`btn ghost icon ${voiceOut ? 'active' : ''}`}
          onClick={onToggleVoice}
          title={voiceOut ? 'Lumen is speaking replies — click to mute' : 'Have Lumen speak its replies'}
          aria-label="Toggle spoken replies"
          aria-pressed={voiceOut}
        >
          {voiceOut ? <Volume width={16} height={16} /> : <VolumeOff width={16} height={16} />}
        </button>
      )}
      <button className="btn primary" onClick={onShare}>
        <Share width={15} height={15} /> Share
      </button>
      <button className="btn ghost icon" onClick={logout} title="Sign out" aria-label="Sign out">
        <SignOut width={16} height={16} />
      </button>
    </header>
  )
}
