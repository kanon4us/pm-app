import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { ExperimentsView } from '@/components/ExperimentsView'

export default async function ExperimentsPage() {
  const supabase = await getSupabaseServiceClient()

  const [{ data: developers }, { data: bundleVersions }] = await Promise.all([
    supabase.from('developer_experiments').select('*').order('created_at', { ascending: true }),
    supabase.from('bundle_versions').select('*').order('activated_at', { ascending: true }),
  ])

  return (
    <ExperimentsView
      developers={developers ?? []}
      bundleVersions={bundleVersions ?? []}
    />
  )
}
