import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { GameState, PlyRecord } from "../shared/protocol.js";

export type ChainActionKind = "start" | "ply" | "end" | "award" | "refund";

export interface PendingChainAction {
  id: string;
  kind: ChainActionKind;
  payload: Record<string, unknown>;
  rawTx?: string;
  txHash?: string;
  nonce?: number;
  plannedAt: number;
  error?: string;
}

export interface StoredGame {
  gameId: string;
  state: GameState;
  capabilityHash: string;
  admissionKey: string;
  admissionDay: string;
  status: GameState["status"];
  version: number;
  /**
   * FIFO queue of chain anchors still to land for this game. Game state is
   * applied optimistically the moment an action is decided; the outbox drains
   * this queue in order and only fills in tx references (or fails the game
   * closed on a definitive revert).
   */
  pendingActions: PendingChainAction[];
  inferenceOwner: string | null;
  inferenceLeaseUntil: Date | null;
  reconciledAt: Date | null;
}

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function fromRow(value: unknown): StoredGame {
  const row = value as {
    game_id: string;
    state: GameState;
    capability_hash: string;
    admission_key: string;
    admission_day: string;
    status: GameState["status"];
    version: string | number;
    pending_actions: PendingChainAction[] | null;
    inference_owner: string | null;
    inference_lease_until: Date | null;
    reconciled_at: Date | null;
  };
  return {
    gameId: row.game_id,
    state: row.state,
    capabilityHash: row.capability_hash,
    admissionKey: row.admission_key,
    admissionDay: row.admission_day,
    status: row.status,
    version: Number(row.version),
    pendingActions: row.pending_actions ?? [],
    inferenceOwner: row.inference_owner,
    inferenceLeaseUntil: row.inference_lease_until,
    reconciledAt: row.reconciled_at,
  };
}

const SELECT = `game_id, state, capability_hash, admission_key, admission_day,
  status, version, pending_actions, inference_owner, inference_lease_until, reconciled_at`;
const TABLE = `"fairmate"."fairmate_games"`;
const WALLET_LOCK_NAME = "fairmate:referee-wallet:v1";
const WALLET_LOCK_WAIT_MS = Number(process.env.FAIRMATE_WALLET_LOCK_WAIT_MS ?? 45_000);

