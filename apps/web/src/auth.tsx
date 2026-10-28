import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicUser } from "@yumi/shared";
import { api, setAccessToken } from "./api";

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: PublicUser) => void;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, try to restore session via refresh cookie
  useEffect(() => {
    (async () => {
      const ok = await api.refresh();
      if (ok) {
        try {
          const { user } = await api.me();
          setUser(user);
        } catch {
          /* ignore */
        }
      }
      setLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const { user, accessToken } = await api.login({ email, password });
    setAccessToken(accessToken);
    setUser(user);
  };

  const register = async (email: string, password: string, displayName: string) => {
    const { user, accessToken } = await api.register({ email, password, displayName });
    setAccessToken(accessToken);
    setUser(user);
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    setAccessToken(null);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, register, logout, setUser }}>{children}</Ctx.Provider>;
}
