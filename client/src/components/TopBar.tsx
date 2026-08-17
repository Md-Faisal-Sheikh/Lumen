import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'
import { useAwareness } from '../yhooks'
import { type ProjectSummary } from '../api'
import { toast } from '../toast'
import { runtimeLabel, type Runtime } from '../runtime'
import {
  Spark,
  Share,
  Play,
  Plus,
  SignOut,
  Volume,
  VolumeOff,
  Download,
  GitHub,
  GhostText,
  Compass,
  HistoryIcon,
  Terminal,
} from '../icons'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

// Avatar colors offered in the profile menu (any #rrggbb passes the server check).
const COLORS = ['#8b5cf6', '#e84cc4', '#38e0d8', '#3aa0ff', '#ff7eb6', '#f0a868', '#5ef0b6', '#b69bff', '#ef6a6a', '#eab308']

export function TopBar({
  projects,
  projectId,
  onSwitch,
  onNew,
  onShare,
  onRun,
  onExport,
  exporting,
  onGithub,
  onHistory,
  onDiscover,
  runtime,
  awareness,
  voiceOut,
  onToggleVoice,
  voiceOutSupported,
  suggestions,
  onToggleSuggestions,
  suggestionsSupported,
}: {
  projects: ProjectSummary[]
  projectId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onShare: () => void
  onRun: () => void
  onExport: () => void
  exporting: boolean
  onGithub: () => void
  onHistory: () => void
  onDiscover: () => void
  /** Which engine runs this project. Shown as a badge when it isn't the default. */
  runtime: Runtime
  awareness: any
  voiceOut: boolean
  onToggleVoice: () => void
  voiceOutSupported: boolean
  suggestions: boolean
  onToggleSuggestions: () => void
  /** False when the server has no completion model — the toggle is hidden. */
  suggestionsSupported: boolean
}) {
  const { user, logout, updateProfile } = useAuth()
  const peers = useAwareness(awareness)

  const [profileOpen, setProfileOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  // Close the profile menu when clicking anywhere outside it.
  useEffect(() => {
    if (!profileOpen) return
    const onDown = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [profileOpen])

  const toggleProfile = () => {
    if (!profileOpen && user) {
      setDraftName(user.name)
      setDraftColor(user.color)
    }
    setProfileOpen((v) => !v)
  }

  const saveProfile = async () => {
    if (!user || savingProfile) return
    const name = draftName.trim()
    if (!name) {
      toast('Enter a display name.')
      return
    }
    if (name === user.name && draftColor === user.color) {
      setProfileOpen(false)
      return
    }
    setSavingProfile(true)
    try {
      await updateProfile({ name, color: draftColor })
      toast('Profile updated')
      setProfileOpen(false)
    } catch (e: any) {
      toast(e?.message || 'Could not update your profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  // Everyone else currently in the room, de-duplicated by user id.
  const seen = new Set<string>(user ? [user.id] : [])
  const others: { id: string; name: string; color: string }[] = []
  for (const p of peers) {
    if (p.user && !seen.has(p.user.id)) {
      seen.add(p.user.id)
      others.push({ id: p.user.id, name: p.user.name, color: p.user.color })
    }
  }

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

      {/* The runtime badge appears only for projects that aren't the default web
          one. A label on every project would be noise; a label on the surprising
          case is information. */}
      {runtime === 'python' && (
        <span className="rt-badge" title="This project runs CPython in the browser (Pyodide)">
          <Terminal width={12} height={12} /> {runtimeLabel(runtime)}
        </span>
      )}

      <button className="btn ghost icon" onClick={onNew} title="New project" aria-label="New project">
        <Plus width={16} height={16} />
      </button>

      <button
        className="btn ghost icon"
        onClick={onDiscover}
        title="Discover — templates to fork and published projects to look at"
        aria-label="Discover templates and published projects"
      >
        <Compass width={16} height={16} />
      </button>

      <div className="spacer" />

      <div className="presence" ref={profileRef}>
        {user && (
          <button
            className="avatar you"
            style={{ background: user.color }}
            onClick={toggleProfile}
            title={`${user.name} — your profile`}
            aria-label="Open your profile"
            aria-expanded={profileOpen}
          >
            {initials(user.name)}
          </button>
        )}
        {others.length > 0 && (
          <div className="avatars">
            {others.slice(0, 4).map((p) => (
              <div key={p.id} className="avatar" style={{ background: p.color }} title={p.name}>
                {initials(p.name)}
              </div>
            ))}
          </div>
        )}

        {profileOpen && user && (
          <div className="profile-menu" role="dialog" aria-label="Your profile">
            <div className="pm-head">
              <div className="avatar pm-avatar" style={{ background: draftColor }}>
                {initials(draftName || user.name)}
              </div>
              <div className="pm-id">
                <div className="pm-name">{user.name}</div>
                <div className="pm-email">{user.email}</div>
              </div>
            </div>
            <label className="pm-label" htmlFor="pm-name-input">
              Display name
            </label>
            <input
              id="pm-name-input"
              className="pm-input"
              value={draftName}
              maxLength={60}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveProfile()
                if (e.key === 'Escape') setProfileOpen(false)
              }}
              spellCheck={false}
            />
            <span className="pm-label">Avatar color</span>
            <div className="pm-swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`pm-swatch ${draftColor === c ? 'sel' : ''}`}
                  style={{ background: c }}
                  onClick={() => setDraftColor(c)}
                  title={c}
                  aria-label={`Use color ${c}`}
                  aria-pressed={draftColor === c}
                />
              ))}
            </div>
            <div className="pm-actions">
              <button className="btn primary" onClick={saveProfile} disabled={savingProfile}>
                {savingProfile ? 'Saving…' : 'Save changes'}
              </button>
              <button className="btn ghost" onClick={logout}>
                <SignOut width={15} height={15} /> Sign out
              </button>
            </div>
          </div>
        )}
      </div>

      <button className="btn ghost" onClick={onRun}>
        <Play width={14} height={14} /> Run
      </button>
      <button
        className="btn ghost icon"
        onClick={onHistory}
        title="History — every build is a checkpoint you can go back to"
        aria-label="Open version history"
      >
        <HistoryIcon width={16} height={16} />
      </button>
      {suggestionsSupported && (
        <button
          className={`btn ghost icon ${suggestions ? 'active' : ''}`}
          onClick={onToggleSuggestions}
          title={
            suggestions
              ? 'Inline suggestions are on — Tab to accept, Alt+\\ to ask. Click to turn off.'
              : 'Turn on inline suggestions in the editor'
          }
          aria-label="Toggle inline code suggestions"
          aria-pressed={suggestions}
        >
          <GhostText width={16} height={16} />
        </button>
      )}
      <button
        className="btn ghost icon"
        onClick={onGithub}
        title="Commit and push this project to GitHub"
        aria-label="Push this project to GitHub"
      >
        <GitHub width={16} height={16} />
      </button>
      <button
        className="btn ghost icon"
        onClick={onExport}
        disabled={exporting}
        title="Download the project as a .zip — real files, real folders"
        aria-label="Download the project as a ZIP file"
      >
        <Download width={16} height={16} />
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
