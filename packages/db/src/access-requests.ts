import { randomUUID } from 'node:crypto';
import { withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';

/**
 * Access requests.
 *
 * Every query runs under the actor's own RLS, so the set of categories a requester can
 * name is exactly the set they can already see. Nothing here can be used to discover a
 * category, a document, or even how many exist outside that scope.
 */

export interface AccessRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  categoryId: string;
  categoryName: string;
  classification: string;
  reason: string;
  state: string;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export async function createAccessRequest(
  actorId: string,
  input: { categoryId: string; classification: string; reason: string },
): Promise<{ id: string }> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.access_requests(requester_id,category_id,classification,reason)
         VALUES(app.actor_id(),$1,$2,$3) RETURNING id`,
        [input.categoryId, input.classification, input.reason],
      );
      await client.query(
        `INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),'access.requested',$1)`,
        [randomUUID()],
      );
      return { id: rows[0]!.id };
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

export async function listAccessRequests(actorId: string): Promise<AccessRequest[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      requester_id: string;
      requester_name: string;
      category_id: string;
      category_name: string;
      classification: string;
      reason: string;
      state: string;
      decision_note: string | null;
      created_at: Date;
      decided_at: Date | null;
    }>(
      `SELECT r.id,r.requester_id,p.name AS requester_name,r.category_id,c.name AS category_name,
        r.classification,r.reason,r.state,r.decision_note,r.created_at,r.decided_at
       FROM app.access_requests r
       JOIN app.profiles p ON p.id=r.requester_id
       JOIN app.categories c ON c.id=r.category_id
       ORDER BY (r.state='pending') DESC, r.created_at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      id: r.id,
      requesterId: r.requester_id,
      requesterName: r.requester_name,
      categoryId: r.category_id,
      categoryName: r.category_name,
      classification: r.classification,
      reason: r.reason,
      state: r.state,
      decisionNote: r.decision_note,
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
    }));
  });
}

export async function decideAccessRequest(
  actorId: string,
  id: string,
  approve: boolean,
  note: string,
): Promise<void> {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query('SELECT app.decide_access_request($1,$2,$3)', [id, approve, note]);
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
