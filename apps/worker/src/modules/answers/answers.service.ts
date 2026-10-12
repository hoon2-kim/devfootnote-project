import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InjectTransactionHost,
  TransactionHost,
  Transactional,
  Propagation,
} from '@nestjs-cls/transactional';
import { createHash, randomUUID } from 'node:crypto';
import {
  GeminiAnswer,
  AnswerProviderError,
  isSafeAnswerClaim,
  type AnswerCandidate,
  type AnswerPolicy,
} from '@devfootnote/ai';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { MaterialsService } from '../materials/index.js';
import { AnswerUsageService } from '../usage-retention/index.js';
import { AnswersRepository } from './answers.repository.js';

type AnswerRequest = NonNullable<Awaited<ReturnType<AnswersRepository['read']>>>;

@Injectable()
export class AnswersService {
  constructor(
    private readonly repository: AnswersRepository,
    private readonly usage: AnswerUsageService,
    private readonly materials: MaterialsService,
    private readonly config: ConfigService,
    @Inject(GeminiAnswer) private readonly provider: GeminiAnswer | null,
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  @Transactional('worker', Propagation.Never)
  async process(ownerId: string, requestId: string, signal?: AbortSignal) {
    const started = await this.transactions.withTransaction(() => this.start(ownerId, requestId));

    if (!started || !this.provider) {
      return;
    }

    let candidate: AnswerCandidate;

    try {
      candidate = await this.provider.generate(started.input, signal);
    } catch (error) {
      const failure = error instanceof AnswerProviderError ? error.kind : 'unknown_outcome';

      await this.transactions.withTransaction(() =>
        this.complete(
          ownerId,
          requestId,
          started.attemptId,
          null,
          failure,
          error instanceof AnswerProviderError ? error.usage : null,
        ),
      );

      return;
    }

    // 게시 DB 실패를 provider 실패로 바꿔 다시 호출하지 않는다. STARTED는 복구 경로가 보수 정산한다.
    await this.transactions.withTransaction(() =>
      this.complete(ownerId, requestId, started.attemptId, candidate, null),
    );
  }

  private async fences(reference: AnswerRequest) {
    const consent = await this.usage.lockConsent(reference.ownerId);
    const targets = [
      ...new Map(
        reference.evidence.map((item) => [
          item.materialId,
          { materialId: item.materialId, revisionId: item.revisionId },
        ]),
      ).values(),
    ];
    const chunks = await this.materials.lockAnswerEvidence(reference.ownerId, targets);
    const reservation = reference.reservationId
      ? await this.usage.lockReservation(reference.ownerId, reference.reservationId)
      : null;
    const policy = this.config.get<AnswerPolicy | null>('answerPolicy');
    const validConsent = Boolean(
      policy &&
      policy.fingerprint === reference.configFingerprint &&
      consent?.granted &&
      consent.epoch === reference.consentEpoch &&
      consent.fingerprint === reference.configFingerprint,
    );
    const validEvidence =
      reference.evidence.length > 0 &&
      chunks !== null &&
      reference.evidence.every((item) =>
        chunks.some(
          (chunk) =>
            chunk.chunkId === item.chunkId &&
            chunk.startOffset === item.startOffset &&
            chunk.endOffset === item.endOffset &&
            createHash('sha256').update(chunk.text).digest('hex') === item.contentHash,
        ),
      );

    return {
      chunks,
      reservation,
      failure: !validConsent
        ? 'consent_changed'
        : !validEvidence
          ? 'evidence_changed'
          : !reservation?.active ||
              reservation.consentEpoch !== reference.consentEpoch ||
              reservation.fingerprint !== reference.configFingerprint
            ? 'reservation_expired'
            : null,
    };
  }

  private async start(ownerId: string, requestId: string) {
    const reference = await this.repository.read(ownerId, requestId);

    if (!reference) {
      return null;
    }

    const fences = await this.fences(reference);
    const locked = await this.repository.lock(ownerId, requestId);

    if (!locked) {
      return null;
    }

    const { request } = locked;

    if (request.state !== 'RESERVED' && request.state !== 'RUNNING') {
      if (
        request.evidence.length > 0 &&
        (!locked.answerLive || (fences.failure && fences.failure !== 'reservation_expired'))
      ) {
        await this.repository.clearContent(
          ownerId,
          requestId,
          !locked.answerLive ? 'expired' : (fences.failure ?? 'evidence_changed'),
        );
      }

      if (
        !locked.dedupeLive &&
        request.reservationId &&
        (await this.usage.receiptExpired(ownerId, request.reservationId))
      ) {
        await this.repository.deleteReceipt(ownerId, requestId);
        await this.usage.deleteReceipt(ownerId, request.reservationId);
      }

      return null;
    }

    if (!locked.live || fences.failure) {
      await this.repository.finish(
        ownerId,
        requestId,
        !locked.live || fences.failure === 'reservation_expired' ? 'EXPIRED' : 'INVALIDATED',
        fences.failure ?? 'expired',
        null,
        'UNKNOWN',
      );

      if (request.reservationId) {
        await this.usage.settle(ownerId, request.reservationId, null);
      }

      return null;
    }

    // RUNNING은 호출 가능성이 이미 기록된 상태다. 재기동·중복 회차에서 재호출하지 않는다.
    if (
      request.state === 'RUNNING' ||
      !request.question ||
      !fences.chunks ||
      !request.reservationId ||
      !this.provider
    ) {
      return null;
    }

    const attemptId = randomUUID();
    const started = await this.repository.start(ownerId, requestId, attemptId);

    if (!started || !(await this.usage.expose(ownerId, request.reservationId))) {
      throw new Error('답변 호출 시작을 확정하지 못했습니다.');
    }

    return {
      attemptId,
      input: {
        question: request.question,
        evidence: request.evidence.map((item) => ({
          evidenceId: item.evidenceId,
          text: fences.chunks?.find((chunk) => chunk.chunkId === item.chunkId)?.text ?? '',
        })),
      },
    };
  }

  private async complete(
    ownerId: string,
    requestId: string,
    attemptId: string,
    candidate: AnswerCandidate | null,
    failure: string | null,
    failureUsage: AnswerCandidate['usage'] = null,
  ) {
    const reference = await this.repository.read(ownerId, requestId);

    if (!reference) {
      return;
    }

    const fences = await this.fences(reference);
    const locked = await this.repository.lock(ownerId, requestId);
    const attempt = await this.repository.attempt(ownerId, requestId, attemptId);

    if (!locked || locked.request.state !== 'RUNNING' || attempt?.state !== 'STARTED') {
      return;
    }

    const { request } = locked;
    // request lock 대기 중 예약이 만료될 수 있어 모든 잠금 취득 뒤에 다시 확인한다.
    const currentReservation = request.reservationId
      ? await this.usage.lockReservation(ownerId, request.reservationId)
      : null;

    if (!currentReservation?.active && !fences.failure) {
      fences.failure = 'reservation_expired';
    }

    const ids = new Set(request.evidence.map((item) => item.evidenceId));
    const valid =
      candidate &&
      candidate.insufficientEvidence === (candidate.claims.length === 0) &&
      candidate.claims.length <= 12 &&
      candidate.claims.every(
        (claim) =>
          claim.text.trim().length > 0 &&
          claim.text.length <= 2000 &&
          claim.evidenceIds.length > 0 &&
          claim.evidenceIds.every((id) => ids.has(id)) &&
          isSafeAnswerClaim(claim.text),
      );
    const state = !locked.live
      ? 'EXPIRED'
      : fences.failure
        ? 'INVALIDATED'
        : !valid
          ? 'FAILED'
          : candidate.insufficientEvidence
            ? 'NO_ANSWER'
            : 'PUBLISHED';

    await this.repository.finish(
      ownerId,
      requestId,
      state,
      !locked.live
        ? 'expired'
        : (fences.failure ?? failure ?? (!valid ? 'invalid_response' : null)),
      state === 'PUBLISHED' && candidate ? candidate.claims : null,
      candidate ? 'SUCCEEDED' : failure === 'unknown_outcome' ? 'UNKNOWN' : 'FAILED',
    );

    if (request.reservationId) {
      await this.usage.settle(ownerId, request.reservationId, candidate?.usage ?? failureUsage);
    }
  }

  @Transactional('worker', Propagation.Never)
  async sweep(signal?: AbortSignal) {
    const batch = await this.transactions.withTransaction(() => this.repository.reserveBatch());

    for (const item of batch) {
      if (signal?.aborted) {
        break;
      }

      await this.process(item.ownerId, item.requestId, signal);
    }

    return batch.length;
  }
}
