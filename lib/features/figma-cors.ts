// lib/features/figma-cors.ts
// CORS for the two Figma-plugin routes (figma-layout, figma-file). The plugin
// fetches them from its sandbox, which enforces CORS: without an
// Access-Control-Allow-Origin on the response the sandbox rejects the fetch
// before the plugin can read it — surfacing as a bare "Could not fetch layout".
// These routes are token-gated (FIGMA_PLUGIN_TOKEN bearer) and use no cookies,
// so a wildcard origin is safe (no credentialed requests to protect).
import { NextResponse } from 'next/server'

export const FIGMA_PLUGIN_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

/** Preflight response: 204 with the CORS headers so the sandbox sends the real request. */
export function figmaPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: FIGMA_PLUGIN_CORS })
}

/** NextResponse.json with the CORS headers merged in — use for EVERY response
 * (success and error alike), since the sandbox must read error bodies too. */
export function figmaJson(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: FIGMA_PLUGIN_CORS })
}
