import type { Collection, Db } from "mongodb";
import type { AdSetStatus } from "../ads/types.js";

/**
 * pending → executing → succeeded | failed | unknown
 * pending → rejected | expired
 * "executing" is set atomically on approval, so a second click can never run the action again.
 */
export type ActionStatus = "pending" | "executing" | "succeeded" | "failed" | "unknown" | "rejected" | "expired";

export interface Requester {
  channel: "telegram" | "mcp";
  name: string;
  // Telegram chat to notify about the outcome; absent for MCP clients.
  chatId?: number;
}

export interface Approver {
  _id: number; // Telegram user id
  name: string;
  chatId: number;
  registeredAt: Date;
}

/** What the approver sees: read from the API by our code when the request is created, not written by the model. */
export interface Snapshot {
  adsetName: string;
  status: AdSetStatus;
  dailyBudget: number;
  period: { since: string; until: string };
  spend: number;
  conversions: number;
  cpa: number | null;
  roas: number | null;
  lowSample: boolean;
}

export interface ActionRequest {
  _id: string; // short id shown to people, also the base of the idempotency key
  type: "pause_adset";
  adsetId: string;
  // Written by the model; shown to the approver as the agent's reasoning.
  reason: string;
  snapshot: Snapshot;
  requestedBy: Requester;
  status: ActionStatus;
  createdAt: Date;
  expiresAt: Date;
  decidedBy?: { userId: number; name: string };
  decidedAt?: Date;
  // Human-readable outcome, e.g. "API returned an error, but the ad set is paused".
  result?: string;
  finishedAt?: Date;
  // Approval cards sent in Telegram, so they can be updated with the outcome.
  cards: { chatId: number; messageId: number }[];
}

export interface AuditEntry {
  requestId?: string;
  event: string;
  by?: string;
  detail?: string;
  at: Date;
}

/** Everything the approval flow needs from storage. Tests use an in-memory version. */
export interface ActionStore {
  create(request: ActionRequest): Promise<void>;
  get(id: string): Promise<ActionRequest | null>;
  findPending(adsetId: string, now: Date): Promise<ActionRequest | null>;
  /** pending → executing, only if still pending and not expired. Returns null otherwise. */
  claim(id: string, approver: { userId: number; name: string }, now: Date): Promise<ActionRequest | null>;
  /** pending → rejected, only if still pending. Returns null otherwise. */
  reject(id: string, approver: { userId: number; name: string }, now: Date): Promise<ActionRequest | null>;
  expire(id: string): Promise<void>;
  finish(id: string, status: "succeeded" | "failed" | "unknown", result: string, now: Date): Promise<ActionRequest | null>;
  addCard(id: string, card: { chatId: number; messageId: number }): Promise<void>;
  log(entry: AuditEntry): Promise<void>;
  addApprover(approver: Approver): Promise<void>;
  isApprover(userId: number): Promise<boolean>;
  listApprovers(): Promise<Approver[]>;
}

export class MongoActionStore implements ActionStore {
  private readonly requests: Collection<ActionRequest>;
  private readonly audit: Collection<AuditEntry>;
  private readonly approvers: Collection<Approver>;

  constructor(db: Db) {
    this.requests = db.collection<ActionRequest>("action_requests");
    this.audit = db.collection<AuditEntry>("audit_log");
    this.approvers = db.collection<Approver>("approvers");
  }

  async create(request: ActionRequest): Promise<void> {
    await this.requests.insertOne(request);
  }

  get(id: string): Promise<ActionRequest | null> {
    return this.requests.findOne({ _id: id });
  }

  findPending(adsetId: string, now: Date): Promise<ActionRequest | null> {
    return this.requests.findOne({ adsetId, status: "pending", expiresAt: { $gt: now } });
  }

  // A single conditional update: if two approvers click at once, only one of them gets the document back.
  claim(id: string, approver: { userId: number; name: string }, now: Date): Promise<ActionRequest | null> {
    return this.requests.findOneAndUpdate(
      { _id: id, status: "pending", expiresAt: { $gt: now } },
      { $set: { status: "executing", decidedBy: approver, decidedAt: now } },
      { returnDocument: "after" },
    );
  }

  reject(id: string, approver: { userId: number; name: string }, now: Date): Promise<ActionRequest | null> {
    return this.requests.findOneAndUpdate(
      { _id: id, status: "pending" },
      { $set: { status: "rejected", decidedBy: approver, decidedAt: now } },
      { returnDocument: "after" },
    );
  }

  async expire(id: string): Promise<void> {
    await this.requests.updateOne({ _id: id, status: "pending" }, { $set: { status: "expired" } });
  }

  finish(id: string, status: "succeeded" | "failed" | "unknown", result: string, now: Date): Promise<ActionRequest | null> {
    return this.requests.findOneAndUpdate(
      { _id: id },
      { $set: { status, result, finishedAt: now } },
      { returnDocument: "after" },
    );
  }

  async addCard(id: string, card: { chatId: number; messageId: number }): Promise<void> {
    await this.requests.updateOne({ _id: id }, { $push: { cards: card } });
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.audit.insertOne(entry);
  }

  async addApprover(approver: Approver): Promise<void> {
    await this.approvers.replaceOne({ _id: approver._id }, approver, { upsert: true });
  }

  async isApprover(userId: number): Promise<boolean> {
    return (await this.approvers.countDocuments({ _id: userId })) > 0;
  }

  listApprovers(): Promise<Approver[]> {
    return this.approvers.find().toArray();
  }
}
