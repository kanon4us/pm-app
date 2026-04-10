import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

// These will fail to compile if the types are missing or wrong
type _DevRow    = Tables<'developer_experiments'>
type _DevInsert = InsertDto<'developer_experiments'>
type _DevUpdate = UpdateDto<'developer_experiments'>
type _BvRow     = Tables<'bundle_versions'>
type _BvInsert  = InsertDto<'bundle_versions'>
type _BvUpdate  = UpdateDto<'bundle_versions'>

describe('VIDF experiment types', () => {
  it('developer_experiments row has required fields', () => {
    const row: Tables<'developer_experiments'> = {
      id: 'uuid',
      github_email: 'dev@example.com',
      github_username: null,
      vidf_tag: 'pre',
      bundle_version: 'v0',
      sop_version: 'v0',
      sprint: '2026-04',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    expect(row.github_email).toBe('dev@example.com')
  })

  it('bundle_versions row has required fields', () => {
    const row: Tables<'bundle_versions'> = {
      id: 'uuid',
      version: 'v0',
      description: 'Pre-VIDF baseline',
      files: [],
      claude_context: null,
      is_active: true,
      activated_at: new Date().toISOString(),
      deactivated_at: null,
      created_at: new Date().toISOString(),
    }
    expect(row.version).toBe('v0')
  })
})
