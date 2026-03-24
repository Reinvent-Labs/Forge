import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

export const metadata: Metadata = {
  title: "Forge — Your AI CTO",
  description:
    "Forge is your AI CTO — monitoring your startup, fixing bugs, and shipping features around the clock so you can focus on what matters.",
  keywords: [
    "AI CTO",
    "startup automation",
    "autonomous agents",
    "developer tools",
    "bug fixing AI",
    "continuous deployment",
  ],
  authors: [{ name: "Forge" }],
  openGraph: {
    title: "Forge — Your AI CTO",
    description: "Ship faster. Sleep better. Forge handles the technical ops.",
    type: "website",
    siteName: "Forge",
  },
  twitter: {
    card: "summary_large_image",
    title: "Forge — Your AI CTO",
    description: "Ship faster. Sleep better. Forge handles the technical ops.",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} dark`}>
      <body className="bg-zinc-950 text-zinc-100 min-h-screen font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
