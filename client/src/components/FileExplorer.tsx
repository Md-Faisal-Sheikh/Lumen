import { useEffect, useRef, useState } from 'react'
import { buildTree, INDEX_FILE, type TreeNode } from '../files'
import { Chevron, FileIcon, FilePlus, FolderIcon, FolderOpenIcon, Pencil, Trash } from '../icons'

// VS Code-style explorer: nested folders, entry-point pin, hover actions.
// Folders are implied by "/" in file paths (e.g. "styles/theme.css").
export function FileExplorer({
  projectName,
  files,
  active,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  projectName: string
  files: string[]
  active: string
  onSelect: (path: string) => void
  onCreate: (path: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const tree = buildTree(files)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const submitDraft = () => {
    const value = draft.trim()
    setCreating(false)
    setDraft('')
    if (value) onCreate(value)
  }

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const indent = { paddingLeft: 10 + depth * 14 }
    if (node.type === 'folder') {
      const isCollapsed = collapsed.has(node.path)
      return (
        <div key={node.path}>
          <button className="tree-row" style={indent} onClick={() => toggleFolder(node.path)}>
            <Chevron className={`tw ${isCollapsed ? '' : 'open'}`} width={13} height={13} />
            {isCollapsed ? <FolderIcon className="ti folder" width={15} height={15} /> : <FolderOpenIcon className="ti folder" width={15} height={15} />}
            <span className="tname">{node.name}</span>
          </button>
          {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      )
    }
    const isIndex = node.path === INDEX_FILE
    return (
      <div key={node.path} className={`tree-row file ${active === node.path ? 'active' : ''}`} style={indent} onClick={() => onSelect(node.path)}>
        <span className="tw" />
        <FileIcon className={`ti ${extClass(node.name)}`} width={15} height={15} />
        <span className="tname">{node.name}</span>
        {!isIndex && (
          <span className="row-actions">
            <button
              className="ract"
              title="Rename"
              aria-label={`Rename ${node.path}`}
              onClick={(e) => {
                e.stopPropagation()
                onRename(node.path)
              }}
            >
              <Pencil width={13} height={13} />
            </button>
            <button
              className="ract danger"
              title="Delete"
              aria-label={`Delete ${node.path}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(node.path)
              }}
            >
              <Trash width={13} height={13} />
            </button>
          </span>
        )}
      </div>
    )
  }

  return (
    <aside className="explorer">
      <div className="exp-head">
        <span className="exp-label">Explorer</span>
        <button className="ract" title="New file (use / for folders)" aria-label="New file" onClick={() => setCreating(true)}>
          <FilePlus width={15} height={15} />
        </button>
      </div>
      <div className="exp-project">
        <Chevron className="tw open" width={13} height={13} />
        <span>{projectName}</span>
      </div>
      <div className="tree">
        {creating && (
          <div className="newfile-row">
            <FileIcon className="ti" width={15} height={15} />
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={submitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setDraft('')
                }
              }}
              placeholder="styles/theme.css"
              spellCheck={false}
            />
          </div>
        )}
        {tree.map((node) => renderNode(node, 0))}
        {files.length === 0 && !creating && (
          <div className="exp-empty">No files yet — describe your app in the chat and Lumen will create them here.</div>
        )}
      </div>
    </aside>
  )
}

function extClass(name: string): string {
  if (/\.css$/i.test(name)) return 'css'
  if (/\.(m?js|jsx|ts|tsx)$/i.test(name)) return 'js'
  if (/\.html?$/i.test(name)) return 'html'
  return ''
}
