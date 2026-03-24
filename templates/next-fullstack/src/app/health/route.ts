/**
 * Health check endpoint.
 * Returns service status, version, and uptime.
 * Used by: load balancers, DevOps Agent for post-deploy checks, monitoring.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    version: process.env['npm_package_version'] ?? '0.1.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env['NODE_ENV'],
  })
}
