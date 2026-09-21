import type { Request } from 'express';

// 파싱된 req.body 대신 전송 헤더로 판단해야 비 JSON 본문도 인증 경계에서 거부할 수 있다.
export function hasBodyHeaders(req: Pick<Request, 'headers'>): boolean {
  return (
    Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined
  );
}
