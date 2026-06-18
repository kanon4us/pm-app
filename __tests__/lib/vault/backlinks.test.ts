import { buildBacklinkMap, inboundCount } from '@/lib/vault/backlinks'

const FILES = {
  '02_Glossary/Element.md': 'An [[Project|project]] has Elements.',
  'Manual/Making a Creative.md': 'See [[02_Glossary/Element]] and [[Project]].',
  '01_Inbox/Orphan.md': 'Nothing links to me.',
  '02_Glossary/Project.md': 'A project.',
}

describe('buildBacklinkMap', () => {
  const map = buildBacklinkMap(FILES)
  it('resolves a full-path wikilink to its target', () => {
    expect(inboundCount(map, '02_Glossary/Element.md')).toBe(1)
  })
  it('resolves a bare-name wikilink by basename', () => {
    expect(inboundCount(map, '02_Glossary/Project.md')).toBe(2) // Element.md + Manual
  })
  it('reports zero for an orphan', () => {
    expect(inboundCount(map, '01_Inbox/Orphan.md')).toBe(0)
  })
})
