// app/features/[id]/page.tsx
'use client'
import { useEffect, useState } from 'react'
import { Layout, Typography, Spin, Select, Button, Segmented } from 'antd'
import { useParams, useRouter } from 'next/navigation'
import { UserStoriesPanel } from './components/UserStoriesPanel'
import { ScenariosPanel } from './components/ScenariosPanel'
import { ClaudePanel } from './components/ClaudePanel'
import { PrototypePanel } from './components/PrototypePanel'

const { Header, Sider, Content } = Layout

export interface Step {
  id: string; scenario_id: string; title: string; description: string | null
  figma_url: string | null; figma_frame_id: string | null; figma_thumbnail_url: string | null; display_order: number
}
export interface Scenario { id: string; user_story_id: string; title: string; description: string | null; display_order: number; steps: Step[] }
export interface UserStory { id: string; title: string; as_a: string; i_want: string; so_that: string; scenarios: Scenario[]; featureCount: number }
export interface Feature {
  id: string; name: string; description: string | null; status: string
  planning_phase: 'planning' | 'approved' | 'prototyping'; spec_content: string | null
  app: 'web' | 'cms' | 'mobile' | 'desktop'
  stories: UserStory[]
}

export default function FeatureEditorPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [feature, setFeature] = useState<Feature | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeStoryId, setActiveStoryId] = useState<string | null>(null)
  const [centerView, setCenterView] = useState<'Scenarios' | 'Prototype'>('Scenarios')
  const [protoRefreshKey, setProtoRefreshKey] = useState(0)
  const [hasPrototype, setHasPrototype] = useState(false)

  useEffect(() => {
    fetch(`/api/features/${id}/prototype?meta=1`)
      .then((res) => setHasPrototype(res.ok))
      .catch(() => { /* keep existing state on error */ })
  }, [id, protoRefreshKey])

  async function reload() {
    try {
      const res = await fetch(`/api/features/${id}`)
      if (!res.ok) throw new Error('Failed to load feature')
      const data: Feature = await res.json()
      setFeature(data)
      if (!activeStoryId && data.stories.length > 0) setActiveStoryId(data.stories[0].id)
    } catch {
      // keep existing state on error
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [id])

  if (loading) return <div style={{ padding: 32 }}><Spin size="large" /></div>
  if (!feature) return <div style={{ padding: 32 }}>Feature not found.</div>

  const activeStory = feature.stories.find((s) => s.id === activeStoryId) ?? null

  async function patchFeature(patch: Record<string, string>) {
    await fetch(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify(patch), headers: { 'Content-Type': 'application/json' } })
    reload()
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <Header style={{ background: '#141414', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px' }}>
        <Button type="text" onClick={() => router.back()}>← Back</Button>
        <Typography.Title level={5} style={{ margin: 0, color: '#fff' }}>{feature.name}</Typography.Title>
        <Select value={feature.app} onChange={(app) => patchFeature({ app })} style={{ marginLeft: 'auto', minWidth: 130 }} size="small"
          options={[
            { value: 'web', label: '🌐 Web App' },
            { value: 'cms', label: '📚 Education CMS' },
            { value: 'mobile', label: '📱 Mobile' },
            { value: 'desktop', label: '🖥 Desktop' },
          ]} />
        <Select value={feature.status} onChange={(status) => patchFeature({ status })} size="small"
          options={[{ value: 'draft', label: 'draft' }, { value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} />
      </Header>
      <Layout>
        <Sider width={240} style={{ background: '#1a1a1a', borderRight: '1px solid #333', overflow: 'auto' }}>
          <UserStoriesPanel featureId={id} stories={feature.stories} activeStoryId={activeStoryId} onSelect={setActiveStoryId} onUpdate={reload} />
        </Sider>
        <Content style={{ background: '#141414', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '8px 20px', borderBottom: '1px solid #262626' }}>
            <Segmented options={['Scenarios', 'Prototype']} value={centerView} onChange={(v) => setCenterView(v as 'Scenarios' | 'Prototype')} />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {centerView === 'Scenarios' ? (
              <ScenariosPanel
                featureId={id}
                featureName={feature.name}
                story={activeStory}
                onUpdate={reload}
                hasPrototype={hasPrototype}
                onViewPrototype={() => setCenterView('Prototype')}
              />
            ) : (
              <PrototypePanel featureId={id} refreshKey={protoRefreshKey} />
            )}
          </div>
        </Content>
        <Sider width={440} style={{ background: '#1a1a1a', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
          <ClaudePanel
            featureId={id}
            planningPhase={feature.planning_phase}
            specContent={feature.spec_content}
            onApplied={reload}
            onPrototypeUpdated={() => {
              setProtoRefreshKey((k) => k + 1)
              setCenterView('Prototype')
            }}
          />
        </Sider>
      </Layout>
    </Layout>
  )
}
