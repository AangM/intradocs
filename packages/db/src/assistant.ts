import { randomUUID } from 'node:crypto';
import { sanitizeSnippet, type Citation, type RetrievalScope } from '@intradocs/core/rag';
import { cleanAnswer } from '@intradocs/core/weknora';
import { InputError } from '@intradocs/core/validation';
import { withActor } from './index.ts';

/**
 * Assistant history and scope options, all under RLS (migration 029).
 *
 * Nothing here decides what a person may read. The scope options are drawn from tables
 * that already hide what the actor cannot see; a stored citation returns only while
 * app.can_read_version still says yes for its version.
 */

export interface ScopeDocument {
  id: string;
  title: string;
  slug: string;
  categoryName: string;
  lastReadAt: string;
}

/** Documents the actor has opened, most recent first: the "dokumen yang saya buka" scope. */
export async function listRecentlyReadDocuments(
  actorId: string,
  limit = 12,
): Promise<ScopeDocument[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      slug: string;
      category_name: string;
      last_read_at: string;
    }>(
      `SELECT DISTINCT ON (d.id) d.id,v.title,d.slug,coalesce(c.name,'-') AS category_name,
        h.last_read_at::text
       FROM app.read_history h
       JOIN app.document_versions v ON v.id=h.version_id
       JOIN app.documents d ON d.id=v.document_id
       LEFT JOIN app.categories c ON c.id=d.category_id
       WHERE h.user_id=app.actor_id()
       ORDER BY d.id,h.last_read_at DESC`,
    );
    return rows
      .sort((a, b) => (a.last_read_at < b.last_read_at ? 1 : -1))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        categoryName: r.category_name,
        lastReadAt: r.last_read_at,
      }));
  });
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

