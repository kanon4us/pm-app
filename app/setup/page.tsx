import { SetupView } from '@/components/SetupView'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export default async function SetupPage() {
  const session = await auth()
  const supabase = await getSupabaseServiceClient()

  const connectedProviders: string[] = []
  if (session?.user?.email) {
    const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
    if (user) {
      const { data: tokens } = await supabase.from('oauth_tokens').select('provider').eq('user_id', user.id)
      tokens?.forEach((t) => connectedProviders.push(t.provider))
    }
  }

  const connections = [
    { provider: 'clickup', label: 'ClickUp', connected: connectedProviders.includes('clickup'), oauth: true },
    { provider: 'github', label: 'GitHub', connected: connectedProviders.includes('github'), oauth: true },
    { provider: 'figma', label: 'Figma', connected: !!process.env.FIGMA_ACCESS_TOKEN, oauth: false },
    { provider: 'webflow', label: 'Webflow', connected: !!process.env.WEBFLOW_API_TOKEN, oauth: false },
  ]

  return (
    <SetupView
      connections={connections}
      showListSelector={connectedProviders.includes('clickup')}
    />
  )
}
