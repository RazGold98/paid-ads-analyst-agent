import { useState, type FormEvent } from "react";
import { api, Unauthorized } from "../api";

export function Login({ onLogin }: { onLogin: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    try {
      await api.budget(code.trim()); // any authorized call proves the code is right
      onLogin(code.trim());
    } catch (err) {
      setError(err instanceof Unauthorized ? "That code is not valid." : (err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Paid Ads Analyst</h1>
        <p className="muted">Enter the access code you received (the same one used for /register in Telegram).</p>
        <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" autoFocus />
        {error && <p className="error">{error}</p>}
        <button disabled={checking || !code.trim()}>{checking ? "Checking..." : "Open"}</button>
      </form>
    </div>
  );
}
