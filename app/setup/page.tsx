import { Layout, Typography } from 'antd'
import { OAuthConnections } from '@/components/OAuthConnections'
import { ListSelector } from '@/components/ListSelector'
import { auth } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export default async function SetupPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  const connectedProviders: string[] = []
  if (session?.user?.email) {
    const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
    if (user) {
      const { data: tokens } = await supabase.from('oauth_tokens').select('provider').eq('user_id', user.id)
      tokens?.forEach((t) => connectedProviders.push(t.provider))
    }
  }

  const connections = [
    { provider: 'clickup', label: 'ClickUp', connected: connectedProviders.includes('clickup') },
    { provider: 'github', label: 'GitHub', connected: connectedProviders.includes('github') },
    { provider: 'figma', label: 'Figma', connected: connectedProviders.includes('figma') },
    { provider: 'webflow', label: 'Webflow', connected: connectedProviders.includes('webflow') },
  ]

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px', maxWidth: 640 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Setup</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Connect your tools and select ClickUp lists to monitor
      </Typography.Text>
      <OAuthConnections connections={connections} />
      {connectedProviders.includes('clickup') && <ListSelector />}
    </Layout>
  )
}
