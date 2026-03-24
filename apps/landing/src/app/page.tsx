import Link from "next/link"
import {
  Bot,
  Shield,
  Zap,
  GitPullRequest,
  BarChart3,
  Bell,
  CheckCircle,
  ArrowRight,
  Terminal,
  Clock,
  TrendingUp,
  Lock,
  Cpu,
  Code2,
  Menu,
} from "lucide-react"

// ─────────────────────────────────────────────────────────────────────────────
// Static data
// ─────────────────────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Bot,
    title: "Autonomous Bug Fixing",
    description:
      "Forge detects errors in production, traces the root cause, writes a fix, runs your tests, and opens a PR — all before you've had your morning coffee.",
    color: "text-green-400",
    bg: "bg-green-500/10",
    border: "border-green-500/20",
  },
  {
    icon: Code2,
    title: "Feature Building",
    description:
      "Describe what you want in plain English. Forge scopes it, writes the code, tests it, and asks for your approval before merging. Ship 3× faster.",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
  },
  {
    icon: Shield,
    title: "Security Monitoring",
    description:
      "Continuous CVE scanning, dependency audits, and secrets detection. Critical vulnerabilities are patched automatically within minutes of disclosure.",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/20",
  },
  {
    icon: TrendingUp,
    title: "Performance Tracking",
    description:
      "p50/p95/p99 latency, error rates, and uptime — surfaced in plain English. Forge auto-rolls back deployments that degrade production.",
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    border: "border-purple-500/20",
  },
  {
    icon: GitPullRequest,
    title: "Smart Deployments",
    description:
      "Staged rollouts from preview → staging → production with configurable promotion rules. Blocked time windows keep weekends sacred.",
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
  },
  {
    icon: BarChart3,
    title: "Technical Debt Management",
    description:
      "Weekly debt audits prioritised by business risk. Forge generates sprint proposals so your codebase stays healthy as you scale.",
    color: "text-pink-400",
    bg: "bg-pink-500/10",
    border: "border-pink-500/20",
  },
]

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Connect Your Repo",
    description:
      "Install the Forge GitHub App and point it at your project. Forge reads your codebase, understands your stack, and indexes every module.",
    icon: GitPullRequest,
  },
  {
    step: "02",
    title: "Set Your Autonomy Level",
    description:
      'Choose how hands-off you want to be. "Supervised" means Forge asks before every change. "Autonomous" means it ships low-risk fixes automatically.',
    icon: Cpu,
  },
  {
    step: "03",
    title: "Ship Faster, Sleep Better",
    description:
      "Approve changes from Slack, Telegram, or the dashboard. Get daily digests instead of PagerDuty alerts at 3am. Focus on the product.",
    icon: Bell,
  },
]

const STATS = [
  { value: "3×", label: "faster feature delivery" },
  { value: "87%", label: "of bugs fixed before users notice" },
  { value: "<10min", label: "mean time to fix production incidents" },
  { value: "99.9%", label: "average uptime across customers" },
]

const TESTIMONIALS = [
  {
    quote:
      "Forge fixed a login bug at 2am, opened a PR with tests, and deployed it to staging. I woke up to a Slack message saying it was done. This is the future.",
    name: "Sarah Chen",
    title: "Founder, Comet Analytics",
    initials: "SC",
    color: "bg-blue-500",
  },
  {
    quote:
      "We cut our sprint planning time in half. Forge handles all the maintenance work and surfaces exactly what the team should focus on next.",
    name: "Marcus Webb",
    title: "CTO, Flowline",
    initials: "MW",
    color: "bg-purple-500",
  },
  {
    quote:
      "My security score went from 62 to 94 in the first week. Forge patched 11 CVEs automatically and wrote the tests to prove nothing broke.",
    name: "Priya Kapoor",
    title: "Solo Founder, Stackr",
    initials: "PK",
    color: "bg-green-500",
  },
]

