import { NextRequest, NextResponse } from 'next/server'
import { getFeature, updateFeature } from '@/lib/features/client'
import { getFeatureStories } from '@/lib/user-stories/client'
import { getStoryScenarios, getScenarioSteps } from '@/lib/scenarios/client'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    return { ...story, scenarios: scenariosWithSteps }
  }))
  return NextResponse.json({ ...feature, stories: storiesWithScenarios })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const feature = await updateFeature(id, body)
  return NextResponse.json(feature)
}
