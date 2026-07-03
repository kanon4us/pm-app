import { NextRequest, NextResponse } from 'next/server'
import { getFeature, updateFeature } from '@/lib/features/client'
import { getFeatureStories, getStoryFeatureCount } from '@/lib/user-stories/client'
import { getStoryScenarios, getScenarioSteps } from '@/lib/scenarios/client'
import { getSessionUser } from '@/lib/auth'
import { APP_SLUGS } from '@/lib/claude/apps'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const feature = await getFeature(id)
  if (!feature) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const stories = await getFeatureStories(id)
  const storiesWithScenarios = await Promise.all(stories.map(async (story) => {
    const scenarios = await getStoryScenarios(story.id)
    const scenariosWithSteps = await Promise.all(scenarios.map(async (scenario) => ({
      ...scenario,
      steps: await getScenarioSteps(scenario.id),
    })))
    const featureCount = await getStoryFeatureCount(story.id)
    return { ...story, featureCount, scenarios: scenariosWithSteps }
  }))
  return NextResponse.json({ ...feature, stories: storiesWithScenarios })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json()
  const { status, name, description, planning_phase, app } = body
  if (planning_phase !== undefined && !['planning', 'approved', 'prototyping'].includes(planning_phase)) {
    return NextResponse.json({ error: 'invalid planning_phase' }, { status: 400 })
  }
  if (app !== undefined && !(APP_SLUGS as string[]).includes(app)) {
    return NextResponse.json({ error: 'invalid app' }, { status: 400 })
  }
  const feature = await updateFeature(id, {
    ...(status !== undefined && { status }),
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(planning_phase !== undefined && { planning_phase }),
    ...(app !== undefined && { app }),
  })
  return NextResponse.json(feature)
}
