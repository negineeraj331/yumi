import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { RegionNotice, asRegionMismatch } from "../region";
import type { RegionMismatch } from "@yumi/shared";

export function InvitePage() {
  const { token } = useParams();
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState("");
  // An invite link is opened wherever the recipient's browser resolves, which
  // makes it the likeliest way to land on the wrong region entirely.
  const [regionBlock, setRegionBlock] = useState<RegionMismatch | null>(null);

  const failed = (e: any) => {
    const region = asRegionMismatch(e);
    if (region) setRegionBlock(region);
    else setError(e.message);
  };

  useEffect(() => {
    api.getInvite(token!).then(setInfo).catch(failed);
  }, [token]);

  async function accept() {
    try {
      const { workspaceId } = await api.acceptInvite(token!);
      nav(`/w/${workspaceId}`);
    } catch (e: any) { failed(e); }
  }

  if (loading) return <div className="center-screen">Loading…</div>;
  if (regionBlock) return <RegionNotice detail={regionBlock} />;
  if (error) return <div className="center-screen error-text">{error}</div>;
  if (!info) return <div className="center-screen">Resolving invite…</div>;

  return (
    <div className="center-screen">
      <div className="card" style={{ padding: 40, textAlign: "center", maxWidth: 420 }}>
        <div className="meta">You're invited to</div>
        <h1 className="display" style={{ fontSize: 34, margin: "8px 0 4px" }}>{info.workspaceName}</h1>
        <div className="chip chip-role" style={{ display: "inline-block", marginBottom: 24 }}>as {info.scope}</div>
        {user ? (
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={accept}>Join workspace</button>
        ) : (
          <button className="btn btn-primary" style={{ width: "100%" }}
            onClick={() => nav("/login", { state: { from: `/invite/${token}` } })}>
            Log in to join
          </button>
        )}
      </div>
    </div>
  );
}