const PRICING = [
  {
    name: "Starter",
    price: "$49",
    period: "/month",
    description: "Perfect for solo founders and early-stage startups.",
    features: [
      "1 project",
      "Autonomous bug fixing",
      "Security scanning",
      "Slack notifications",
      "7-day log retention",
    ],
    cta: "Start free trial",
    highlight: false,
  },
  {
    name: "Growth",
    price: "$149",
    period: "/month",
    description: "For startups shipping fast and scaling their team.",
    features: [
      "5 projects",
      "Everything in Starter",
      "Feature building agent",
      "Debt management",
      "Telegram + email",
      "30-day log retention",
      "Priority support",
    ],
    cta: "Start free trial",
    highlight: true,
  },
  {
    name: "Scale",
    price: "$399",
    period: "/month",
    description: "For teams that need full autonomy and enterprise controls.",
    features: [
      "Unlimited projects",
      "Everything in Growth",
      "Fully autonomous mode",
      "Custom time windows",
      "SSO + RBAC",
      "90-day retention",
      "Dedicated Slack channel",
    ],
    cta: "Talk to us",
    highlight: false,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function NavBar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-green-500 flex items-center justify-center">
              <Zap className="h-4 w-4 text-zinc-950" />
            </div>
            <span className="text-lg font-bold text-zinc-100 tracking-tight">Forge</span>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">Features</a>
            <a href="#how-it-works" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">How it works</a>
            <a href="#pricing" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">Pricing</a>
            <a href="#testimonials" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">Customers</a>
          </div>

          {/* CTAs */}
          <div className="flex items-center gap-3">
            <Link
              href="http://localhost:3000"
              className="hidden sm:block text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="http://localhost:3000"
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-green-400 transition-colors"
            >
              Get started free
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </nav>
  )
}

function HeroSection() {
  return (
    <section className="relative pt-32 pb-20 overflow-hidden grid-bg grid-fade">
      {/* Background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-green-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-4 py-1.5 text-sm text-green-400 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
          Now in public beta — first 100 startups get 3 months free
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-zinc-100 mb-6 leading-[1.1]">
          Your AI CTO,
          <br />
          <span className="gradient-text">working 24/7</span>
        </h1>

        {/* Sub-headline */}
        <p className="text-lg sm:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Forge monitors your startup&apos;s codebase, fixes bugs automatically, ships features,
          and keeps your security score green — so you can focus on building the product.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <Link
            href="http://localhost:3000"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-green-500 px-8 py-3.5 text-base font-semibold text-zinc-950 hover:bg-green-400 transition-colors shadow-lg shadow-green-500/20"
          >
            Start for free
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="#how-it-works"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-8 py-3.5 text-base font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            See how it works
          </Link>
        </div>

        {/* Trust line */}
        <p className="text-sm text-zinc-600 mb-12">
          No credit card required &middot; 14-day free trial &middot; Cancel anytime
        </p>

        {/* Terminal mockup */}
        <div className="relative max-w-3xl mx-auto rounded-2xl border border-zinc-800 bg-zinc-900/60 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/50">
          {/* Terminal title bar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900">
            <div className="h-3 w-3 rounded-full bg-red-500/60" />
            <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
            <div className="h-3 w-3 rounded-full bg-green-500/60" />
            <span className="ml-3 text-xs text-zinc-500 font-mono">forge — monitoring</span>
          </div>
          {/* Terminal output */}
          <div className="p-5 font-mono text-sm text-left space-y-1.5 min-h-[220px]">
            <div className="text-zinc-500">▸ forge start --project acme-app</div>
            <div className="text-zinc-300">
              <span className="text-green-400">✓</span> Connected to acme-app (Vercel + PostgreSQL)
            </div>
            <div className="text-zinc-300">
              <span className="text-green-400">✓</span> Indexing 847 modules &middot; 94% test coverage mapped
            </div>
            <div className="text-zinc-500 mt-2">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
            <div className="text-red-400">⚠  Anomaly detected: error rate 4.2% (baseline 0.8%)</div>
            <div className="text-zinc-400">   Correlates with deploy a7b3c1d — 8 min ago</div>
            <div className="text-yellow-400">⟳  Tracing root cause in src/app/api/checkout/route.ts</div>
            <div className="text-zinc-400">   ↳ Unhandled null dereference on session.user.orgId</div>
            <div className="text-blue-400">⟳  Generating fix &middot; running 23 tests &middot; confidence: 91%</div>
            <div className="text-green-400">✓  PR #47 opened: &quot;fix: guard null session on checkout&quot;</div>
            <div className="text-green-400">✓  Deployed to staging — awaiting promotion approval</div>
            <div className="text-zinc-500">   Total time: <span className="text-zinc-300">4 minutes 12 seconds</span></div>
            <div className="text-zinc-600 terminal-cursor">&#8203;</div>
          </div>
        </div>
      </div>
    </section>
  )
}

