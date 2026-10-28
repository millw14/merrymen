/** Bot stream mutex in addition to the existing tenant lease. */
import { createHash } from "node:crypto";
import { recoveryReplyRefused } from "./recovery-reply-proof";
export interface ReplyLease {
    healthy(): boolean;
    release(): Promise<void>;
}
export interface ReplyLeaseClient {
    query(sql: string, values?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }>;
    on(event: "error" | "end", fn: () => void): unknown;
    end(): Promise<void>;
}
export class RecoveryReplyBotLeases {
    private live = true;
    private tail: Promise<unknown> = Promise.resolve();
    private held = new Map<string, {
        key: number;
        active: boolean;
    }>();
    constructor(private client: ReplyLeaseClient, private onLoss: () => void) {
        const lost = () => {
            if (this.live) {
                this.live = false;
                for (const h of this.held.values())
                    h.active = false;
                this.onLoss();
            }
        };
        client.on("error", lost);
        client.on("end", lost);
    }
    private query(sql: string, values: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }> {
        const call = this.tail.then(() => {
            if (!this.live)
                throw recoveryReplyRefused();
            return this.client.query(sql, values);
        });
        this.tail = call.catch(() => {
            if (this.live) {
                this.live = false;
                this.onLoss();
            }
        });
        return call;
    }
    async acquire(botId: string): Promise<ReplyLease | null> {
        if (!/^[1-9][0-9]{0,15}$/.test(botId) || this.held.has(botId))
            throw recoveryReplyRefused();
        const key = createHash("sha256").update(`merrymen-reply-bot:${botId}`).digest().readInt32BE(0);
        if ([...this.held.values()].some(h => h.key === key))
            return null;
        const state = { key, active: false };
        this.held.set(botId, state);
        try {
            const { rows } = await this.query("SELECT pg_try_advisory_lock($1::integer,$2::integer) AS held", [0x4d525042, key]);
            if (rows.length !== 1 || (rows[0]?.held !== true && rows[0]?.held !== false)) {
                await this.close();
                this.onLoss();
                throw recoveryReplyRefused();
            }
            if (rows[0]!.held === false) {
                this.held.delete(botId);
                return null;
            }
            state.active = true;
            let released: Promise<void> | null = null;
            return { healthy: () => this.live && state.active, release: () => released ??= (async () => {
                    state.active = false;
                    try {
                        if (this.live) {
                            const { rows } = await this.query("SELECT pg_advisory_unlock($1::integer,$2::integer) AS released", [0x4d525042, key]);
                            if (rows[0]?.released !== true)
                                throw recoveryReplyRefused();
                        }
                    }
                    finally {
                        this.held.delete(botId);
                    }
                })() };
        }
        catch (e) {
            this.held.delete(botId);
            throw e;
        }
    }
    async close(): Promise<void> {
        this.live = false;
        for (const h of this.held.values())
            h.active = false;
        await this.client.end();
    }
}
