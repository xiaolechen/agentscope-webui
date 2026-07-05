import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/store/auth'
import LangSwitcher from '@/components/LangSwitcher'

const schema = z.object({
  username: z.string().min(1, 'REQUIRED'),
  password: z.string().min(1, 'REQUIRED'),
})
type Fields = z.infer<typeof schema>

export default function LoginPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const setAuth = useAuthStore(s => s.setAuth)
  const setBoundAgents = useAuthStore(s => s.setBoundAgents)
  const setTenant = useAuthStore(s => s.setTenant)
  const setMemberships = useAuthStore(s => s.setMemberships)
  const [error, setError] = useState('')

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Fields>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async ({ username, password }: Fields) => {
    try {
      setError('')
      const res = await authApi.login(username, password)
      setAuth({ token: res.access_token, role: res.role, userId: res.user_id, username })
      const me = await authApi.me()
      setBoundAgents(me.bound_agent_ids)
      setTenant(me.active_tenant_id ?? me.tenant_id, me.menu_permissions as any)
      setMemberships(me.memberships)
      navigate('/chat')
    } catch {
      setError(t('login.error.invalidCredentials'))
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--as-parchment)' }}>
      <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
        <LangSwitcher />
      </div>
      <div style={{
        background: 'var(--as-canvas)',
        borderRadius: 'var(--as-r-lg)',
        boxShadow: '0 4px 32px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05)',
        padding: '40px',
        width: '100%',
        maxWidth: '360px',
      }}>
        <h1 className="as-heading-lg" style={{ marginBottom: '4px' }}>{t('brand.name')}</h1>
        <p className="as-caption" style={{ marginBottom: '28px' }}>{t('login.subtitle')}</p>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label className="as-caption" style={{ display: 'block', fontWeight: 500, color: 'var(--as-ink-80)', marginBottom: '6px' }}>
              {t('login.username')}
            </label>
            <input {...register('username')} className="as-input" placeholder={t('login.usernamePlaceholder')} autoComplete="username" />
            {errors.username && <p className="as-micro" style={{ color: '#ef4444', marginTop: '4px' }}>{t('common.validation.required')}</p>}
          </div>

          <div>
            <label className="as-caption" style={{ display: 'block', fontWeight: 500, color: 'var(--as-ink-80)', marginBottom: '6px' }}>
              {t('login.password')}
            </label>
            <input {...register('password')} type="password" className="as-input" autoComplete="current-password" />
            {errors.password && <p className="as-micro" style={{ color: '#ef4444', marginTop: '4px' }}>{t('common.validation.required')}</p>}
          </div>

          {error && <p className="as-caption" style={{ color: '#ef4444' }}>{error}</p>}

          <button type="submit" disabled={isSubmitting} className="as-btn as-btn-primary" style={{ marginTop: '4px', padding: '11px 22px', fontSize: '15px' }}>
            {isSubmitting ? t('login.button.signingIn') : t('login.button.signIn')}
          </button>
        </form>
      </div>
    </div>
  )
}