function StatsBar() {
  return (
    <section className="border-y border-zinc-800 bg-zinc-900/40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-3xl sm:text-4xl font-bold text-green-400 tabular-nums mb-1">
                {stat.value}
              </div>
              <div className="text-sm text-zinc-400">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FeaturesSection() {
  return (
    <section id="features" className="py-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-400 mb-5">
            <Cpu className="h-3.5 w-3.5" />
            Powered by Claude claude-sonnet-4-6
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-zinc-100 mb-4 tracking-tight">
            Everything a CTO does,
            <br className="hidden sm:block" />
            <span className="gradient-text"> done autonomously</span>
          </h2>
          <p className="text-lg text-zinc-400 max-w-xl mx-auto">
            Forge runs 8 specialised AI agents around the clock. Each one handles a critical part of
            running a software startup.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className={`feature-card group rounded-2xl border ${feature.border} ${feature.bg} p-6 transition-all duration-200`}
            >
              <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${feature.bg} border ${feature.border} mb-4`}>
                <feature.icon className={`h-5 w-5 ${feature.color}`} />
              </div>
              <h3 className="text-base font-semibold text-zinc-100 mb-2">{feature.title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-24 bg-zinc-900/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100 mb-4 tracking-tight">
            Up and running in minutes
          </h2>
          <p className="text-lg text-zinc-400 max-w-lg mx-auto">
            Forge connects to your existing stack — no migrations, no new infrastructure.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
          {/* Connector line */}
          <div className="hidden md:block absolute top-10 left-1/3 right-1/3 h-px bg-gradient-to-r from-transparent via-green-500/40 to-transparent" />
          <div className="hidden md:block absolute top-10 left-2/3 right-0 h-px bg-gradient-to-r from-green-500/40 to-transparent" />

          {HOW_IT_WORKS.map((step, i) => (
            <div key={step.step} className="relative text-center">
              {/* Step number */}
              <div className="inline-flex h-20 w-20 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-900 mb-5 relative">
                <step.icon className="h-8 w-8 text-green-400" />
                <span className="absolute -top-2.5 -right-2.5 h-6 w-6 rounded-full bg-green-500 text-zinc-950 text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-zinc-100 mb-2">{step.title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed max-w-xs mx-auto">{step.description}</p>
            </div>
          ))}
        </div>

        {/* Supported integrations */}
        <div className="mt-16 text-center">
          <p className="text-sm text-zinc-500 mb-6">Works with your existing tools</p>
          <div className="flex flex-wrap items-center justify-center gap-6">
            {["GitHub", "Vercel", "Railway", "Fly.io", "Sentry", "PostHog", "Slack", "Telegram", "Stripe"].map((tool) => (
              <span key={tool} className="text-sm font-medium text-zinc-500 hover:text-zinc-300 transition-colors">
                {tool}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function ApprovalFlowSection() {
  return (
    <section className="py-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          {/* Text */}
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-400 mb-6">
              <Lock className="h-3.5 w-3.5" />
              You&apos;re always in control
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100 mb-5 tracking-tight">
              Approve changes from
              <br />
              <span className="gradient-text">wherever you are</span>
            </h2>
            <p className="text-zinc-400 leading-relaxed mb-8">
              Every non-trivial change comes with a plain-English summary: what Forge wants to do,
              why, what could go wrong, and a confidence score. One tap to approve or reject from
              Slack or Telegram.
            </p>
            <ul className="space-y-3">
              {[
                "Plain English — no technical jargon",
                "Risk score and confidence level on every PR",
                "One-click approve/reject from Slack or Telegram",
                "Automatic expiry prevents stale approvals",
                "Full audit trail for every decision",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2.5 text-sm text-zinc-300">
                  <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Approval card mockup */}
          <div className="relative">
            <div className="rounded-2xl border border-zinc-700 bg-zinc-900 overflow-hidden shadow-2xl shadow-black/50">
              {/* Slack-style header */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-800">
                <div className="h-8 w-8 rounded-lg bg-green-500/20 border border-green-500/30 flex items-center justify-center">
                  <Zap className="h-4 w-4 text-green-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-100">Forge</p>
                  <p className="text-xs text-zinc-500">Today at 3:47 AM</p>
                </div>
              </div>

              <div className="p-5 space-y-4">
                {/* Title */}
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400 mb-2">
                    HIGH RISK
                  </span>
                  <p className="text-sm font-semibold text-zinc-100">
                    Fix: Null reference crash in checkout flow
                  </p>
                </div>

                {/* Business impact */}
                <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-2">
                  <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide">Business Impact</p>
                  <p className="text-sm text-zinc-300">
                    This bug is causing checkout failures for 8% of users. Fixing it would
                    unblock approximately $1,200/day in lost conversions.
                  </p>
                </div>

                {/* Confidence bar */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-zinc-500">Confidence score</span>
                    <span className="text-xs font-bold text-green-400">91 / 100</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div className="h-full w-[91%] bg-green-500 rounded-full" />
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">CI passing &middot; Tests written &middot; Staging verified</p>
                </div>

                {/* Action buttons */}
                <div className="flex gap-3 pt-1">
                  <button className="flex-1 rounded-xl bg-green-500 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-green-400 transition-colors">
                    ✓ Approve &amp; Deploy
                  </button>
                  <button className="flex-1 rounded-xl border border-zinc-600 py-2.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                    ✕ Reject
                  </button>
                </div>

                <p className="text-xs text-center text-zinc-600">
                  Expires in 23h 14m &middot; <a href="#" className="text-zinc-500 hover:text-zinc-400">View PR #47</a>
                </p>
              </div>
            </div>

            {/* Floating badge */}
            <div className="absolute -top-3 -right-3 rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-400">
              Slack &amp; Telegram
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function TestimonialsSection() {
  return (
    <section id="testimonials" className="py-24 bg-zinc-900/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100 mb-4 tracking-tight">
            Loved by founders
          </h2>
          <p className="text-zinc-400">Trusted by startups from pre-seed to Series A.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {TESTIMONIALS.map((t) => (
            <div
              key={t.name}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 flex flex-col"
            >
              {/* Stars */}
              <div className="flex gap-0.5 mb-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <svg key={i} className="h-4 w-4 text-yellow-400 fill-current" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                ))}
              </div>

              <blockquote className="text-sm text-zinc-300 leading-relaxed flex-1 mb-5">
                &ldquo;{t.quote}&rdquo;
              </blockquote>

              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 rounded-full ${t.color} flex items-center justify-center text-xs font-bold text-white shrink-0`}>
                  {t.initials}
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-100">{t.name}</p>
                  <p className="text-xs text-zinc-500">{t.title}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function PricingSection() {
  return (
    <section id="pricing" className="py-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-zinc-100 mb-4 tracking-tight">
            Straightforward pricing
          </h2>
          <p className="text-zinc-400">
            All plans include a 14-day free trial. No credit card required.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {PRICING.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl p-7 flex flex-col ${
                plan.highlight
                  ? "border-2 border-green-500/50 bg-green-500/5 shadow-lg shadow-green-500/10"
                  : "border border-zinc-800 bg-zinc-900/60"
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-green-500 px-4 py-1 text-xs font-bold text-zinc-950">
                    MOST POPULAR
                  </span>
                </div>
              )}

              <div className="mb-5">
                <h3 className="text-base font-semibold text-zinc-100 mb-1">{plan.name}</h3>
                <p className="text-sm text-zinc-400 mb-4">{plan.description}</p>
                <div className="flex items-end gap-1">
                  <span className="text-4xl font-bold text-zinc-100 tabular-nums">{plan.price}</span>
                  <span className="text-zinc-500 mb-1 text-sm">{plan.period}</span>
                </div>
              </div>

              <ul className="space-y-2.5 mb-8 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2.5 text-sm text-zinc-300">
                    <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>

              <Link
                href="http://localhost:3000"
                className={`text-center rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                  plan.highlight
                    ? "bg-green-500 text-zinc-950 hover:bg-green-400"
                    : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="text-center text-sm text-zinc-500 mt-8">
          Need a custom plan for a larger team?{" "}
          <a href="mailto:hello@forge.dev" className="text-green-400 hover:text-green-300 transition-colors">
            Talk to us
          </a>
        </p>
      </div>
    </section>
  )
}

function CtaSection() {
  return (
    <section className="py-24 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[300px] bg-green-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-4 py-1.5 text-sm text-green-400 mb-8">
          <Clock className="h-3.5 w-3.5" />
          Your AI CTO is ready to start
        </div>

        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-zinc-100 mb-5 tracking-tight">
          Ship faster.
          <br />
          <span className="gradient-text">Sleep better.</span>
        </h2>

        <p className="text-lg text-zinc-400 mb-10 max-w-lg mx-auto">
          Join hundreds of founders who have handed off the technical ops so they can focus on what
          only they can do — building the product and talking to customers.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="http://localhost:3000"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-green-500 px-8 py-3.5 text-base font-semibold text-zinc-950 hover:bg-green-400 transition-colors shadow-lg shadow-green-500/20"
          >
            Start free trial
            <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-sm text-zinc-500">No credit card &middot; 14-day trial &middot; Cancel anytime</p>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-zinc-800 bg-zinc-950">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-7 w-7 rounded-lg bg-green-500 flex items-center justify-center">
                <Zap className="h-4 w-4 text-zinc-950" />
              </div>
              <span className="text-base font-bold text-zinc-100">Forge</span>
            </div>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Your AI CTO — working around the clock so you can sleep soundly.
            </p>
          </div>

          {/* Links */}
          <div>
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Product</h4>
            <ul className="space-y-2">
              {["Features", "How it works", "Pricing", "Changelog"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Developers</h4>
            <ul className="space-y-2">
              {["Documentation", "API Reference", "GitHub", "Status"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Company</h4>
            <ul className="space-y-2">
              {["About", "Blog", "Careers", "Contact"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-8 border-t border-zinc-800">
          <p className="text-xs text-zinc-600">
            &copy; {year} Forge Technologies, Inc. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            {["Privacy", "Terms", "Security"].map((item) => (
              <a key={item} href="#" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
                {item}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-zinc-950">
      <NavBar />
      <HeroSection />
      <StatsBar />
      <FeaturesSection />
      <HowItWorksSection />
      <ApprovalFlowSection />
      <TestimonialsSection />
      <PricingSection />
      <CtaSection />
      <Footer />
    </div>
  )
}
