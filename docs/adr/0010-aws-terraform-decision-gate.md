# ADR-0010: AWS와 Terraform 결정 gate

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-14 — 로컬·CI 이미지 제작/검증과 AWS 운영 runtime·image delivery 결정을 구분; 비용·topology gate는 유지
- Canonical owner: 배포 결정 유예, Phase-6 AWS 후보 worksheet, all-in cost와 복구 gate

## Context

devfootnote의 최종 배포 대상은 AWS지만 web, API, worker, PostgreSQL, Redis/BullMQ, vector search와 선택적 AI workload의 실제 자원 측정값이 아직 없다. 이 시점에 AWS service, region, SKU, 운영 process 배치, availability topology, network path, 운영 container runtime, Terraform module 또는 image delivery/deployment pipeline을 고정하면 구현 evidence보다 추측이 architecture를 지배한다.

이 ADR은 AWS target과 재현 가능한 결정 절차만 승인한다. 인프라 생성, Terraform 작성, 배포와 특정 후보 선택은 승인하지 않는다. 저장·delivery 조건은 [ADR-0004](0004-bullmq-embedding-delivery-retry-and-fencing.md), AI privacy·비용 reservation은 [ADR-0008](0008-ai-provider-consent-budget-grounding-and-retention.md), workload 측정 evidence는 [ADR-0009](0009-verification-observability-and-search-evaluation.md)가 소유한다.

AI provider/model/version/dimension 선택은 이 ADR이나 Phase 6의 책임이 아니다. ADR-0008에 따라 첫 실제 AI 호출 전에 별도 승인·검증하며, Phase 6은 이미 승인된 AI 구성의 측정된 workload와 최대 비용 exposure를 AWS 운영비 worksheet에 입력할 뿐이다.

## Decision Drivers

1. 월 30,000원 상한을 credit나 빠진 network/backup 비용으로 거짓 통과시키지 않는다.
2. 같은 workload와 공식 source로 독립 reviewer 둘이 동일한 KRW 결과와 gate를 재현하게 한다.
3. 실제 peak memory, storage, IO, traffic, restore 결과를 보고 가장 단순한 AWS 구성을 선택한다.
4. Terraform은 학습 목적이라는 이유로 topology·운영 책임보다 먼저 만들지 않는다.
5. 비용 통과와 capacity·privacy·restore 통과를 서로 대체하지 않는다.

## Decision

### 지금 승인되는 것과 유예되는 것

최종 cloud target은 AWS다. Phase 6 전에는 다음을 모두 **미정**으로 유지한다.

- AWS region, service, SKU, instance family/size와 purchase term
- web/API/worker의 process 수, co-location 또는 분리, managed/self-managed database/cache
- Single-AZ/Multi-AZ, load balancer, NAT, public IPv4, CDN, registry와 DNS 구성
- AWS 운영 container runtime, registry/image delivery, 운영 secret injection, backup service와 deployment/rollback 방식
- Terraform, CloudFormation/CDK 또는 다른 IaC 선택과 state/backend/module 구조
- AI provider의 AWS 내 배치 여부와 그에 따른 network/secret 운영 topology

Vercel, ECS EC2/Fargate, EC2, Lightsail, RDS, ElastiCache 또는 single-compute 예시는 비교 후보일 뿐 기준안이 아니다. 특정 topology를 문서의 예시, 예상 월액 또는 Terraform skeleton로 먼저 굳히지 않는다. 제품 구현과 로컬 검증은 deploy topology에 의존하지 않는다.

이 유예는 [ADR-0001](0001-monorepo-and-package-boundaries.md)의 로컬 Docker 개발 구성이나 [ADR-0009](0009-verification-observability-and-search-evaluation.md)의 앱 이미지 빌드·최소 runtime smoke를 막지 않는다. 별도 제품 구현 승인 뒤 해당 phase의 Dockerfile과 루트 `docker-compose.yml`의 선택 `app` profile을 만들고 로컬·CI에서 검증할 수 있다. 이를 통해 얻은 image size·startup·자원 사용량은 Phase 6의 입력 증거이며, 특정 AWS runtime이나 배포 방식을 선택한 결과가 아니다. 로컬·CI image build 승인은 registry push·클라우드 자원·배포 또는 CI deploy credential 생성 권한을 포함하지 않는다. 현재 문서 승인만으로 Docker·CI 설정을 생성하거나 실행하지 않는다.

Terraform은 Phase 6에서 선택된 AWS architecture를 반복 생성·검토할 가치가 있는지 판단하는 학습 대상이다. gate가 통과하고 별도 deployment approval을 받기 전에는 `.tf`, state, backend, module, provider lock, AWS account resource나 CI deploy credential을 만들지 않는다.

### Phase-6 진입 evidence

동일한 versioned workload snapshot에 다음을 기록한 뒤에만 후보 비교를 시작한다.

