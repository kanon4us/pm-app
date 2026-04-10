import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'

// GET /api/lists?spaceId=xxx — returns all lists in a space (including folder lists)
export async function GET(request: NextRequest) {
  const spaceId = request.nextUrl.searchParams.get('spaceId')
  if (!spaceId) return NextResponse.json({ error: 'spaceId is required' }, { status: 400 })

  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)

  // Fetch lists directly in the space and lists inside folders in parallel
  const [spaceLists, folders] = await Promise.all([
    client.getLists(spaceId),
    client.getFolders(spaceId),
  ])

  const folderListArrays = await Promise.all(folders.map((f) => client.getFolderLists(f.id)))
  const folderLists = folderListArrays.flat()

  const lists = [
    ...spaceLists.map((l) => ({ id: l.id, name: l.name, folder: null })),
    ...folderLists.map((l) => ({ id: l.id, name: l.name, folder: l.folder?.name ?? null })),
  ]

  return NextResponse.json({ lists })
}
