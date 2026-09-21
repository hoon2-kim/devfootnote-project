export class MaterialsError extends Error {
  constructor(readonly kind: 'conflict' | 'revision_conflict' | 'not_found' | 'unavailable') {
    super('자료 작업을 완료하지 못했습니다.');
  }
}
