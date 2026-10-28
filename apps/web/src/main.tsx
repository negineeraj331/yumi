import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { AdminPage } from "./pages/AdminPage";
import { SessionPage } from "./pages/SessionPage";
import { InvitePage } from "./pages/InvitePage";
import "./theme.css";
import "./app.css";
import "./landing.css";

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen">Loading…</div>;
  return user ? <DashboardPage /> : <LandingPage />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/" element={<Home />} />
        <Route path="/w/:workspaceId" element={<Protected><WorkspacePage /></Protected>} />
        <Route path="/w/:workspaceId/admin" element={<Protected><AdminPage /></Protected>} />
        <Route path="/p/:projectId" element={<Protected><SessionPage /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
