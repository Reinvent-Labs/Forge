/**
 * utils.ts
 *
 * Shared utility functions for the Forge CLI:
 *   - printForgeHeader()  — ASCII art banner
 *   - formatTable()       — aligned plain-text table with chalk colours
 *   - handleApiError()    — converts axios / generic errors into friendly strings
 */

import chalk from 'chalk'
import type { AxiosError } from 'axios'

// ---------------------------------------------------------------------------
// ASCII banner
// ---------------------------------------------------------------------------

const FORGE_BANNER = `
 ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
 █████╗  ██║   ██║██████╔╝██║  ███╗█████╗
 ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
 ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
 ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
`

/**
 * Prints the Forge ASCII banner to stdout in bold green.
 * Called at the top of long-running interactive commands.
 */
export function printForgeHeader(): void {
  console.log(chalk.bold.green(FORGE_BANNER))
  console.log(chalk.dim('  Your AI startup CTO — forge --help for commands\n'))
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

/** A single row in a table — each cell is a string (may contain ANSI codes). */
export type TableRow = string[]

/**
 * Formats an array of rows into a neatly aligned plain-text table.
 *
 * The first row is treated as the header and rendered in bold white with an
 * underline separator.  Subsequent rows alternate between white and dim to
 * improve scannability.  Column widths are calculated on the visible (ANSI-
 * stripped) character count so chalk-coloured cells align correctly.
 *
 * @param rows - Array of string arrays. All rows must have the same length.
 * @returns    Multi-line string ready for console.log().
 */
export function formatTable(rows: TableRow[]): string {
  if (rows.length === 0) return ''

  // Strip ANSI escape sequences to measure true visible width
  const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, '')

  const colCount = rows[0]?.length ?? 0

  // Compute the maximum visible width of each column
  const colWidths: number[] = Array.from({ length: colCount }, (_, colIdx) =>
    Math.max(...rows.map((row) => stripAnsi(row[colIdx] ?? '').length)),
  )

  const lines: string[] = []

  rows.forEach((row, rowIdx) => {
    // Pad each cell to its column's max width (accounting for ANSI overhead)
    const cells = row.map((cell, colIdx) => {
      const visible = stripAnsi(cell)
      const padding = (colWidths[colIdx] ?? 0) - visible.length
      return cell + ' '.repeat(Math.max(0, padding))
    })

    const line = '  ' + cells.join('  ')

    if (rowIdx === 0) {
      // Header row — bold white
      lines.push(chalk.bold.white(line))
      // Underline separator
      const separatorWidth = colWidths.reduce((sum, w) => sum + w, 0) + (colCount - 1) * 2
      lines.push(chalk.dim('  ' + '─'.repeat(separatorWidth)))
    } else {
      lines.push(rowIdx % 2 === 0 ? chalk.dim(line) : chalk.white(line))
    }
  })

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// API error handler
// ---------------------------------------------------------------------------

/**
 * Converts an axios error (or any generic Error) into a user-friendly message
 * string suitable for display with chalk.red().
 *
 * Priority order:
 *  1. Server-provided JSON `{ message }` field
 *  2. HTTP status code + status text
 *  3. Network-level error (ECONNREFUSED, ENOTFOUND, timeout)
 *  4. Fallback to err.message
 *
 * @param err - The error caught from an axios call or other async operation.
 * @returns   A plain string (no ANSI codes) describing what went wrong.
 */
export function handleApiError(err: AxiosError | Error): string {
  const axiosErr = err as AxiosError

  if (axiosErr.isAxiosError === true) {
    // Network error (no response received)
    if (!axiosErr.response) {
      const code = axiosErr.code ?? 'UNKNOWN'

      if (code === 'ECONNREFUSED') {
        return (
          'Cannot connect to the Forge API. ' +
          'Is the server running? Check `forge status` or set a custom URL with `forge config set apiUrl <url>`.'
        )
      }

      if (code === 'ENOTFOUND') {
        return 'Host not found. Check your API URL with `forge config set apiUrl <url>`.'
      }

      if (code === 'ETIMEDOUT' || axiosErr.message.includes('timeout')) {
        return 'Request timed out. The Forge API may be under heavy load — try again in a moment.'
      }

      return `Network error (${code}): ${axiosErr.message}`
    }

    // Server responded with a non-2xx status
    const status = axiosErr.response.status
    const responseData = axiosErr.response.data as Record<string, unknown> | undefined

    const serverMessage =
      typeof responseData?.['message'] === 'string'
        ? responseData['message']
        : typeof responseData?.['error'] === 'string'
          ? responseData['error']
          : null

    if (serverMessage) {
      return `API error ${status}: ${serverMessage}`
    }

    // Auth errors
    if (status === 401) return 'Unauthorized — run `forge login` to authenticate.'
    if (status === 403) return 'Forbidden — your token does not have permission for this action.'
    if (status === 404) return 'Resource not found. Check your project ID or approval ID.'
    if (status === 429) return 'Rate limited by the Forge API — wait a moment and try again.'

    return `API error ${status}: ${axiosErr.response.statusText}`
  }

  // Plain Error (e.g. JSON parse failure, validation error)
  return err.message
}
