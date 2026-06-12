import { eq } from 'drizzle-orm';
import { tasks, type HubDb } from '../persistence/db.js';

/** When all children are `done`, mark parent `done` and recurse upward. */
export function maybeAutocompleteParent(db: HubDb, completedChildId: string): void {
  const child = db.select().from(tasks).where(eq(tasks.id, completedChildId)).get();
  if (!child?.parentTaskId) return;

  const parentId = child.parentTaskId;
  const siblings = db.select().from(tasks).where(eq(tasks.parentTaskId, parentId)).all();
  if (siblings.length === 0) return;
  if (!siblings.every((s) => s.status === 'done')) return;

  const now = new Date();
  db.update(tasks)
    .set({
      status: 'done',
      updatedAt: now,
      ownerAgentId: null,
      leaseExpiresAt: null,
    })
    .where(eq(tasks.id, parentId))
    .run();

  maybeAutocompleteParent(db, parentId);
}
