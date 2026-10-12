import { Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { createHash } from 'node:crypto';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { AnswerUsageService } from '../usage-retention/index.js';
import { SearchService } from '../search/index.js';
import { MaterialsService, MaterialsError } from '../materials/index.js';
import { AnswersRepository } from './answers.repository.js';
import { AnswerError, type AnswerCommand } from './answers.types.js';

@Injectable()
export class AnswersService {
  constructor(
    private readonly repository: AnswersRepository,
    private readonly usage: AnswerUsageService,
    private readonly search: SearchService,
    private readonly materials: MaterialsService,
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  async configuration(ownerId: string) {
    const policy = this.usage.configuration();
    const consent = await this.usage.consent(ownerId);

    return {
      configured: policy !== null,
      policy,
      consentEpoch: consent.epoch,
      consented: Boolean(policy && consent.granted && consent.fingerprint === policy.fingerprint),
    };
  }

  grant(ownerId: string, epoch: number, fingerprint: string) {
    return this.usage.grant(ownerId, epoch, fingerprint);
  }
  revoke(ownerId: string, epoch: number) {
    return this.usage.revoke(ownerId, epoch);
  }

  @Transactional(Propagation.Never)
  async generate(ownerId: string, command: AnswerCommand) {
    const question = command.question.trim();
    const targets = [...command.evidence].sort((a, b) => a.materialId.localeCompare(b.materialId));

    if (!question || new Set(targets.map((target) => target.materialId)).size !== targets.length) {
      throw new AnswerError('conflict');
    }

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          'answer-v1',
          command.requestId,
          question,
          targets,
          ...(command.history?.length ? [command.history] : []),
        ]),
      )
      .digest('hex');

    await this.transactions.withTransaction(async () => {
      // 계정의 답변 동의 행이 admission과 같은 request ID 경쟁을 직렬화한다.
      const consent = await this.usage.lockConsent(ownerId);
      const previous = await this.repository.read(ownerId, command.requestId);

      if (previous) {
        if (previous.request.fingerprint !== fingerprint) {
          throw new AnswerError('conflict');
        }

        return;
      }

      const policy = this.usage.configuration();

      if (!policy) {
        throw new AnswerError('not_configured');
      }

      if (!consent.granted || consent.fingerprint !== policy.fingerprint) {
        throw new AnswerError('consent_required');
      }

      // 과거 답변은 클라이언트가 보내는 본문을 믿지 않고 같은 owner·자료·버전의 게시 결과만 읽는다.
      const history: { question: string; answer: string }[] = [];

      for (const turn of command.history ?? []) {
        const previous = await this.repository.read(ownerId, turn.requestId);

        if (
          targets.length !== 1 ||
          !previous ||
          !previous.answerLive ||
          previous.request.state !== 'PUBLISHED' ||
          previous.request.consentEpoch !== consent.epoch ||
          previous.request.configFingerprint !== policy.fingerprint ||
          previous.request.evidence.length === 0 ||
          previous.request.evidence.some(
            (item) =>
              item.materialId !== targets[0]?.materialId ||
              item.revisionId !== targets[0]?.revisionId,
          )
        ) {
          throw new AnswerError('evidence_unavailable');
        }

        history.push({
          question: turn.question,
          answer: (previous.request.claims ?? []).map((claim) => claim.text).join('\n'),
        });
      }

      let contextualQuestion = history.length ? JSON.stringify({ question, history }) : question;

      // 대화 길이가 예산을 무한히 늘리지 않게 오래된 턴부터 제외한다. 직전 문맥도 넣을 수 없으면 거부한다.
      while (Buffer.byteLength(contextualQuestion, 'utf8') > 20_000 && history.length > 1) {
        history.shift();
        contextualQuestion = JSON.stringify({ question, history });
      }

      if (Buffer.byteLength(contextualQuestion, 'utf8') > 20_000) {
        throw new AnswerError('conflict');
      }

      // 자료 하나에 직접 묻는 경우 임베딩 준비는 필요 없다. 현재 원문에서 제한된 근거를 고른다.
      const chunks = await this.search.snapshotAnswerEvidence(
        ownerId,
        contextualQuestion,
        targets,
        { requireIndex: targets.length !== 1 },
      );

      if (chunks.length === 0) {
        throw new AnswerError('evidence_unavailable');
      }

      const evidence = chunks.map((chunk, index) => ({
        evidenceId: `e${index + 1}`,
        materialId: chunk.materialId,
        revisionId: chunk.revisionId,
        chunkId: chunk.chunkId,
        contentHash: createHash('sha256').update(chunk.text).digest('hex'),
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      }));
      const reservationId = await this.usage.reserve(
        ownerId,
        command.requestId,
        fingerprint,
        consent.epoch,
        policy,
      );

      await this.repository.reserve({
        ownerId,
        requestId: command.requestId,
        fingerprint,
        question: contextualQuestion,
        evidence,
        reservationId,
        consentEpoch: consent.epoch,
        policy,
      });
    });

    return this.read(ownerId, command.requestId);
  }

  @Transactional()
  async read(ownerId: string, requestId: string) {
    const consent = await this.usage.lockConsent(ownerId);
    const found = await this.repository.read(ownerId, requestId);

    if (!found) {
      throw new AnswerError('not_found');
    }

    const { request } = found;
    let state = request.state;
    let failure = request.failure;

    if ((state === 'PUBLISHED' || state === 'NO_ANSWER') && request.evidence.length === 0) {
      state = failure === 'expired' ? 'EXPIRED' : 'INVALIDATED';
    } else if (
      !consent.granted ||
      consent.epoch !== request.consentEpoch ||
      consent.fingerprint !== request.configFingerprint ||
      this.usage.configuration()?.fingerprint !== request.configFingerprint
    ) {
      state = 'INVALIDATED';
      failure = 'consent_changed';
    } else if (
      ((state === 'PUBLISHED' || state === 'NO_ANSWER') && !found.answerLive) ||
      ((state === 'RESERVED' || state === 'RUNNING') && !found.executionLive)
    ) {
      state = 'EXPIRED';
      failure = 'expired';
    } else if (
      state === 'PUBLISHED' ||
      state === 'NO_ANSWER' ||
      state === 'RESERVED' ||
      state === 'RUNNING'
    ) {
      const targets = [
        ...new Map(
          request.evidence.map((item) => [
            item.materialId,
            { materialId: item.materialId, revisionId: item.revisionId },
          ]),
        ).values(),
      ];
      const chunks = await this.materials
        .lockAnswerEvidence(ownerId, targets)
        .catch((error: unknown) => {
          if (
            error instanceof MaterialsError &&
            (error.kind === 'not_found' || error.kind === 'revision_conflict')
          ) {
            return null;
          }

          throw error;
        });

      if (
        !chunks ||
        request.evidence.some(
          (item) =>
            !chunks.some(
              (chunk) =>
                chunk.chunkId === item.chunkId &&
                chunk.startOffset === item.startOffset &&
                chunk.endOffset === item.endOffset &&
                createHash('sha256').update(chunk.text).digest('hex') === item.contentHash,
            ),
        )
      ) {
        state = 'INVALIDATED';
        failure = 'evidence_changed';
      }

      const afterLocks = await this.repository.read(ownerId, requestId);

      if (
        !afterLocks ||
        ((state === 'PUBLISHED' || state === 'NO_ANSWER') && !afterLocks.answerLive) ||
        ((state === 'RESERVED' || state === 'RUNNING') && !afterLocks.executionLive)
      ) {
        state = 'EXPIRED';
        failure = 'expired';
      }
    }

    const visible = state === 'PUBLISHED';
    const claims = visible ? (request.claims ?? []) : [];
    const used = new Set(claims.flatMap((claim) => claim.evidenceIds));

    return {
      requestId,
      state,
      failure,
      claims,
      citations: visible
        ? request.evidence
            .filter((item) => used.has(item.evidenceId))
            .map((item) => ({
              evidenceId: item.evidenceId,
              materialId: item.materialId,
              revisionId: item.revisionId,
              chunkId: item.chunkId,
              startOffset: item.startOffset,
              endOffset: item.endOffset,
              href: `/documents/${item.materialId}?revision=${item.revisionId}#source-title`,
            }))
        : [],
      answerExpiresAt:
        state === 'PUBLISHED' || state === 'NO_ANSWER'
          ? (request.answerExpiresAt?.toISOString() ?? null)
          : null,
    };
  }
}
