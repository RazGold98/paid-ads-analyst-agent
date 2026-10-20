import { useCallback, useEffect, useState } from "react";
import { api, saveCode, savedCode, Unauthorized, type ActionRequest, type AuditEntry, type BudgetStatus } from "./api";
import { AuditLog } from "./components/AuditLog";
import { BudgetMeter } from "./components/BudgetMeter";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { Requests } from "./components/Requests";

// Pending approvals change when someone clicks in Telegram, so the side panels refresh on their own.
const REFRESH_MS = 10_000;

export function App() {
  const [code, setCode] = useState<string | null>(savedCode());

  const login = (value: string) => {
    saveCode(value);
    setCode(value);
  };
  const logout = useCallback(() => {
    saveCode(null);
    setCode(null);
  }, []);

  return code ? <Dashboard code={code} onLogout={logout} /> : <Login onLogin={login} />;
}

function Dashboard({ code, onLogout }: { code: string; onLogout: () => void }) {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [requests, setRequests] = useState<ActionRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, r, a] = await Promise.all([api.budget(code), api.requests(code), api.audit(code)]);
      setBudget(b);
      setRequests(r);
      setAudit(a);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) onLogout();
      else setError((err as Error).message);
    }
  }, [code, onLogout]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Paid Ads Analyst</h1>
          <p className="muted">Stride Footwear · Meta ad account act_1001</p>
        </div>
        {budget && <BudgetMeter budget={budget} />}
        <button className="link" onClick={onLogout}>
          Log out
        </button>
      </header>
      {error && <p className="banner">Could not refresh: {error}</p>}
      <main className="layout">
        <Chat code={code} onAnswer={refresh} onUnauthorized={onLogout} />
        <aside className="side">
          <Requests requests={requests} />
          <AuditLog entries={audit} />
        </aside>
      </main>
    </div>
  );
}
