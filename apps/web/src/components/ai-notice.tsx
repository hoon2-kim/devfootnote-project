import type { ReactNode } from 'react';

// 두 AI 기능의 표시 방식만 공유한다. 동의·요청·오류 상태는 각 feature가 소유한다.
export function AiNotice({
  firstUse,
  summary,
  notice,
  children,
}: {
  firstUse: boolean;
  summary: string;
  notice: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2 text-sm leading-6 text-text-muted">
      {firstUse && (
        <p>
          현재 이 서비스는 Gemini API 무료 등급을 사용합니다. {summary} 전송한 내용은 Google의
          서비스 개선에 사용되거나 사람이 검토할 수 있으니, 개인정보나 회사 기밀은 입력하지 마세요.
        </p>
      )}
      <details className="group">
        <summary className="w-fit cursor-pointer rounded py-3 underline decoration-paper-rule underline-offset-4 hover:text-text-primary">
          AI 사용 안내
        </summary>
        <div className="max-w-3xl space-y-2 border-l-2 border-paper-rule pl-4">
          <p>{notice}</p>
          {children}
        </div>
      </details>
    </div>
  );
}
