import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readRuntimeConfig } from '@intradocs/core/config';
import * as schema from './schema.ts';
import { runActorTransaction } from './transaction.ts';
const globalPools = globalThis as typeof globalThis & { __intradocsPools?: Map<string, Pool> };
export function getPool(kind: 'app' | 'auth' = 'app'): Pool {
  const config = readRuntimeConfig(process.env);
  const pools = (globalPools.__intradocsPools ??= new Map<string, Pool>());
  let pool = pools.get(kind);
  if (!pool) {
    pool = new Pool({
      connectionString: kind === 'app' ? config.databaseUrl : config.authDatabaseUrl,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true,
      application_name: `intradocs-${kind}`,
      options: kind === 'auth' ? '-c search_path=auth,pg_catalog' : undefined,
    });
    pool.on('error', () => console.error('Database pool connection error.'));
    pools.set(kind, pool);
  }
  return pool;
}
export type ScopedDatabase = { client: PoolClient; db: NodePgDatabase<typeof schema> };
export async function withActor<T>(
  actorId: string,
  run: (scope: ScopedDatabase) => Promise<T>,
): Promise<T> {
  if (!actorId || actorId.length > 128) throw new Error('Actor tidak valid.');
  const client = await getPool().connect();
  return runActorTransaction(client, actorId, () =>
    run({ client, db: drizzle(client, { schema }) }),
  );
}
export async function closePools(): Promise<void> {
  await Promise.all([...(globalPools.__intradocsPools?.values() ?? [])].map((pool) => pool.end()));
  globalPools.__intradocsPools?.clear();
}
