import { withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';
import type { CustomRole } from '@intradocs/core';

/** Every live custom role with how many active accounts hold it. Any signed-in actor may read. */
export async function listCustomRoles(actorId: string): Promise<CustomRole[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      description: string;
      color: string;
      base_role: CustomRole['baseRole'];
      denied_capabilities: CustomRole['deniedCapabilities'];
      revision: number;
      holders: number;
    }>(
      `SELECT r.id,r.name,r.description,r.color,r.base_role,r.denied_capabilities,r.revision,
              (SELECT count(*) FROM app.profiles p WHERE p.custom_role_id=r.id AND p.active)::int AS holders
       FROM app.custom_roles r WHERE r.archived_at IS NULL ORDER BY r.name`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      baseRole: r.base_role,
      deniedCapabilities: r.denied_capabilities,
      revision: r.revision,
      holders: r.holders,
    }));
  });
}

export type CustomRoleInput = {
  id: string | null;
  revision: number;
  name: string;
  description: string;
  color: string;
  baseRole: string;
  deniedCapabilities: string[];
};

/** Create (id null) or update a custom role; the SQL function holds the authority rules. */
export async function saveCustomRole(actorId: string, v: CustomRoleInput): Promise<string> {
  try {
    return await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT app.save_custom_role($1,$2,$3,$4,$5,$6,$7::text[]) AS id',
        [v.id, v.revision, v.name, v.description, v.color, v.baseRole, v.deniedCapabilities],
      );
      return rows[0]!.id;
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

export async function archiveCustomRole(actorId: string, id: string, revision: number) {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query('SELECT app.archive_custom_role($1,$2)', [id, revision]);
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}