export async function listConversations(
  actorId: string,
  limit = 30,
): Promise<ConversationSummary[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      updated_at: string;
      turns: string;
    }>(
      `SELECT c.id,c.title,c.updated_at::text,
        (SELECT count(*) FROM app.ai_turns t WHERE t.conversation_id=c.id) AS turns
       FROM app.ai_conversations c
       ORDER BY c.updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      turns: Number(r.turns),
    }));
  });
}

export interface StoredCitation {
  documentId: string;
  versionId: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  snippet: string;
  heading: string | null;
  href: string;
}

export interface StoredTurn {
  id: string;
  question: string;
  /** Empty when the answer is withheld because a source is no longer readable. */
  answer: string;
  abstained: boolean;
  mode: 'generated' | 'evidence-only';
  scope: RetrievalScope;
  scopeSize: number;
  rejectedCount: number;
  citations: StoredCitation[];
  /** Citations stored with the turn that the reader can no longer see. */
  hiddenCitations: number;
  /** The owner's vote, if any. */
  helpful: boolean | null;
  createdAt: string;
}

export interface Conversation extends ConversationSummary {
  turnList: StoredTurn[];
}

export async function readConversation(
  actorId: string,
  conversationId: string,
): Promise<Conversation | null> {
  return withActor(actorId, async ({ client }) => {
    const head = await client.query<{ id: string; title: string; updated_at: string }>(
      'SELECT id,title,updated_at::text FROM app.ai_conversations WHERE id=$1',
      [conversationId],
    );
    const row = head.rows[0];
    if (!row) return null;
    const turns = await client.query<{
      id: string;
      question: string;
      answer: string;
      abstained: boolean;
      mode: 'generated' | 'evidence-only';
      scope: RetrievalScope;
      scope_size: number;
      rejected_count: number;
      citation_count: number;
      helpful: boolean | null;
      created_at: string;
    }>(
      `SELECT id,question,answer,abstained,mode,scope,scope_size,rejected_count,citation_count,
        helpful,created_at::text
       FROM app.ai_turns WHERE conversation_id=$1 ORDER BY created_at,id`,
      [conversationId],
    );
    const cites = await client.query<{
      turn_id: string;
      document_id: string;
      version_id: string;
      slug: string;
      title: string;
      label: string;
      classification: string;
      category_name: string;
      snippet: string;
      heading: string | null;
      anchor: string | null;
    }>(
      `SELECT x.turn_id,x.document_id,x.version_id,d.slug,v.title,v.label,v.classification,
        coalesce(c.name,'-') AS category_name,x.snippet,x.heading,x.anchor
       FROM app.ai_turn_citations x
       JOIN app.ai_turns t ON t.id=x.turn_id
       JOIN app.document_versions v ON v.id=x.version_id
       JOIN app.documents d ON d.id=x.document_id
       LEFT JOIN app.categories c ON c.id=v.category_id
       WHERE t.conversation_id=$1 ORDER BY x.turn_id,x.position`,
      [conversationId],
    );
    const byTurn = new Map<string, StoredCitation[]>();
    for (const r of cites.rows) {
      const list = byTurn.get(r.turn_id) ?? [];
      list.push({
        documentId: r.document_id,
        versionId: r.version_id,
        documentTitle: r.title,
        versionLabel: r.label,
        classification: r.classification,
        categoryName: r.category_name,
        // Stored as retrieved; presented the way a fresh citation is.
        snippet: sanitizeSnippet(r.snippet, 4000),
        heading: r.heading,
        href: `/dokumen/${r.document_id}/${r.slug}${r.anchor ? `#${r.anchor}` : ''}`,
      });
      byTurn.set(r.turn_id, list);
    }
    const turnList: StoredTurn[] = turns.rows.map((t) => {
      const citations = byTurn.get(t.id) ?? [];
      const hidden = Math.max(0, t.citation_count - citations.length);
      return {
        id: t.id,
        question: t.question,
        // An answer composed from a source the reader may no longer see is withheld
        // with it: the text would otherwise quote what the citation now hides.
        answer: hidden > 0 ? '' : cleanAnswer(t.answer),
        abstained: t.abstained,
        mode: t.mode,
        scope: t.scope,
        scopeSize: t.scope_size,
        rejectedCount: t.rejected_count,
        citations,
        hiddenCitations: hidden,
        helpful: t.helpful,
        createdAt: t.created_at,
      };
    });
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      turns: turnList.length,
      turnList,
    };
  });
}

export interface TurnToStore {
  question: string;
  answer: string;
  abstained: boolean;
  mode: 'generated' | 'evidence-only';
  scope: RetrievalScope;
  scopeSize: number;
  rejectedCount: number;
  citations: readonly Citation[];
}

/**
 * Appends a turn, creating the conversation when none is named. The conversation must
 * belong to the actor: RLS returns no row otherwise and the turn is refused rather than
 * attached to someone else's thread.
 */
export async function storeTurn(
  actorId: string,
  conversationId: string | null,
  turn: TurnToStore,
): Promise<{ conversationId: string; turnId: string }> {
  return withActor(actorId, async ({ client }) => {
    let id = conversationId;
    if (id) {
      const owned = await client.query(
        'UPDATE app.ai_conversations SET updated_at=now() WHERE id=$1 RETURNING id',
        [id],
      );
      if (owned.rowCount !== 1) throw new InputError('Percakapan tidak ditemukan.');
    } else {
      const title = turn.question.replace(/\s+/g, ' ').slice(0, 120);
      const created = await client.query<{ id: string }>(
        'INSERT INTO app.ai_conversations(user_id,title) VALUES(app.actor_id(),$1) RETURNING id',
        [title],
      );
      id = created.rows[0]!.id;
    }
    const citations = turn.citations.slice(0, 20);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO app.ai_turns(conversation_id,question,answer,abstained,mode,scope,scope_size,
        rejected_count,citation_count)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,
      [
        id,
        turn.question,
        turn.answer.slice(0, 20000),
        turn.abstained,
        turn.mode,
        JSON.stringify(turn.scope),
        turn.scopeSize,
        turn.rejectedCount,
        citations.length,
      ],
    );
    const turnId = inserted.rows[0]!.id;
    // A question the corpus could not answer is the same signal as a search with no
    // results. Stored the same way: normalised (identifying strings dropped in SQL),
    // reported only above the k-anonymity threshold of app.knowledge_gaps.
    if (turn.abstained)
      await client.query(
        `INSERT INTO app.search_events(actor_id,result_count,duration_ms,query_norm,source)
         VALUES(app.actor_id(),0,0,app.normalise_query($1),'assistant_abstained')`,
        [turn.question],
      );
    for (const [i, c] of citations.entries())
      await client.query(
        `INSERT INTO app.ai_turn_citations(turn_id,position,document_id,version_id,snippet,heading,anchor)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          turnId,
          i + 1,
          c.documentId,
          c.versionId,
          c.snippet.slice(0, 4000),
          c.heading?.slice(0, 300) ?? null,
          c.anchor?.slice(0, 300) ?? null,
        ],
      );
    return { conversationId: id, turnId };
  });
}

