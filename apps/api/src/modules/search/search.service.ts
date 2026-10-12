import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Transactional, Propagation } from '@nestjs-cls/transactional';
import {
  GeminiEmbedding,
  geminiEmbeddingDimensions,
  geminiEmbeddingModel,
  geminiEmbeddingInputVersion,
} from '@devfootnote/ai';
import { MaterialsService } from '../materials/index.js';
import { EmbeddingQueryService } from '../indexing/index.js';
import { UsageService, UsageError } from '../usage-retention/index.js';
import { createSearchSnippet } from './search-snippet.js';
import type {
  SearchItem,
  SearchResult,
  SemanticMode,
  SemanticDegradedReason,
  SemanticSearchResult,
} from './search.types.js';

@Injectable()
export class SearchService {
  constructor(
    private readonly materials: MaterialsService,
    private readonly usage: UsageService,
    private readonly indexing: EmbeddingQueryService,
    private readonly config: ConfigService,
  ) {}

  @Transactional(Propagation.Mandatory)
  async snapshotAnswerEvidence(
    ownerId: string,
    question: string,
    targets: { materialId: string; revisionId: string }[],
    options: { requireIndex: boolean } = { requireIndex: true },
  ) {
    if (options.requireIndex) {
      const policy = this.usage.configuration();
      const consent = await this.usage.consent(ownerId);

      if (!policy || !consent.granted || consent.configFingerprint !== policy.fingerprint) {
        return [];
      }

      const published = await this.indexing.publishedReferences(
        ownerId,
        policy.fingerprint,
        consent.epoch,
      );

      if (
        targets.some(
          (target) =>
            !published.some(
              (item) =>
                item.materialId === target.materialId && item.revisionId === target.revisionId,
            ),
        )
      ) {
        return [];
      }
    }

    const chunks = await this.materials.lockAnswerEvidence(ownerId, targets);
    const tokens = question.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);

