"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { SessionProvider } from "next-auth/react"
import { useState } from "react"

interface ProvidersProps {
  children: React.ReactNode
}

/**
 * Providers wraps the app with all required context providers.
 * Kept client-side to avoid SSR issues with QueryClient.
 *
 * Provider order (inner to outer):
 *   ThemeProvider → QueryClientProvider → SessionProvider
 *
 * SessionProvider must be near the root so useSession() is available
 * in any client component (including the TopBar sign-out button).
 */
export function Providers({ children }: ProvidersProps) {
  // Create QueryClient per session to avoid shared state between users
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000, // 30 seconds — metrics change frequently
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      })
  )

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    </SessionProvider>
  )
}
