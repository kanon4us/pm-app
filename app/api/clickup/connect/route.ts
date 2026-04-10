import { NextResponse } from 'next/server'

export function GET() {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID!,
    redirect_uri: `${process.env.NEXTAUTH_URL}/api/clickup/callback`,
  })
  return NextResponse.redirect(
    `https://app.clickup.com/api?${params}`
  )
}
