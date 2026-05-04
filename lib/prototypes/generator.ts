// lib/prototypes/generator.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const GENERATION_SYSTEM = `You are a prototype HTML generator. You receive a feature context describing user stories, scenarios, and steps — each step has a title, narration text, and an image URL.

Generate a complete, self-contained HTML slideshow prototype. Requirements:
- One slide per step
- Each slide shows: step title, narration text, and the step image via <img src="[image url]">
- A "View in Figma" anchor using the figma URL for that step (open in new tab)
- Previous / Next navigation buttons
- Scenario title and "Step X of Y" counter in the header
- Hotspot detection: if a step's description mentions navigating to another step (e.g. "Clicking Save goes to step 3", "Tapping X proceeds to the confirmation"), wrap that text in a <button> with onclick="goToSlide(N-1)" where N is the target step number
- Dark-mode aware styling using CSS prefers-color-scheme
- All CSS and JavaScript must be inline — no external dependencies, no CDN links
- The output must be a complete working HTML document

Output ONLY the HTML. No explanation, no markdown fences.`

export async function generatePrototypeHtml(
  featureContext: string,
  scenarioTitle: string
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: GENERATION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Generate the prototype for scenario "${scenarioTitle}".\n\n${featureContext}`,
      },
    ],
  })

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text' || !block.text) throw new Error('Claude returned no HTML')
  return block.text.trim()
}
