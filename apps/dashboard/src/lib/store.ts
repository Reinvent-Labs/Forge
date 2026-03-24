import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Incident } from "./types"

/**
 * ForgeStore — global client state.
 *
 * Keeps only UI state here. Server data lives in React Query.
 * Persisted fields (projectId) survive page refresh via localStorage.
 */
interface ForgeStore {
  // Current project context
  currentProjectId: string | null
  setProject: (id: string) => void

  // Active incident banner
  activeIncident: Incident | null
  setActiveIncident: (incident: Incident | null) => void

  // Pending approvals count (badge on nav)
  pendingApprovals: number
  setPendingApprovals: (count: number) => void

  // Sidebar mobile open state
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void

  // Global notifications
  notifications: Notification[]
  addNotification: (notification: Omit<Notification, "id" | "timestamp">) => void
  dismissNotification: (id: string) => void
  clearNotifications: () => void
}

interface Notification {
  id: string
  type: "success" | "error" | "warning" | "info"
  title: string
  message: string
  timestamp: number
}

export const useForgeStore = create<ForgeStore>()(
  persist(
    (set, get) => ({
      // Current project
      currentProjectId: null,
      setProject: (id) => set({ currentProjectId: id }),

      // Active incident
      activeIncident: null,
      setActiveIncident: (incident) => set({ activeIncident: incident }),

      // Pending approvals
      pendingApprovals: 0,
      setPendingApprovals: (count) => set({ pendingApprovals: count }),

      // Sidebar state
      sidebarOpen: false,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),

      // Notifications
      notifications: [],
      addNotification: (notification) =>
        set((state) => ({
          notifications: [
            {
              ...notification,
              id: Math.random().toString(36).slice(2),
              timestamp: Date.now(),
            },
            ...state.notifications.slice(0, 49), // Keep max 50
          ],
        })),
      dismissNotification: (id) =>
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
        })),
      clearNotifications: () => set({ notifications: [] }),
    }),
    {
      name: "forge-store",
      // Only persist project ID across sessions
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
      }),
    }
  )
)