    // 사용자가 선택한 검색 결과만 사용한다. 자료당 최대 두 chunk로 전송 범위를 제한한다.
    // 질문 재임베딩이나 숨은 provider 호출 없이 일치 토큰 수와 원문 순서로 선택한다.
    return targets.flatMap((target) =>
      chunks
        .filter((chunk) => chunk.materialId === target.materialId)
        .map((chunk) => ({
          chunk,
          score: tokens.filter((token) =>
            chunk.text.normalize('NFKC').toLowerCase().includes(token),
          ).length,
        }))
        .sort((a, b) => b.score - a.score || a.chunk.startOffset - b.chunk.startOffset)
        .slice(0, 2)
        .map(({ chunk }) => chunk),
    );
  }

  @Transactional(Propagation.Never)
  async semantic(
    ownerId: string,
    input: { q: string; mode: SemanticMode; requestId: string },
  ): Promise<SemanticSearchResult> {
    const query = input.q.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
    const key = this.config.get<string>('geminiApiKey');
    const policy = this.usage.configuration();

    if (
      !key ||
      !policy ||
      policy.dimensions !== geminiEmbeddingDimensions ||
      policy.model !== geminiEmbeddingModel ||
      policy.inputVersion !== geminiEmbeddingInputVersion ||
      !query
    ) {
      return this.fallback(ownerId, query, input.mode, 'not_configured');
    }

    const consent = await this.usage.consent(ownerId);

    if (!consent.granted || consent.configFingerprint !== policy.fingerprint) {
      return this.fallback(ownerId, query, input.mode, 'consent_required');
    }

    const ready = await this.indexing
      .ready(ownerId, policy.fingerprint, consent.epoch)
      .catch(() => false);

    if (!ready) {
      return this.fallback(ownerId, query, input.mode, 'index_unavailable');
    }

    // 요청마다 다른 salt를 섞어 짧은 검색어의 단순 사전 대조를 어렵게 한다. 원문은 저장하지 않는다.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['query-v1', input.requestId, query, input.mode]))
      .digest('hex');
    const admission = await this.usage
      .beginQuery(ownerId, input.requestId, `query-v1:${fingerprint}`)
      .catch((error: unknown) => {
        return {
          reason:
            error instanceof UsageError && error.kind === 'budget_exhausted'
              ? 'budget_exhausted'
              : 'provider_unavailable',
        } as const;
      });

    if ('reason' in admission) {
      return this.fallback(ownerId, query, input.mode, admission.reason);
    }

    let result: Awaited<ReturnType<GeminiEmbedding['embed']>>;

    try {
      // STARTED에 해당하는 예약 노출 commit이 끝난 후에만 외부 요청을 보낸다.
      result = await new GeminiEmbedding(key).embed([query], 'query');
    } catch {
      await this.usage.settleQuery(ownerId, admission.reservationId, null);

      return this.fallback(ownerId, query, input.mode, 'provider_unavailable');
    }

    const current = await this.usage.settleQuery(ownerId, admission.reservationId, result.tokens);

    if (!current) {
      return this.fallback(ownerId, query, input.mode, 'index_unavailable');
    }

    const vector = result.vectors[0];

    if (
      !vector ||
      vector.some((value) => !Number.isFinite(Math.fround(value))) ||
      !vector.some((value) => Math.fround(value) !== 0)
    ) {
      return this.fallback(ownerId, query, input.mode, 'provider_unavailable');
    }

    return this.readSemantic(
      ownerId,
      query,
      input.mode,
      admission.policy.fingerprint,
      admission.consentEpoch,
      vector,
    ).catch(() => this.fallback(ownerId, query, input.mode, 'index_unavailable'));
  }

  @Transactional()
  private async readSemantic(
    ownerId: string,
    query: string,
    mode: SemanticMode,
    fingerprint: string,
    epoch: number,
    vector: number[],
  ): Promise<SemanticSearchResult> {
    const consent = await this.usage.lockConsent(ownerId);

    if (
      !consent.granted ||
      consent.epoch !== epoch ||
      consent.configFingerprint !== fingerprint ||
      this.usage.configuration()?.fingerprint !== fingerprint
    ) {
      return this.fallback(ownerId, query, mode, 'consent_changed');
    }

    const vectors = await this.indexing.candidates(ownerId, fingerprint, epoch, vector, 51);

    if (vectors.length === 0) {
      return this.fallback(ownerId, query, mode, 'index_unavailable');
    }

    const keyword =
      mode === 'hybrid'
        ? await this.materials.findKeywordCandidates(ownerId, query, 1, 51)
        : { items: [] };
    const scores = new Map<string, { materialId: string; revisionId: string; score: number }>();

    // 각 branch의 chunk들은 indexing에서 best-chunk로 합쳐진다. 화면은 자료/revision당 한 결과를 낸다.
    // 서로 척도가 다른 keyword·cosine 점수를 더하지 않고 순위 기반 RRF(k=60)를 사용한다.
    for (const branch of [vectors, keyword.items]) {
      branch.forEach((item, index) => {
        const identity = `${item.id}:${item.revisionId}`;
        const previous = scores.get(identity);

        scores.set(identity, {
          materialId: item.id,
          revisionId: item.revisionId,
          score: (previous?.score ?? 0) + 1 / (60 + index + 1),
        });
      });
    }

    // 두 branch 사이에 수정/삭제가 일어나도 최종 한 SQL snapshot에서 현재 자료만 남긴다.
    const current = await this.materials.rankedCurrentCandidates(ownerId, [...scores.values()], 51);

    return {
      items: current.slice(0, 50).map((material) => ({
        id: material.id,
        revisionId: material.revisionId,
        revision: material.revision,
        title: material.title,
        updatedAt: material.updatedAt,
        ...createSearchSnippet(material, query.split(' ')),
      })),
      page: 1,
      hasNext: false,
      requestedMode: mode,
      effectiveMode: mode,
      degradedReason: null,
      resultLimit: 50,
      truncated: current.length > 50,
    };
  }

  private async fallback(
    ownerId: string,
    query: string,
    mode: SemanticMode,
    reason: SemanticDegradedReason,
  ): Promise<SemanticSearchResult> {
    const keyword = await this.search(ownerId, query, 1, 50);

    return {
      ...keyword,
      hasNext: false,
      requestedMode: mode,
      effectiveMode: 'keyword',
      degradedReason: reason,
      resultLimit: 50,
      truncated: keyword.hasNext,
    };
  }

  async search(
    ownerId: string,
    input: string,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    const query = input.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');

    if (!query) {
      return { items: [], page, hasNext: false };
    }

    const candidates = await this.materials.findKeywordCandidates(ownerId, query, page, pageSize);
    const tokens = query.split(' ');
    const items = candidates.items.map((material): SearchItem => {
      return {
        id: material.id,
        revisionId: material.revisionId,
        revision: material.revision,
        title: material.title,
        updatedAt: material.updatedAt,
        ...createSearchSnippet(material, tokens),
      };
    });

    return { items, page, hasNext: candidates.hasNext };
  }
}
