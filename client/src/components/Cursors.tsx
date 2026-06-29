import { useAwareness } from '../yhooks'

// Floating presence cursors over the workspace, positioned from normalized coords.
export function Cursors({ awareness, size }: { awareness: any; size: { w: number; h: number } }) {
  const peers = useAwareness(awareness)
  return (
    <div className="cursors" aria-hidden="true">
      {peers
        .filter((p) => p.cursor && p.user)
        .map((p) => (
          <div
            key={p.id}
            className="cursor"
            style={{ transform: `translate(${p.cursor!.nx * size.w}px, ${p.cursor!.ny * size.h}px)` }}
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M5 3l15 7.5-6.4 1.7L10 19 5 3Z" fill={p.user!.color} stroke="#0a0712" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span className="tag" style={{ background: p.user!.color, color: '#0a0712' }}>
              {p.user!.name}
            </span>
          </div>
        ))}
    </div>
  )
}
