import { createContext, useContext, useState, type ReactNode } from 'react';
import { demoUsers } from '../api/fixtures';
import type { DemoUser } from '../types/domain';

// Persona selection only. Replace this module with the team's Auth0 session integration.
const SessionContext = createContext<{
  user: DemoUser | null;
  signIn: (id: string) => void;
  signOut: () => void;
} | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(() => {
    try {
      return demoUsers.find((u) => u.id === sessionStorage.getItem('tandem.demo-user')) ?? null;
    } catch {
      return null;
    }
  });
  function save(id: string | null) {
    try {
      if (id) sessionStorage.setItem('tandem.demo-user', id);
      else sessionStorage.removeItem('tandem.demo-user');
    } catch {
      /* In-memory session still works. */
    }
    setUser(demoUsers.find((u) => u.id === id) ?? null);
  }
  return (
    <SessionContext.Provider value={{ user, signIn: save, signOut: () => save(null) }}>
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Missing session provider');
  return session;
}
