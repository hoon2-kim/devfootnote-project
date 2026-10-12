import { isDatabaseUnavailable } from '../../../infrastructure/database/database-error.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { MaterialsError } from '../domain/materials.error.js';

// 조회와 원자 쓰기가 같은 업무 오류·비공개 DB 오류 정책을 사용한다.
export async function withMaterialsErrorBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MaterialsError) {
      throw error;
    }

    if (isDatabaseUnavailable(error)) {
      logger.error('자료 저장소에 일시적으로 접근할 수 없습니다.');

      throw new MaterialsError('unavailable');
    }

    logger.error('자료 저장소 작업에 실패했습니다.');

    throw new Error('자료 저장소 내부 오류');
  }
}
