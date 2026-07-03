import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { webuiApi, type FileTreeNode, type KnowledgeBase } from '@/api/webui'
import ChatPage from '@/features/chat/ChatPage'
import {
  Folder, FolderOpen, FileText, Trash2, Upload, Save, ArrowLeft,
  Loader2, BookOpen, Search, AlertTriangle, RefreshCw, ChevronsDownUp, ChevronsUpDown,
} from 'lucide-react'

const EDITABLE_EXT = ['.md', '.mdx', '.txt', '.markdown']

export default function KnowledgeDetailPage() {
  const { t } = useTranslation()
  const { name = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const kbName = decodeURIComponent(name)

  const [tab, setTab] = useState<'edit' | 'chat'>('edit')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  // Track closed directory paths so the file tree is fully expanded by default
  // (empty set = everything open) but can be collapsed en masse via the toolbar.
  const [closedPaths, setClosedPaths] = useState<Set<string>>(() => new Set())

  const { data: tree = [], isLoading: treeLoading } = useQuery({
    queryKey: ['kb-files', kbName],
    queryFn: () => webuiApi.getFileTree(kbName),
  })

  const allDirPaths = useMemo(() => collectDirPaths(tree), [tree])
  const allCollapsed = allDirPaths.length > 0 && allDirPaths.every(p => closedPaths.has(p))
  const toggleCollapseAll = () => {
    setClosedPaths(allCollapsed ? new Set() : new Set(allDirPaths))
  }
  const toggleDir = (path: string) => {
    setClosedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Fetch the KB record so the SearchPanel knows the on-disk path to inject
  // as context for the llm-wiki-agent.
  const { data: kbs = [] } = useQuery({
    queryKey: ['knowledge-base'],
    queryFn: webuiApi.getKnowledgeBases,
  })
  const kb = (kbs as KnowledgeBase[]).find(k => k.name === kbName)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 border-b flex items-center gap-2 shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <button onClick={() => navigate('/knowledge')} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
          <ArrowLeft size={14} />
        </button>
        <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2" style={{ color: 'var(--as-ink)' }}>
          <BookOpen size={16} /> {kb?.display_name || kbName}
        </h2>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: file tree */}
        <div className="w-64 border-r flex flex-col shrink-0"
          style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
          <div className="px-3 py-2 border-b flex items-center justify-between"
            style={{ borderColor: 'var(--as-hairline)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--as-ink-80)' }}>{t('knowledge.detail.files')}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleCollapseAll}
                disabled={tree.length === 0}
                className="as-btn as-btn-ghost as-btn-sm"
                style={{ padding: '3px 6px' }}
                title={allCollapsed ? t('knowledge.detail.expandAll') : t('knowledge.detail.collapseAll')}
              >
                {allCollapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
              </button>
              <button
                onClick={() => qc.invalidateQueries({ queryKey: ['kb-files', kbName] })}
                className="as-btn as-btn-ghost as-btn-sm"
                style={{ padding: '3px 6px' }}
                title={t('knowledge.detail.refresh')}
              >
                <RefreshCw size={12} />
              </button>
              <UploadButton kbName={kbName} onUploaded={() => qc.invalidateQueries({ queryKey: ['kb-files', kbName] })} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {treeLoading && <p className="text-xs flex items-center gap-1" style={{ color: 'var(--as-ink-48)' }}><Loader2 size={12} className="animate-spin" /> {t('common.status.loading')}</p>}
            {!treeLoading && tree.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('knowledge.detail.noFiles')}</p>
            )}
            {tree.map(node => (
              <FileTreeItem
                key={node.path}
                node={node}
                depth={0}
                selected={selectedFile}
                onSelect={(path) => { setSelectedFile(path); setTab('edit') }}
                onDelete={(path) => {
                  if (window.confirm(t('knowledge.detail.deleteFileConfirm', { name: path }))) {
                    webuiApi.deleteKBFile(kbName, path).then(() => qc.invalidateQueries({ queryKey: ['kb-files', kbName] }))
                    if (selectedFile === path) setSelectedFile(null)
                  }
                }}
                isOpen={!closedPaths.has(node.path)}
                onToggle={toggleDir}
                isPathOpen={(p: string) => !closedPaths.has(p)}
              />
            ))}
          </div>
        </div>

        {/* Right: tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b flex shrink-0" style={{ borderColor: 'var(--as-hairline)' }}>
            <TabButton active={tab === 'edit'} onClick={() => setTab('edit')} icon={<FileText size={13} />}>
              {t('knowledge.detail.tabs.edit')}
            </TabButton>
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<Search size={13} />}>
              {t('knowledge.detail.tabs.chat')}
            </TabButton>
          </div>

          {tab === 'edit' ? (
            <EditPanel kbName={kbName} file={selectedFile} />
          ) : (
            <SearchPanel kbName={kbName} kbPath={kb?.path ?? ''} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// File tree
// ─────────────────────────────────────────────────────────────────────────────

// Walk the tree once to collect every directory path, so the toolbar can
// collapse/expand all folders without each FileTreeItem owning its own state.
function collectDirPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = []
  const walk = (ns: FileTreeNode[]) => {
    for (const n of ns) {
      if (n.type === 'directory') {
        out.push(n.path)
        if (n.children) walk(n.children)
      }
    }
  }
  walk(nodes)
  return out
}

interface FileTreeItemProps {
  node: FileTreeNode
  depth: number
  selected: string | null
  onSelect: (path: string) => void
  onDelete: (path: string) => void
  isOpen: boolean
  onToggle: (path: string) => void
  isPathOpen: (path: string) => boolean
}

function FileTreeItem({ node, depth, selected, onSelect, onDelete, isOpen, onToggle, isPathOpen }: FileTreeItemProps) {
  const isDir = node.type === 'directory'
  const isSelected = selected === node.path

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer text-xs group"
        style={{
          marginLeft: depth * 12,
          background: isSelected ? 'var(--as-primary)' : 'transparent',
          color: isSelected ? '#fff' : 'var(--as-ink)',
        }}
        onClick={() => isDir ? onToggle(node.path) : onSelect(node.path)}
      >
        {isDir ? (
          isOpen ? <FolderOpen size={13} className="shrink-0" /> : <Folder size={13} className="shrink-0" />
        ) : (
          <FileText size={13} className="shrink-0" />
        )}
        <span className="flex-1 truncate">{node.name}</span>
        {!isDir && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(node.path) }}
            className="opacity-0 group-hover:opacity-100 shrink-0"
            style={{ color: isSelected ? '#fff' : 'rgb(185,28,28)' }}
            title="delete"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {isDir && isOpen && node.children?.map(child => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onDelete={onDelete}
          isOpen={isPathOpen(child.path)}
          onToggle={onToggle}
          isPathOpen={isPathOpen}
        />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload button
// ─────────────────────────────────────────────────────────────────────────────

function UploadButton({ kbName, onUploaded }: { kbName: string; onUploaded: () => void }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleFile = async (file: File) => {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!EDITABLE_EXT.includes(ext)) {
      alert(t('knowledge.detail.unsupportedType'))
      return
    }
    setUploading(true)
    try {
      await webuiApi.uploadKBFile(kbName, file)
      onUploaded()
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.detail ?? (err instanceof Error ? err.message : '')
      alert(typeof msg === 'string' ? msg : JSON.stringify(msg))
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <button onClick={() => inputRef.current?.click()} disabled={uploading}
        className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '3px 6px' }} title={t('knowledge.detail.upload')}>
        {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
      </button>
      <input
        ref={inputRef} type="file" accept=".md,.mdx,.txt,.markdown" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit panel
// ─────────────────────────────────────────────────────────────────────────────

function EditPanel({ kbName, file }: { kbName: string; file: string | null }) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['kb-file', kbName, file],
    queryFn: () => webuiApi.readKBFile(kbName, file!),
    enabled: !!file,
    retry: false,
  })

  useEffect(() => {
    if (data) { setContent(data.content); setDirty(false) }
  }, [data])

  const saveMut = useMutation({
    mutationFn: () => webuiApi.writeKBFile(kbName, file!, content),
    onSuccess: () => setDirty(false),
  })

  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--as-ink-48)' }}>
        <p className="text-sm">{t('knowledge.detail.selectFile')}</p>
      </div>
    )
  }

  const readError = error ? ((error as any)?.response?.data?.detail ?? t('common.error.requestFailed')) : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 border-b flex items-center justify-between shrink-0"
        style={{ borderColor: 'var(--as-hairline)' }}>
        <span className="text-xs font-mono truncate" style={{ color: 'var(--as-ink-80)' }}>{file}</span>
        <button
          onClick={() => saveMut.mutate()}
          disabled={!dirty || saveMut.isPending}
          className="as-btn as-btn-primary as-btn-sm"
        >
          {saveMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          <span className="ml-1">{t('knowledge.detail.save')}</span>
        </button>
      </div>
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--as-ink-48)' }}>
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : readError ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center gap-2" style={{ color: 'var(--as-ink-48)' }}>
            <AlertTriangle size={24} />
            <p className="text-sm">{typeof readError === 'string' ? readError : JSON.stringify(readError)}</p>
          </div>
        </div>
      ) : (
        <textarea
          className="flex-1 w-full resize-none outline-none p-4 font-mono text-sm"
          style={{
            background: 'var(--as-canvas)',
            color: 'var(--as-ink)',
            border: 'none',
          }}
          value={content}
          onChange={(e) => { setContent(e.target.value); setDirty(true) }}
          spellCheck={false}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Search panel — embeds the full ChatPage with the llm-wiki-agent
// pre-selected. Reusing ChatPage gives us preset questions, the skill picker,
// attachments, MCP error banners — everything the main chat page has.
// The KB path is stashed as a `chatWithKB` sessionStorage handoff so ChatPage
// pre-fills the input with a context prefix the llm-wiki skill reads to scope
// retrieval to this knowledge base.
// ─────────────────────────────────────────────────────────────────────────────

interface SearchPanelProps {
  kbName: string
  kbPath: string
}

function SearchPanel({ kbName, kbPath }: SearchPanelProps) {
  const { t } = useTranslation()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Resolve the llm-wiki-agent, stash the handoff, then mount ChatPage.
  useEffect(() => {
    let cancelled = false
    webuiApi.getKBAgentId()
      .then(({ agent_id }) => {
        if (cancelled) return
        // Set the handoff BEFORE ChatPage mounts — its onMount effect reads
        // this and pre-selects the agent + pre-fills the KB context prefix.
        // kbName lets ChatPage pin one session per KB (resumed on reopen).
        sessionStorage.setItem('chatWithKB', JSON.stringify({
          agentId: agent_id,
          prefix: kbPath ? `[知识库路径: ${kbPath}]` : `[知识库: ${kbName}]`,
          kbName,
        }))
        setAgentId(agent_id)
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as any)?.response?.status
        const detail = (err as any)?.response?.data?.detail
        if (status === 404) {
          setError(typeof detail === 'string' ? detail : t('knowledge.detail.agentNotFound'))
        } else {
          setError(typeof detail === 'string' ? detail : (err instanceof Error ? err.message : t('common.error.requestFailed')))
        }
      })
    return () => { cancelled = true }
  }, [kbName, kbPath, t])

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
        <AlertTriangle size={32} style={{ color: 'rgb(185,28,28)' }} />
        <div className="text-sm text-center max-w-md" style={{ color: 'rgb(185,28,28)' }}>{error}</div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
        <Loader2 size={28} className="animate-spin" style={{ color: 'var(--as-ink-48)' }} />
        <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>
      </div>
    )
  }

  // key by kbName+agentId so switching KBs remounts ChatPage with a fresh handoff
  return <ChatPage key={`${kbName}-${agentId}`} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab button
// ─────────────────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, icon, children }: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-4 py-2 text-sm transition-colors"
      style={{
        color: active ? 'var(--as-primary)' : 'var(--as-ink-80)',
        borderBottom: active ? '2px solid var(--as-primary)' : '2px solid transparent',
        fontWeight: active ? 600 : 400,
      }}
    >
      {icon}
      {children}
    </button>
  )
}
