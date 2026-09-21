import { z } from 'zod';

const pageSchema = z.coerce.number().int().min(1).max(100000).catch(1);

export function parsePage(value: string | string[] | undefined) {
  return pageSchema.parse(value);
}
