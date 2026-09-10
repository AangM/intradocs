// Driver-independent unit tests cover lifecycle, not PostgreSQL/RLS semantics.
export interface TransactionClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(destroy?: boolean): void;
}
export async function runActorTransaction<T>(
  client: TransactionClient,
  actorId: string,
  run: () => Promise<T>,
): Promise<T> {
  let began = false,
    committing = false,
    discard = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SELECT set_config('app.actor_id',$1,true)", [actorId]);
    await client.query("SET LOCAL statement_timeout='5s'");
    const value = await run();
    committing = true;
    await client.query('COMMIT');
    return value;
  } catch (error) {
    discard = !began || committing;
    if (began)
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    throw error;
  } finally {
    client.release(discard);
  }
}
