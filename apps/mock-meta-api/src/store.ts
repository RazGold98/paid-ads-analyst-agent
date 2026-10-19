import type { Collection, Db } from "mongodb";
import type { AdSetStatus } from "./data/entities.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

interface AdSetStatusDoc {
  adset_id: string;
  status: AdSetStatus;
  updated_at: Date;
}

/** HTTP status + body replayed verbatim when an Idempotency-Key is reused. */
export interface StoredResponse {
  status: number;
  body: unknown;
}

interface IdempotencyDoc {
  key: string;
  adset_id: string;
  response: StoredResponse;
  created_at: Date;
}

/** Ad set statuses and idempotency keys. An ad set with no status document is ACTIVE. */
export class Store {
  private readonly statuses: Collection<AdSetStatusDoc>;
  private readonly idempotency: Collection<IdempotencyDoc>;

  constructor(db: Db) {
    this.statuses = db.collection<AdSetStatusDoc>("adset_status");
    this.idempotency = db.collection<IdempotencyDoc>("idempotency");
  }

  async ensureIndexes(): Promise<void> {
    await this.statuses.createIndex({ adset_id: 1 }, { unique: true });
    await this.idempotency.createIndex({ key: 1 }, { unique: true });
    await this.idempotency.createIndex({ created_at: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_SECONDS });
  }

  async getStatuses(): Promise<Map<string, AdSetStatus>> {
    const docs = await this.statuses.find().toArray();
    return new Map(docs.map((doc) => [doc.adset_id, doc.status]));
  }

  async getStatus(adsetId: string): Promise<AdSetStatus> {
    const doc = await this.statuses.findOne({ adset_id: adsetId });
    return doc?.status ?? "ACTIVE";
  }

  async setStatus(
    adsetId: string,
    status: AdSetStatus,
  ): Promise<{ previous: AdSetStatus; updatedAt: Date }> {
    const updatedAt = new Date();
    const before = await this.statuses.findOneAndUpdate(
      { adset_id: adsetId },
      { $set: { status, updated_at: updatedAt } },
      { upsert: true, returnDocument: "before" },
    );
    return { previous: before?.status ?? "ACTIVE", updatedAt };
  }

  async findIdempotent(key: string): Promise<StoredResponse | null> {
    const doc = await this.idempotency.findOne({ key });
    return doc?.response ?? null;
  }

  async saveIdempotent(key: string, adsetId: string, response: StoredResponse): Promise<void> {
    // $setOnInsert keeps the first response if two requests with the same key race.
    await this.idempotency.updateOne(
      { key },
      { $setOnInsert: { adset_id: adsetId, response, created_at: new Date() } },
      { upsert: true },
    );
  }

  /** Back to the initial state: every ad set ACTIVE, no idempotency keys. */
  async reset(): Promise<void> {
    await this.statuses.deleteMany({});
    await this.idempotency.deleteMany({});
  }
}