/**
 * Records the owner's vote on one of their turns. RLS makes a foreign turn invisible, so
 * the update matches nothing and the vote is refused rather than misattributed. An
 * unhelpful answer is also recorded as a gap signal, like an abstention.
 */
export async function voteTurn(
  actorId: string,
  turnId: string,
  helpful: boolean,
): Promise<boolean> {
  return withActor(actorId, async ({ client }) => {
    const updated = await client.query<{ question: string; previous: boolean | null }>(
      `UPDATE app.ai_turns t SET helpful=$2
       FROM (SELECT id,helpful AS previous FROM app.ai_turns WHERE id=$1) old
       WHERE t.id=old.id RETURNING t.question,old.previous`,
      [turnId, helpful],
    );
    const row = updated.rows[0];
    if (!row) return false;
    await client.query(
      'INSERT INTO app.audit_events(actor_id,action,request_id) VALUES(app.actor_id(),$1,$2)',
      [helpful ? 'rag.answer_helpful' : 'rag.answer_unhelpful', randomUUID()],
    );
    if (!helpful && row.previous !== false)
      await client.query(
        `INSERT INTO app.search_events(actor_id,result_count,duration_ms,query_norm,source)
         VALUES(app.actor_id(),0,0,app.normalise_query($1),'assistant_unhelpful')`,
        [row.question],
      );
    return true;
  });
}

/**
 * The WeKnora session behind a conversation, if it is still safe to continue: null when
 * the conversation has none yet, and null (with the old id in `staleSessionId`) when an
 * earlier turn cites a version the owner can no longer read -- then the model's history
 * would carry text from a document that is now out of reach, so the caller discards it
 * and starts a fresh session. `previousQuestion` is the question of the last turn that
 * was answered from sources, for a follow-up that carries no subject of its own
 * (isContinuation in core/rag).
 */