async function locked<T>(name: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export class FairmateStore {
  readonly instanceId = randomUUID();

  admissionKey(ip: string): string {
    const secret = process.env.FAIRMATE_ADMISSION_SECRET ?? process.env.SESSION_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("FAIRMATE_ADMISSION_SECRET or SESSION_SECRET is required in production");
    }
    return createHash("sha256")
      .update(secret ?? "fairmate-development-admission-key")
      .update("\0")
      .update(ip)
      .digest("hex");
  }

  withAdmissionLock<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    return locked("fairmate:admission:v1", work);
  }

  withGameLock<T>(gameId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
    return locked(`fairmate:game:${gameId}`, work);
  }

  /**
   * A session advisory lock is intentional: it remains held while a raw
   * transaction is populated and signed, preventing nonce races across hosts.
   *
   * Waiting happens OFF-connection: a contender try-locks and, on failure,
   * releases its pool connection before sleeping. A blocking pg_advisory_lock
   * would park every waiter on a live connection while the holder still needs
   * connections for its own queries — with a small serverless pool, four
   * concurrent drains self-deadlock the instance.
   */
  async withWalletLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + WALLET_LOCK_WAIT_MS;
    for (;;) {
      const client = await pool.connect();
      let acquired = false;
      try {
        const result = await client.query(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [WALLET_LOCK_NAME],
        );
        acquired = Boolean((result.rows[0] as { locked: boolean }).locked);
        if (acquired) return await work();
      } finally {
        if (acquired) {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
            WALLET_LOCK_NAME,
          ]);
        }
        client.release();
      }
      if (Date.now() > deadline) {
        throw new Error("wallet lock is busy — another instance is draining the outbox");
      }
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.floor(Math.random() * 300)));
    }
  }

  async get(gameId: string, client: Queryable = pool): Promise<StoredGame | null> {
    const result = await client.query(`select ${SELECT} from ${TABLE} where game_id=$1`, [
      gameId,
    ]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async insert(
    game: Omit<StoredGame, "version" | "inferenceOwner" | "inferenceLeaseUntil" | "reconciledAt">,
    client: Queryable,
  ): Promise<StoredGame> {
    const result = await client.query(
      `insert into ${TABLE}
       (game_id,state,capability_hash,admission_key,admission_day,status,pending_actions)
       values ($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb) returning ${SELECT}`,
      [
        game.gameId,
        JSON.stringify(game.state),
        game.capabilityHash,
        game.admissionKey,
        game.admissionDay,
        game.status,
        JSON.stringify(game.pendingActions),
      ],
    );
    return fromRow(result.rows[0]);
  }

  /**
   * Burns a stake transaction hash for one game, forever. Returns false when
   * any game (including refunded and aborted ones) already used it. Callers
   * must throw immediately on false: the aborted INSERT poisons the enclosing
   * transaction, so no further statements may run on this client.
   */
  async registerStake(txHash: string, gameId: string, client: Queryable): Promise<boolean> {
    try {
      await client.query(
        `insert into "fairmate"."fairmate_stakes" (tx_hash, game_id) values ($1, $2)`,
        [txHash.toLowerCase(), gameId],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    }
  }

  async save(
    gameId: string,
    state: GameState,
    pendingActions: PendingChainAction[],
    client: Queryable = pool,
  ): Promise<StoredGame> {
    const result = await client.query(
      `update ${TABLE} set state=$2::jsonb,status=$3,pending_actions=$4::jsonb,
       version=version+1,updated_at=now() where game_id=$1 returning ${SELECT}`,
      [gameId, JSON.stringify(state), state.status, JSON.stringify(pendingActions)],
    );
    if (!result.rows[0]) throw new Error(`no such persisted FairMate game: ${gameId}`);
    return fromRow(result.rows[0]);
  }

  /** Persist signing artifacts onto the queue head without touching game state. */
  async setPendingSigned(gameId: string, action: PendingChainAction): Promise<void> {
    await pool.query(
      `update ${TABLE} set pending_actions=jsonb_set(pending_actions,'{0}',$2::jsonb),
       version=version+1,updated_at=now()
       where game_id=$1 and pending_actions->0->>'id'=$3`,
      [gameId, JSON.stringify(action), action.id],
    );
  }

  async listRecoverable(): Promise<StoredGame[]> {
    const result = await pool.query(
      `select ${SELECT} from ${TABLE}
       where jsonb_array_length(pending_actions) > 0 or status in ('awaiting_player','model_thinking')
       order by created_at`,
    );
    return result.rows.map(fromRow);
  }

  /** Games with a non-empty anchor queue, ordered by queue head: signed nonces first. */
  async listPending(): Promise<StoredGame[]> {
    const result = await pool.query(
      `select ${SELECT} from ${TABLE} where jsonb_array_length(pending_actions) > 0
       order by
         case when pending_actions->0 ? 'nonce' then 0 else 1 end,
         (pending_actions->0->>'nonce')::bigint nulls last,
         (pending_actions->0->>'plannedAt')::bigint,
         pending_actions->0->>'id'`,
    );
    return result.rows.map(fromRow);
  }

  async admissionCounts(
    day: string,
    key: string,
    client: Queryable,
  ): Promise<{ active: number; activeForKey: number; dailyForKey: number; dailyGlobal: number }> {
    const result = await client.query(
      `select
       count(*) filter (where status in ('awaiting_player','model_thinking'))::int active,
       count(*) filter (where status in ('awaiting_player','model_thinking') and admission_key=$2)::int active_for_key,
       count(*) filter (
         where admission_day=$1 and admission_key=$2
         and state->'startTx'->>'status' <> 'failed'
       )::int daily_for_key,
       count(*) filter (
         where admission_day=$1 and state->'startTx'->>'status' <> 'failed'
       )::int daily_global
       from ${TABLE}`,
      [day, key],
    );
    const row = result.rows[0] as Record<string, number>;
    return {
      active: row.active,
      activeForKey: row.active_for_key,
      dailyForKey: row.daily_for_key,
      dailyGlobal: row.daily_global,
    };
  }

  async claimInference(gameId: string, leaseMs: number): Promise<boolean> {
    const result = await pool.query(
      `update ${TABLE} set inference_owner=$2,
       inference_lease_until=now()+($3::text || ' milliseconds')::interval,updated_at=now()
       where game_id=$1 and status='model_thinking'
       and (inference_lease_until is null or inference_lease_until < now())
       returning game_id`,
      [gameId, this.instanceId, leaseMs],
    );
    return result.rowCount === 1;
  }

  async releaseInference(gameId: string): Promise<void> {
    await pool.query(
      `update ${TABLE} set inference_owner=null,inference_lease_until=null
       where game_id=$1 and inference_owner=$2`,
      [gameId, this.instanceId],
    );
  }

  async renewInference(gameId: string, leaseMs: number): Promise<boolean> {
    const result = await pool.query(
      `update ${TABLE}
       set inference_lease_until=now()+($3::text || ' milliseconds')::interval
       where game_id=$1 and inference_owner=$2 and status='model_thinking'
       returning game_id`,
      [gameId, this.instanceId, leaseMs],
    );
    return result.rowCount === 1;
  }

  async markReconciled(gameId: string, client: Queryable = pool): Promise<void> {
    await client.query(`update ${TABLE} set reconciled_at=now() where game_id=$1`, [gameId]);
  }
}

export function newAction(
  kind: ChainActionKind,
  payload: Record<string, unknown>,
): PendingChainAction {
  return { id: randomUUID(), kind, payload, plannedAt: Date.now() };
}

export function actionPly(action: PendingChainAction): PlyRecord {
  return action.payload.ply as unknown as PlyRecord;
}
