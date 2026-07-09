import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DESIGN.md contracts are read from disk at runtime by lib/claude/design-md.ts;
  // include them in the traced output so the Vercel function can see them.
  outputFileTracingIncludes: {
    "/api/features/[id]/conversation/message": ["./design/DESIGN-*.md"],
    "/api/features/[id]/figma-layout": ["./design/figma-antd-catalog.json"],
  },
};

export default nextConfig;
