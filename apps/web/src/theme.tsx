import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
const KEY = "yumi-theme";

const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });
export const useTheme = () => useContext(Ctx);

function initial(): Theme {
  const saved = localStorage.getItem(KEY) as Theme | null;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return (
    <Ctx.Provider value={{ theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) }}>
      {children}
    </Ctx.Provider>
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button className="btn btn-secondary btn-sm" onClick={toggle} title="Toggle theme" aria-label="Toggle theme">
      {theme === "light" ? "🌙" : "☀️"}
    </button>
  );
}
