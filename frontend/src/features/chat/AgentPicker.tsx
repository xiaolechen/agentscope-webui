import { useQuery } from '@tanstack/react-query'
import { agentsApi, AgentRecord } from '@/api/agents'
import { useAuthStore } from '@/store/auth'
import { useTranslation } from 'react-i18next'

interface Props {
  value: string | null
  onChange: (id: string) => void
}

export default function AgentPicker({ value, onChange }: Props) {
  const role = useAuthStore(s => s.role)
  const boundAgentIds = useAuthStore(s => s.boundAgentIds)
  const { t } = useTranslation()
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })

  const visible: AgentRecord[] = role === 'admin'
    ? agents
    : agents.filter(a => boundAgentIds.includes(a.id))

  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      className="text-sm rounded-[var(--as-r-sm)] px-2 py-1.5 bg-white outline-none transition-colors"
      style={{ border: '1px solid var(--as-hairline)' }}
    >
      <option value="">{t('chat.placeholder.selectAgentOption')}</option>
      {visible.map(a => (
        <option key={a.id} value={a.id}>{a.data.name}</option>
      ))}
    </select>
  )
}