- web/API/worker의 steady와 peak RSS/CPU, startup time, image 또는 artifact size와 동시성
- PostgreSQL data/index/backup 크기, growth, connections, storage와 IO; Redis steady/peak memory, persistence와 no-eviction 요구
- 1k/10k corpus의 indexing/search 측정, queue peak·steady load와 retry/repair volume
- 월 request, ingress/egress와 inter-service transfer, IPv4, DNS, log/metric ingest와 보존량
- 선택적 embedding/answer의 configured maximum calls/units와 observed retry/duplicate-window evidence
- 후보별 peak에서 OS/runtime 여유를 포함한 memory margin과 database/cache capacity
- backup 생성 및 격리된 restore rehearsal 결과, RPO/RTO proposal, migration-before-start와 rollback 절차
- AI provider를 포함하는 후보라면 consent/retention/private-data processing 조건의 승인 evidence

workload snapshot이 후보별로 다르거나 peak와 steady 가정이 표시되지 않으면 비교는 무효다. optional AI가 off인 baseline과 승인된 maximum exposure를 별도 line item으로 보여 주되 AI 비용을 숨겨 core 후보를 통과시키지 않는다.

### 후보 worksheet schema

Phase 6에서 최소 세 후보 `A`, `B`, `C`를 같은 worksheet schema로 비교한다. 세 이름은 architecture 선택이 아니며 실제 후보와 topology는 그때 기록한다. worksheet header에는 다음이 필수다.

- worksheet와 workload snapshot version/hash
- AWS account billing locale/free-credit 상태
- 하나의 명시적 AWS region
- 가격 확인 timestamp와 timezone
- steady/peak 수량, 월 시간 가정과 traffic/storage growth 가정
- USD/KRW FX source, 관찰 lookback window, window 안에서 적용한 최고 환율과 source timestamp
- tax 적용 근거와 multiplier
- 계산·반올림 규칙, reviewer와 재계산 timestamp

각 후보는 다음 category를 행 단위로 모두 포함한다. 사용하지 않는 항목도 삭제하지 않고 `0`, 수량 `0`, 공식 source와 불필요한 이유를 기록한다.

| Category | 필수 evidence |
|---|---|
| compute | web/API/worker별 quantity, hours, unit price와 peak-memory margin |
| database | compute/capacity, storage, IO/IOPS, connections와 backup |
| cache/queue | capacity, node/hour, persistence, storage/backup과 no-eviction 충족 |
| object/block storage | GB-month, request/IO와 snapshot |
| network | ingress, same/cross-AZ transfer, internet egress와 inter-service transfer |
| fixed network | public/DNS, public IPv4, load balancer, NAT hourly/data processing |
| artifacts | ECR 또는 동등 registry storage/transfer |
| observability | log ingest/storage, metric/trace와 retention |
| AI/external | configured maximum usage, retry exposure, unit price; 해당 없으면 0 근거 |
| KRW-only items | domain 또는 AWS 밖의 필수 고정 지출; 없으면 0 |

모든 AWS line에는 service/price dimension, region, quantity, unit, `quantity × unitPrice = lineSubtotalUSD`, official AWS pricing URL과 checked timestamp가 있어야 한다. AWS Pricing Calculator는 보조 artifact일 수 있지만 수식과 line source를 대체하지 않는다. 가격이 사용량 tier에 따라 달라지면 적용 tier와 각 구간을 보존한다.

### 환율·세금·반올림과 cost gate

각 후보에 대해 credit, free tier, promotion과 refund를 제외한 USD subtotal을 먼저 계산한다. 이 혜택은 정보용 `postCreditCashEstimate`로 별도 표시할 수 있지만 gate 값을 낮추지 않는다.

환율은 worksheet에 이름을 적은 공개 source의 연속된 lookback window에서 관찰한 USD/KRW 값 중 가장 높은 값을 쓴다. source가 영업일만 제공하면 window 내 제공된 모든 값과 결측 처리 규칙을 기록한다. 임의 spot rate나 서로 다른 reviewer의 다른 window는 허용하지 않는다.

세금이 적용되면 `taxMultiplier = 1.10`을 사용한다. 적용되지 않는다는 account/billing 근거가 있으면 `1.00`을 쓸 수 있고 그 근거를 worksheet에 기록한다. 불명확하면 `1.10`이다. 중간 line quantity와 subtotal은 비용을 낮추는 방향으로 반올림하지 않으며 최종 계산은 다음 식을 그대로 사용한다.

```text
usdSubtotal = sum(all pre-credit USD line subtotals)
preCreditKRW = ceil((ceil(usdSubtotal × fxRate) + krwItems) × taxMultiplier)
finalTotalKRW = ceil(preCreditKRW × 1.20)

finalTotalKRW > 30000 => BLOCK
```

