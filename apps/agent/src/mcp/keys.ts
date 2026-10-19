import { createHash, timingSafeEqual } from "node:crypto";

// read: data tools and ask_analyst. propose: create pause requests and read their status.
// There is no scope that approves or executes: only a human in Telegram can do that.
export const SCOPES = ["read", "propose"] as const;
export type Scope = (typeof SCOPES)[number];

export interface McpClient {
  name: string;
  scopes: Scope[];
  keyHash: Buffer;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * Parses MCP_API_KEYS, e.g. "planner:<key>:read+propose,reports:<key>:read".
 * Throws a readable error so config validation can report it at startup.
 */
export function parseMcpKeys(raw: string): McpClient[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, key, scopeList, ...rest] = entry.split(":");
      if (!name || !key || !scopeList || rest.length > 0) throw new Error(`"${name ?? entry}" must be name:key:scopes`);
      if (key.length < 24) throw new Error(`key for "${name}" must be at least 24 characters`);
      const scopes = scopeList.split("+");
      for (const s of scopes) {
        if (!SCOPES.includes(s as Scope)) throw new Error(`unknown scope "${s}" for "${name}" (use ${SCOPES.join(", ")})`);
      }
      // Only a hash is kept in memory, never the key itself.
      return { name, scopes: scopes as Scope[], keyHash: sha256(key) };
    });
}

/** Finds the client for a bearer key; compares hashes in constant time so timing reveals nothing. */
export function findClient(clients: McpClient[], key: string): McpClient | undefined {
  const hash = sha256(key);
  return clients.find((c) => timingSafeEqual(c.keyHash, hash));
}
