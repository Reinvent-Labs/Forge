import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { Providers } from "./providers"
import { Sidebar } from "@/components/layout/sidebar"
import { TopBar } from "@/components/layout/topbar"
import { ErrorBoundary } from "@/components/error-boundary"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

export const metadata: Metadata = {
  title: {
    default: "Forge — Your AI CTO",
    template: "%s | Forge",
  },
  description:
    "Forge is your AI CTO — monitoring your startup, fixing bugs, and shipping features while you sleep.",
  keywords: ["AI CTO", "startup automation", "developer tools", "Forge"],
  authors: [{ name: "Forge" }],
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
}

interface RootLayoutProps {
  children: React.ReactNode
}

/**
 * Root layout — wraps every page with providers, sidebar, and top bar.
 * suppressHydrationWarning is required for next-themes dark/light switching.
 */
export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="bg-zinc-950 text-zinc-50 min-h-screen">
        <Providers>
          <div className="flex h-screen overflow-hidden">
            {/* Sidebar — hidden on mobile, visible md+ */}
            <Sidebar />

            {/* Main content area */}
            <div className="flex flex-col flex-1 overflow-hidden">
              <TopBar />
              <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                <ErrorBoundary>
                  {children}
                </ErrorBoundary>
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  )
}
