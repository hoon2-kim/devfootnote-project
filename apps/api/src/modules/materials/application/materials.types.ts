import type { PageResult } from '../../../common/pagination/page-result.js';
import type { MaterialContentInput } from '../domain/material.types.js';

export interface CreateMaterialInput extends MaterialContentInput {
  idempotencyKey: string;
}

export interface MaterialSummary {
  id: string;
  revisionId: string;
  revision: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MaterialDetail extends MaterialSummary {
  body: string;
  note: string | null;
  context: string | null;
  sourceUrl: string | null;
}

export interface MaterialMutationResult {
  id: string;
  revisionId: string;
}

export interface MaterialPage extends PageResult<MaterialSummary> {
  page: number;
}

export interface UpdateMaterialInput extends CreateMaterialInput {
  expectedRevisionId: string;
}

export interface DeleteMaterialInput {
  idempotencyKey: string;
  expectedRevisionId: string;
}

export type MaterialSearchCandidate = Omit<MaterialDetail, 'createdAt'>;
