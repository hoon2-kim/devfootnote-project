'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { readAnswerEvents } from '@devfootnote/api-client';
import { useApiClient } from '../../lib/api-provider';

export function answerResultKey(ownerId: string, requestId: string, consentEpoch?: number) {
  return ['private', ownerId, 'answers', 'results', requestId, consentEpoch];
}

// SSE는 게시된 상태만 전달한다. 연결 복구가 생성 POST나 검증 전 토큰 공개로 이어지지 않는다.
export function useAnswerEvents({
  ownerId,
  requestId,
  consentEpoch,
  enabled,
}: {
  ownerId: string;
  requestId?: string;
  consentEpoch?: number;
  enabled: boolean;
}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [failedRequest, setFailedRequest] = useState<string>();
  const [connection, setConnection] = useState(0);

  useEffect(() => {
    if (!enabled || !requestId) {
      return;
    }

    const controller = new AbortController();
    let terminal = false;
    let failed = false;

    setFailedRequest(undefined);

    const receive = async () => {
      try {
        const events = await readAnswerEvents({
          client,
          path: { requestId },
          signal: controller.signal,
          sseMaxRetryAttempts: 1,
          onSseEvent: (event) => {
            if (event.event === 'error') {
              failed = true;
            }
          },
        });

        for await (const answer of events.stream) {
          if (controller.signal.aborted || failed) {
            break;
          }

          queryClient.setQueryData(answerResultKey(ownerId, requestId, consentEpoch), answer);
          terminal = !['REQUESTED', 'RESERVED', 'RUNNING'].includes(answer.state);

          if (terminal) {
            break;
          }
        }
      } catch {
        // 원본 네트워크 오류를 노출하지 않고 같은 답변의 명시적 재조회만 제공한다.
      } finally {
        const disconnected = !terminal && !controller.signal.aborted;

        controller.abort();

        if (disconnected) {
          setFailedRequest(requestId);
        }
      }
    };

    void receive();

    return () => controller.abort();
  }, [client, queryClient, ownerId, requestId, consentEpoch, enabled, connection]);

  return {
    disconnected: enabled && failedRequest === requestId,
    reconnect: () => setConnection((value) => value + 1),
  };
}