`1.20`은 usage·가격·환율 변동 headroom이다. `finalTotalKRW == 30000`은 cost gate만 통과한다. 비용이 30,001원 이상이면 작은 초과라도 BLOCK한다. credit 적용 후 현금액, 무료 사용량 또는 AWS 예산 알림은 이 판정을 바꾸지 않는다.

독립 reviewer 둘이 source snapshot과 식만으로 각 후보의 `usdSubtotal`, `preCreditKRW`, `finalTotalKRW`와 PASS/BLOCK을 동일하게 재현해야 한다. 1원이라도 결과가 다르면 source/단위/환율/세금/rounding 차이를 해결하기 전까지 BLOCK한다.

### 독립 capacity·복구·privacy gate

cost가 통과해도 다음 중 하나면 후보는 BLOCK이다.

- peak RSS와 동시 workload 뒤 system/runtime 및 각 managed capacity에 문서화된 안전 margin이 없음
- PostgreSQL durability, Redis persistence/no-eviction, BullMQ terminal receipt/repair/fence를 보존하지 못함
- backup을 만들었지만 격리된 환경의 restore rehearsal과 데이터 무결성 확인이 실패하거나 없음
- migration-before-start, health gate와 application rollback의 실패 모드가 검증되지 않음
- HTTPS/JWT cookie/secret 경계 또는 AI consent·retention 조건을 충족하지 못함
- price line, region, official URL, timestamp, workload assumption, FX lookback, tax 근거 또는 수식이 하나라도 누락됨

Single-AZ나 single-host 후보는 비교할 수 있지만 high availability로 표현할 수 없다. 그 failure domain, downtime, backup/restore 목표를 명시해야 한다. capacity나 restore 부족을 더 싼 비용, credit 또는 기능 계약 삭제로 상쇄하지 않는다.

### 선택과 후속 승인

Phase 6 evidence에서 모든 독립 gate를 통과한 후보 중 가장 단순한 운영 구성을 제안한다. 복수 후보가 통과해도 이 ADR만으로 하나가 선택되지는 않는다. region/topology/IaC/RPO/RTO와 delivery 방식을 고정하는 새 numbered ADR이 `Supersedes: ADR-0010`으로 별도 승인되어야 한다. 그 승인 전에는 deployment·Terraform·AWS resource 생성이 금지된다.

통과 후보가 없으면 topology를 임의 축소하거나 core 계약을 제거하지 않는다. workload, 공개 기간 또는 월 상한을 사용자가 다시 결정할 때까지 deployment만 BLOCK하며 로컬 제품 구현과 검증을 막지는 않는다.

## Considered Options

1. **AWS target만 고정하고 Phase-6 재현 worksheet와 독립 gate 뒤 결정** — 선택.
2. 지금 저비용 single-host topology와 Terraform을 확정 — 측정·복구 evidence가 없어 기각.
3. managed service 중심 구성을 미리 확정 — 비용 상한과 workload가 검증되지 않아 기각.
4. credit 후 현금 지출로만 판정 — steady-state all-in cost를 숨겨 기각.
5. Terraform을 먼저 작성하고 나중에 service를 교체 — 미승인 topology를 code로 굳히므로 기각.

## Consequences

- 현재는 production endpoint, AWS topology, Terraform 또는 배포 명령이 없다.
- 로컬·CI의 runtime image 검증은 먼저 할 수 있지만 이미지 존재나 smoke 통과가 AWS runtime·delivery 선택 또는 배포 승인을 뜻하지 않는다.
- 빠진 항목과 optimistic 환율로 30,000원 gate를 통과시키기 어렵고, reviewer가 결과를 재현할 수 있다.
- AWS target은 유지하면서 실제 memory·IO·traffic·restore evidence에 맞춘 단순한 구성을 나중에 고를 수 있다.
- cost pass는 capacity, privacy와 restore pass를 의미하지 않으며 각각의 BLOCK 이유가 남는다.

## Verification contract

Phase 6에서 두 reviewer가 동일한 frozen worksheet를 독립 계산해 A/B/C 각각의 line subtotal, USD subtotal, 최고 FX rate, tax, 20% headroom과 최종 KRW를 일치시키고 `finalTotalKRW > 30000 => BLOCK`을 적용한다. equality case `30000`과 boundary failure `30001`을 포함해 식 구현을 확인한다.

검토자는 category completeness, region별 official source URL/timestamp, zero-line 근거, pre/post-credit 분리, peak-memory margin, restore artifact와 failure-domain 표현도 독립 확인한다. 누락 항목이나 상이한 재계산 결과가 있으면 비용 수치와 무관하게 BLOCK한다. 이 검증은 AWS/Terraform 실행 승인이 아니며 인프라를 생성하지 않는다.

## Revisit triggers

Phase-6 workload·price·restore evidence가 완성되어 deployment 후보 승인을 요청할 때, 월 상한이나 AWS target이 명시적으로 바뀔 때, 또는 workload snapshot이 후보 선택을 무효화할 정도로 변경될 때 재검토한다.
