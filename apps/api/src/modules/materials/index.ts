export { MaterialsModule } from './materials.module.js';
export { MaterialsService } from './application/materials.service.js';
export { MaterialsError } from './domain/materials.error.js';
export type {
  CreateMaterialInput,
  UpdateMaterialInput,
  DeleteMaterialInput,
  MaterialSummary,
  MaterialDetail,
} from './application/materials.types.js';
export type { MaterialMutationResult, MaterialPage } from './application/materials.types.js';
export type { MaterialSearchCandidate } from './application/materials.types.js';
