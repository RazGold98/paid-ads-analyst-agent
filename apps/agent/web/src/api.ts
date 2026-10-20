// Shapes of what the agent's /api returns (see src/web/api.ts on the server).
export interface BudgetStatus {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  fraction: number;
}

export interface ActionRequest {
  _id: string;
  adsetId: string;
  reason: string;
  status: "pending" | "executing" | "succeeded" | "failed" | "unknown" | "rejected" | "expired";
  snapshot: { adsetName: string; spend: number; conversions: number; cpa: number | null; roas: number | null; dailyBudget: number };
  requestedBy: { channel: string; name: string };
  decidedBy?: { name: string };
  result?: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuditEntry {
  requestId?: string;
  event: string;
  by?: string;
  detail?: string;
  at: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class Unauthorized extends Error {}

async function call<T>(code: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
  });
  if (res.status === 401) throw new Unauthorized("Wrong access code");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  budget: (code: string) => call<BudgetStatus>(code, "/budget"),
  requests: (code: string) => call<ActionRequest[]>(code, "/requests"),
  audit: (code: string) => call<AuditEntry[]>(code, "/audit"),
  chat: (code: string, question: string, history: ChatMessage[]) =>
    call<{ answer: string; toolCalls: string[] }>(code, "/chat", {
      method: "POST",
      body: JSON.stringify({ question, history: history.slice(-6) }),
    }),
};

// The access code is kept for this browser tab only. Storage can be blocked (private mode), so failures are ignored.
const KEY = "paid-ads-access-code";
export const savedCode = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const saveCode = (code: string | null): void => {
  try {
    if (code) sessionStorage.setItem(KEY, code);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Not saved: the user will be asked again after a reload.
  }
};
