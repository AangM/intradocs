import { pgSchema, text, boolean, uuid, integer, timestamp } from 'drizzle-orm/pg-core';
export const appSchema = pgSchema('app');
export const profiles = appSchema.table('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  unit: text('unit').notNull(),
  role: text('role').notNull(),
  active: boolean('active').notNull(),
  scopeAll: boolean('scope_all').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const categories = appSchema.table('categories', {
  id: uuid('id').primaryKey(),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  description: text('description').notNull(),
  icon: text('icon').notNull(),
  color: text('color').notNull(),
  position: integer('position').notNull(),
});
// SQL migrations own RLS, immutable-version constraints and indexes. Do not use drizzle push.
