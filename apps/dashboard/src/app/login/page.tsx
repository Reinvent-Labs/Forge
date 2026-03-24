"use client"

/**
 * Login page — standalone, no sidebar/topbar.
 * Dark zinc-950 theme with green-500 accent buttons.
 *
 * Uses NextAuth signIn('credentials') with a Zod-validated form.
 * On failure, NextAuth returns an error query param which we surface
 * to the user as an inline error message.
 */

import { useState, useTransition } from "react"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Please enter a valid email address"),
  password: z
    .string()
    .min(1, "Password is required")
    .min(6, "Password must be at least 6 characters"),
})

type LoginFormData = z.infer<typeof loginSchema>
type FieldErrors = Partial<Record<keyof LoginFormData, string>>

// ---------------------------------------------------------------------------
// Forge wordmark logo component
// ---------------------------------------------------------------------------

function ForgeLogo() {
  return (
    <div className="flex flex-col items-center gap-3 mb-8">
      {/* Icon mark */}
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center"
        style={{ backgroundColor: "#22c55e" }}
        aria-hidden="true"
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Stylised anvil/lightning bolt representing Forge */}
          <path
            d="M14 3L4 10.5L9 13L6 25L14 18L22 25L19 13L24 10.5L14 3Z"
            fill="white"
            fillOpacity="0.95"
          />
        </svg>
      </div>

      {/* Wordmark */}
      <div className="text-center">
        <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">
          Forge
        </h1>
        <p className="text-sm text-zinc-400 mt-0.5">Your AI CTO</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main login page component
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // NextAuth passes error codes as a query param after a failed sign-in
  const authError = searchParams.get("error")

  const [formData, setFormData] = useState<LoginFormData>({
    email: "",
    password: "",
  })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [serverError, setServerError] = useState<string | null>(
    authError ? resolveAuthError(authError) : null
  )
  const [isPending, startTransition] = useTransition()

  // Map NextAuth error codes to human-friendly messages
  function resolveAuthError(code: string): string {
    switch (code) {
      case "CredentialsSignin":
        return "Invalid email or password. Please try again."
      case "SessionRequired":
        return "Please sign in to continue."
      default:
        return "Something went wrong. Please try again."
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
    // Clear field error on change so the UI feels responsive
    if (fieldErrors[name as keyof LoginFormData]) {
      setFieldErrors((prev) => ({ ...prev, [name]: undefined }))
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setServerError(null)

    // Client-side validation via Zod
    const result = loginSchema.safeParse(formData)
    if (!result.success) {
      const errors: FieldErrors = {}
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof LoginFormData
        errors[field] = issue.message
      }
      setFieldErrors(errors)
      return
    }

    startTransition(async () => {
      const response = await signIn("credentials", {
        email: formData.email,
        password: formData.password,
        // Prevent NextAuth from redirecting automatically so we can handle
        // errors inline rather than showing a NextAuth error page
        redirect: false,
      })

      if (response?.error) {
        setServerError(resolveAuthError(response.error))
        return
      }

      if (response?.ok) {
        // Redirect to the originally requested URL or the dashboard root
        const callbackUrl = searchParams.get("callbackUrl") ?? "/"
        router.push(callbackUrl)
        router.refresh()
      }
    })
  }

  return (
    /* Full-screen dark background — no sidebar, no topbar */
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <ForgeLogo />

        {/* Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-zinc-50">
              Sign in to your account
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              Enter your credentials to access the dashboard
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {/* Email field */}
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={formData.email}
                onChange={handleChange}
                disabled={isPending}
                placeholder="you@yourcompany.com"
                className={[
                  "w-full px-3 py-2.5 rounded-lg text-sm",
                  "bg-zinc-800 border text-zinc-50 placeholder:text-zinc-500",
                  "transition-colors duration-150",
                  "focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                  fieldErrors.email
                    ? "border-red-500"
                    : "border-zinc-700 hover:border-zinc-600",
                ].join(" ")}
                aria-describedby={fieldErrors.email ? "email-error" : undefined}
                aria-invalid={!!fieldErrors.email}
              />
              {fieldErrors.email && (
                <p
                  id="email-error"
                  role="alert"
                  className="mt-1.5 text-xs text-red-400"
                >
                  {fieldErrors.email}
                </p>
              )}
            </div>

            {/* Password field */}
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={formData.password}
                onChange={handleChange}
                disabled={isPending}
                placeholder="••••••••"
                className={[
                  "w-full px-3 py-2.5 rounded-lg text-sm",
                  "bg-zinc-800 border text-zinc-50 placeholder:text-zinc-500",
                  "transition-colors duration-150",
                  "focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                  fieldErrors.password
                    ? "border-red-500"
                    : "border-zinc-700 hover:border-zinc-600",
                ].join(" ")}
                aria-describedby={
                  fieldErrors.password ? "password-error" : undefined
                }
                aria-invalid={!!fieldErrors.password}
              />
              {fieldErrors.password && (
                <p
                  id="password-error"
                  role="alert"
                  className="mt-1.5 text-xs text-red-400"
                >
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {/* Server / auth error banner */}
            {serverError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3 rounded-lg bg-red-950/50 border border-red-800/60 text-red-300 text-sm"
              >
                {/* Warning icon */}
                <svg
                  className="w-4 h-4 mt-0.5 shrink-0 text-red-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>{serverError}</span>
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={isPending}
              className={[
                "w-full py-2.5 px-4 rounded-lg text-sm font-semibold",
                "bg-green-500 hover:bg-green-400 active:bg-green-600",
                "text-zinc-950 transition-colors duration-150",
                "focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-zinc-900",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                "min-h-[44px]", // Touch-friendly minimum tap target
              ].join(" ")}
            >
              {isPending ? (
                <span className="flex items-center justify-center gap-2">
                  {/* Spinner */}
                  <svg
                    className="animate-spin h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Signing in…
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </div>

        {/* Footer note */}
        <p className="text-center text-xs text-zinc-500 mt-6">
          Forge — AI-powered engineering for founders
        </p>
      </div>
    </div>
  )
}
