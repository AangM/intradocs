import { CLASSIFICATIONS, ROLES } from './index.ts';
import { InputError, parseUuid } from './validation.ts';
import { objectInput, boundedText } from './workflow.ts';
export function positiveInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new InputError(`Angka harus ${min}–${max}.`);
  return value;
}
export function parseCategory(value: unknown) {
  const v = objectInput(value, [
    'id',
    'revision',
    'parentId',
    'name',
    'description',
    'minimumClassification',
    'approvalSteps',
    'reviewDays',
    'position',
    'confirmTightening',
  ]);
  if (
    !(CLASSIFICATIONS as readonly unknown[]).includes(v.minimumClassification) ||
    typeof v.confirmTightening !== 'boolean'
  )
    throw new InputError('Aturan kategori tidak valid.');
  const id = v.id === null ? null : parseUuid(v.id),
    parentId = v.parentId === null ? null : parseUuid(v.parentId);
  if (id !== null && id === parentId)
    throw new InputError('Kategori tidak boleh menjadi induk dirinya sendiri.');
  return {
    id,
    revision: positiveInteger(v.revision, 0, 1000000),
    parentId,
    name: boundedText(v.name, 3, 100, 'Nama kategori'),
    description: boundedText(v.description ?? '', 0, 500, 'Deskripsi'),
    minimumClassification: v.minimumClassification as string,
    approvalSteps: positiveInteger(v.approvalSteps, 1, 2),
    reviewDays: positiveInteger(v.reviewDays, 1, 3650),
    position: positiveInteger(v.position, 0, 10000),
    confirmTightening: v.confirmTightening,
  };
}
export function parseLabel(value: unknown) {
  const v = objectInput(value, ['id', 'revision', 'categoryId', 'name', 'color', 'remove']);
  if (
    !['blue', 'green', 'amber', 'red', 'violet', 'grey'].includes(String(v.color)) ||
    typeof v.remove !== 'boolean'
  )
    throw new InputError('Label tidak valid.');
  return {
    id: v.id === null ? null : parseUuid(v.id),
    revision: positiveInteger(v.revision, 0, 1000000),
    categoryId: parseUuid(v.categoryId),
    name: boundedText(v.name, 3, 32, 'Nama label'),
    color: v.color as string,
    remove: v.remove,
  };
}
export function parseAssignment(value: unknown) {
  const v = objectInput(value, ['role', 'scopeAll', 'categoryIds']);
  if (
    !(ROLES as readonly unknown[]).includes(v.role) ||
    typeof v.scopeAll !== 'boolean' ||
    !Array.isArray(v.categoryIds) ||
    v.categoryIds.length > 100
  )
    throw new InputError('Penugasan tidak valid.');
  const categoryIds = [...new Set(v.categoryIds.map(parseUuid))];
  if (v.scopeAll && categoryIds.length > 0)
    throw new InputError('Scope global tidak boleh sekaligus memuat kategori khusus.');
  return { role: v.role as string, scopeAll: v.scopeAll, categoryIds };
}
