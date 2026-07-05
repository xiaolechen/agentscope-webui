import { useQuery } from '@tanstack/react-query'
import { tenantsApi, type UserResources } from '@/api/tenants'
import { useAuthStore } from '@/store/auth'

/**
 * Effective resource scope in the caller's active tenant.
 *
 *  - platform admin (role === 'admin') → unrestricted (sees everything)
 *  - tenant_admin → the tenant's full assigned_* pool
 *  - regular user → the per-user assigned subset
 *
 * Source: `GET /webui/tenants/my-resources`, which the backend resolves per
 * role (admin/tenant_admin → tenant pool; member → per-user subset). The
 * platform tenant has no assigned pool, so admins skip the fetch entirely.
 *
 * While the scope is loading for a non-admin, `allows*` return true (brief
 * unrestricted flash) rather than hiding everything — once the query resolves
 * the list re-renders filtered. Use `scopeLoaded` if you need to gate on
 * resolution instead.
 *
 * Legacy fallback: a non-admin with no tenant (no my-resources) falls back to
 * `boundAgentIds` for agents, matching the AgentPicker behavior.
 */
export function useScopedResources() {
  const role = useAuthStore(s => s.role)
  const boundAgentIds = useAuthStore(s => s.boundAgentIds)
  const tenantId = useAuthStore(s => s.tenantId)

  const unrestricted = role === 'admin' || !tenantId
  const { data: myResources, isFetched } = useQuery({
    queryKey: ['my-resources'],
    queryFn: tenantsApi.getMyResources,
    enabled: !unrestricted,
  })

  // null = unrestricted (admin, no tenant, or my-resources not yet loaded).
  const scope: UserResources | null = unrestricted ? null : (myResources ?? null)

  const allowsAgent = (id: string) => {
    if (!scope) {
      // Legacy non-admin fallback: boundAgentIds (empty → unrestricted).
      return boundAgentIds.length ? boundAgentIds.includes(id) : true
    }
    return scope.agents.includes(id)
  }
  const allowsMcp = (name: string) => !scope || scope.mcps.includes(name)
  const allowsSkill = (path: string) => !scope || scope.skills.includes(path)

  return { scope, scopeLoaded: unrestricted || isFetched, allowsAgent, allowsMcp, allowsSkill }
}