export async function conversationContext(
  actorId: string,
  conversationId: string,
): Promise<{
  sessionId: string | null;
  /** The session that must be discarded because an earlier citation became unreadable. */
  staleSessionId: string | null;
  previousQuestion: string | null;
}> {
  return withActor(actorId, async ({ client }) => {
    const head = await client.query<{ weknora_session_id: string | null }>(
      'SELECT weknora_session_id FROM app.ai_conversations WHERE id=$1',
      [conversationId],
    );
    if (!head.rows[0]) return { sessionId: null, staleSessionId: null, previousQuestion: null };
    const hidden = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.ai_turns t
        WHERE t.conversation_id=$1
          AND t.citation_count > (SELECT count(*) FROM app.ai_turn_citations x
                                    JOIN app.document_versions v ON v.id=x.version_id
                                   WHERE x.turn_id=t.id AND app.can_read_version(v.id))`,
      [conversationId],
    );
    // The last turn that was actually answered from sources: "jelaskan lebih lengkap"
    // refers to that, not to an abstained question in between.
    const previous = await client.query<{ question: string }>(
      'SELECT question FROM app.ai_turns WHERE conversation_id=$1 AND citation_count>0 ORDER BY created_at DESC,id DESC LIMIT 1',
      [conversationId],
    );
    const stale = Number(hidden.rows[0]?.n ?? 0) > 0;
    const current = head.rows[0].weknora_session_id;
    return {
      sessionId: stale ? null : current,
      staleSessionId: stale ? current : null,
      previousQuestion: previous.rows[0]?.question ?? null,
    };
  });
}

export async function setConversationSession(
  actorId: string,
  conversationId: string,
  sessionId: string | null,
): Promise<void> {
  await withActor(actorId, async ({ client }) => {
    await client.query('UPDATE app.ai_conversations SET weknora_session_id=$2 WHERE id=$1', [
      conversationId,
      sessionId,
    ]);
  });
}

export async function deleteConversation(
  actorId: string,
  conversationId: string,
): Promise<{ deleted: boolean; sessionId: string | null }> {
  return withActor(actorId, async ({ client }) => {
    const r = await client.query<{ weknora_session_id: string | null }>(
      'DELETE FROM app.ai_conversations WHERE id=$1 RETURNING weknora_session_id',
      [conversationId],
    );
    return { deleted: r.rowCount === 1, sessionId: r.rows[0]?.weknora_session_id ?? null };
  });
}

export interface RelatedDocument {
  documentId: string;
  slug: string;
  title: string;
  summary: string;
  categoryName: string;
  /** The WeKnora knowledge id of the current version, when it is indexed. */
  knowledgeId: string | null;
}

/**
 * Documents the actor may read whose title, summary or indexed text matches the
 * question, best first -- what the assistant offers next to an abstention, and what a
 * catalogue question ("ada dokumen lain tentang VPN?") lists. Same lexical index as the
 * search page, but this is not a search: nothing is written to app.search_events.
 * With an empty query it lists the newest published documents instead.
 */
export async function relatedDocuments(
  actorId: string,
  query: string,
  limit = 5,
): Promise<RelatedDocument[]> {
  return withActor(actorId, async ({ client }) => {
    const q = query
      .replace(/[?!.,;:"']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const { rows } = await client.query<{
      id: string;
      slug: string;
      title: string;
      summary: string;
      category_name: string;
      knowledge_id: string | null;
    }>(
      `SELECT d.id,d.slug,v.title,v.summary,c.name AS category_name,e.knowledge_id
         FROM app.documents d
         JOIN app.document_versions v ON v.id=d.current_version_id
         JOIN app.categories c ON c.id=v.category_id
         LEFT JOIN app.rag_index_entries e ON e.version_id=v.id
         LEFT JOIN LATERAL(SELECT max(ts_rank(ch.search_vector,websearch_to_tsquery('simple',$1))) AS rank
                             FROM app.lexical_chunks ch
                            WHERE $1<>'' AND ch.version_id=v.id AND ch.search_vector@@websearch_to_tsquery('simple',$1)) hit ON true
        WHERE app.is_active_version(v.id)
          AND ($1='' OR position(lower($1) in lower(v.title||' '||v.summary))>0 OR hit.rank IS NOT NULL)
        ORDER BY (CASE WHEN $1<>'' AND position(lower($1) in lower(v.title))>0 THEN 1 ELSE 0 END) DESC,
                 coalesce(hit.rank,0) DESC, v.created_at DESC
        LIMIT $2`,
      [q, limit],
    );
    return rows.map((r) => ({
      documentId: r.id,
      slug: r.slug,
      title: r.title,
      summary: r.summary,
      categoryName: r.category_name,
      knowledgeId: r.knowledge_id,
    }));
  });
}
