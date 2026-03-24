/**
 * Database seed script for local development.
 *
 * Creates:
 * - A demo organization (Acme Startup)
 * - A demo user (founder@acme.dev)
 * - A demo project (Acme App)
 * - Sample debt items, incidents, and metrics
 *
 * Run: npm run db:seed (from packages/database/)
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  console.log('🌱 Seeding database...')

  // ---------------------------------------------------------------------------
  // Organization
  // ---------------------------------------------------------------------------

  const org = await prisma.organization.upsert({
    where: { slug: 'acme-startup' },
    update: {},
    create: {
      name: 'Acme Startup',
      slug: 'acme-startup',
      planTier: 'GROWTH',
      encKey: 'a'.repeat(64), // Placeholder — use generateKey() in production
    },
  })

  console.log('✓ Organization:', org.name)

  // ---------------------------------------------------------------------------
  // User
  // ---------------------------------------------------------------------------

  // bcrypt hash of "password" — for dev login only, never use in production
  const devPasswordHash = '$2a$10$ZTutkzs79.wX1K0wBJCfXe9tYMhdPfb47Lx/JeyPvs28CQzFLGi6a'

  const user = await prisma.user.upsert({
    where: { email: 'founder@acme.dev' },
    update: { passwordHash: devPasswordHash },
    create: {
      email: 'founder@acme.dev',
      name: 'Alex Founder',
      passwordHash: devPasswordHash,
      emailVerified: true,
    },
  })

  console.log('✓ User:', user.email)

  // OrgMember
  await prisma.orgMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: {},
    create: {
      organizationId: org.id,
      userId: user.id,
      role: 'OWNER',
    },
  })

  // ---------------------------------------------------------------------------
  // Project
  // ---------------------------------------------------------------------------

  const project = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: 'acme-app' } },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Acme App',
      slug: 'acme-app',
      description: 'A SaaS platform for project management built on Next.js + PostgreSQL',
      status: 'ACTIVE',
      startupStage: 'MVP',
      autonomyLevel: 'SEMI',
      productionUrl: 'https://app.acme.dev',
      stagingUrl: 'https://staging.acme.dev',
      hostingProvider: 'vercel',
      defaultBranch: 'main',
    },
  })

  console.log('✓ Project:', project.name)

  // ---------------------------------------------------------------------------
  // Codebase context
  // ---------------------------------------------------------------------------

  const ctx = await prisma.codebaseContext.upsert({
    where: { id: project.id },
    update: {},
    create: {
      projectId: project.id,
      techStack: {
        language: 'TypeScript',
        framework: 'Next.js 14',
        database: 'PostgreSQL',
        hosting: 'Vercel',
        testFramework: 'Jest',
        packageManager: 'npm',
      },
      teamMembers: [
        { name: 'Alex Founder', role: 'Founder', githubHandle: 'alexfounder' },
      ],
    },
  })

  // Module nodes
  const modules = [
    { path: 'src/app/page.tsx', description: 'Marketing home page with hero, features, and CTA', complexity: 2 },
    { path: 'src/app/dashboard/page.tsx', description: 'Main dashboard showing project metrics and recent activity', complexity: 5 },
    { path: 'src/app/api/auth/route.ts', description: 'Authentication API endpoint — handles login, signup, and token refresh', complexity: 8 },
    { path: 'src/lib/db.ts', description: 'Database client singleton and helper utilities', complexity: 3 },
    { path: 'src/components/ui/button.tsx', description: 'Reusable button component with multiple variants', complexity: 1 },
  ]

  for (const mod of modules) {
    await prisma.moduleNode.upsert({
      where: { contextId_path: { contextId: ctx.id, path: mod.path } },
      update: {},
      create: {
        contextId: ctx.id,
        path: mod.path,
        plainEnglishDescription: mod.description,
        lastModified: new Date(),
        lastModifiedBy: 'forge-agent',
        testCoverage: 70 + Math.random() * 30,
        complexityScore: mod.complexity,
      },
    })
  }

  console.log('✓ Codebase context with', modules.length, 'modules')

  // ---------------------------------------------------------------------------
  // Sample incidents
  // ---------------------------------------------------------------------------

  const incidents = [
    {
      title: 'Login page returning 500 errors for 8% of users',
      description: 'OAuth token validation failing intermittently due to a race condition in the session refresh logic',
      severity: 'HIGH' as const,
      status: 'RESOLVED' as const,
      affectedModules: ['src/app/api/auth/route.ts'],
      affectedUsers: 47,
    },
    {
      title: 'Database connection pool exhausted during peak traffic',
      description: 'Connection pool size too small for current traffic. Queries timing out.',
      severity: 'CRITICAL' as const,
      status: 'RESOLVED' as const,
      affectedModules: ['src/lib/db.ts'],
      affectedUsers: 312,
    },
  ]

  for (const incident of incidents) {
    await prisma.incident.create({
      data: {
        projectId: project.id,
        ...incident,
        detectedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
        resolvedAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
      },
    }).catch(() => {/* ignore duplicate */})
  }

  console.log('✓ Sample incidents')

  // ---------------------------------------------------------------------------
  // Technical debt items
  // ---------------------------------------------------------------------------

  const debtItems = [
    {
      type: 'MISSING_TESTS' as const,
      severity: 'HIGH' as const,
      filePath: 'src/app/api/auth/route.ts',
      plainEnglishDescription: 'The login and signup code has no automated tests, making it risky to change',
      technicalDescription: 'Auth route handlers lack unit and integration tests. Coverage at 0%.',
      estimatedHours: 8,
      businessRisk: 'Any change to auth could break login for all users with no safety net',
    },
    {
      type: 'CODE_QUALITY' as const,
      severity: 'MEDIUM' as const,
      filePath: 'src/lib/db.ts',
      plainEnglishDescription: 'Database error handling is inconsistent — some errors are swallowed silently',
      technicalDescription: 'Several catch blocks call console.error but don\'t re-throw or handle the error properly',
      estimatedHours: 4,
      businessRisk: 'Silent failures make it hard to debug production issues',
    },
    {
      type: 'DEPENDENCY' as const,
      severity: 'LOW' as const,
      filePath: 'package.json',
      plainEnglishDescription: '3 dependencies are 2+ major versions behind the latest',
      technicalDescription: 'next (14 vs 15), prisma (5 vs 6), tailwindcss (3 vs 4)',
      estimatedHours: 6,
      businessRisk: 'Older versions may have unpatched security vulnerabilities',
    },
  ]

  for (const item of debtItems) {
    await prisma.debtItem.create({
      data: { projectId: project.id, ...item },
    }).catch(() => {/* ignore */})
  }

  console.log('✓ Technical debt items')

  // ---------------------------------------------------------------------------
  // Metrics snapshots (last 30 days)
  // ---------------------------------------------------------------------------

  for (let i = 30; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    await prisma.projectMetricsSnapshot.create({
      data: {
        projectId: project.id,
        capturedAt: date,
        activeUsers: Math.round(100 + Math.random() * 50 + i * -0.5),
        newSignups: Math.round(5 + Math.random() * 10),
        revenue: 1200 + Math.random() * 200,
        errorRate: Math.random() * 0.5,
        p50Latency: 80 + Math.random() * 40,
        p95Latency: 150 + Math.random() * 100,
        p99Latency: 300 + Math.random() * 200,
        uptimePercent: 99.5 + Math.random() * 0.5,
        testCoverage: 65 + Math.random() * 15,
        securityScore: 85 + Math.random() * 10,
        debtScore: 70 + Math.random() * 15,
        openPrs: Math.round(Math.random() * 5),
      },
    })
  }

  console.log('✓ 30 days of metrics snapshots')

  // ---------------------------------------------------------------------------
  // Sample deployment
  // ---------------------------------------------------------------------------

  await prisma.deployment.create({
    data: {
      projectId: project.id,
      environment: 'PRODUCTION',
      status: 'SUCCEEDED',
      provider: 'vercel',
      commitSha: 'a1b2c3d',
      commitMessage: 'feat: add user onboarding flow',
      branch: 'main',
      triggeredBy: 'forge-agent',
      url: 'https://app.acme.dev',
      startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 120000),
      durationMs: 120000,
    },
  }).catch(() => {/* ignore */})

  console.log('✓ Sample deployment')

  console.log('\n🎉 Seed complete!')
  console.log('   Organization:', org.slug)
  console.log('   Login with:  founder@acme.dev')
  console.log('   Project ID:  ', project.id)
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
