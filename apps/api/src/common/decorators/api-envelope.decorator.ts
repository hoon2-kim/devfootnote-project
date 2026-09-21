import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

export function ApiEnvelope(dto: Type<unknown>, status = 200) {
  return applyDecorators(
    ApiExtraModels(dto),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: { $ref: getSchemaPath(dto) },
        },
      },
    }),
  );
}
