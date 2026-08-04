import type { SVGProps } from 'react'

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
})

export const Spark = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
  </svg>
)
export const Send = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12l14-7-7 14-2-5-5-2Z" />
  </svg>
)
export const Share = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6" />
  </svg>
)
export const Play = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M7 5l12 7-12 7V5Z" fill="currentColor" stroke="none" />
  </svg>
)
export const CodeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  </svg>
)
export const EyeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
)
export const Refresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 1 0-.5 4M20 5v6h-6" />
  </svg>
)
export const Copy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
)
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const SignOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
  </svg>
)
export const Mic = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
export const Volume = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M16 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />
  </svg>
)
export const VolumeOff = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </svg>
)
export const Chevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)
export const FileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
  </svg>
)
export const FolderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </svg>
)
export const FolderOpenIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H6.5a2 2 0 0 0-1.9 1.4L3 16V7Z" />
    <path d="M3 16l1.8-5.2A2 2 0 0 1 6.7 9.5H21l-2.2 7.1a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1.9Z" />
  </svg>
)
export const FilePlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M12 12v6M9 15h6" />
  </svg>
)
export const Trash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h16M10 4h4M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 11v6M14 11v6" />
  </svg>
)
export const Pencil = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" />
    <path d="M14.5 6.5l3 3" />
  </svg>
)
export const HistoryIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" />
    <path d="M3.5 4v4.5H8M12 8v4.5l3 2" />
  </svg>
)
export const SaveIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M7 3v5h8V3M7 21v-7h10v7" />
  </svg>
)
export const Recycle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4.8 15.5 3.4 18a2 2 0 0 0 1.7 3H9M19.2 15.5 20.6 18a2 2 0 0 1-1.7 3H10" />
    <path d="M9.9 5.4 8.5 7.9M14.1 5.4a2 2 0 0 0-3.4 0L8.5 9.3M15.5 7.9 20 15.6" />
    <path d="M6.6 12.2 3.9 16.9M11 21l2.2-2.4L11 16.2" />
  </svg>
)
export const Globe = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
  </svg>
)
export const Pointer = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5.5 3.2 18 10.4l-5.3 1.4-2.3 5.1-4.9-13.7Z" />
    <path d="M13.5 13.5 19 19" />
  </svg>
)
export const Download = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
)
export const Close = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const ArrowLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
)
