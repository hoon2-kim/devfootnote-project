import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function luminance(hex: string) {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
}

// ADR-0006: 본문 텍스트는 4.5:1, control boundary·focus signal은 인접 색 대비 3:1이다.
// action-primary는 현재 focus/boundary 역할로만 쓰므로 3:1 기준으로 고정한다.
const TEXT_ROLES = ['text-primary', 'text-secondary', 'text-muted', 'status-error', 'status-warning', 'status-success', 'status-destructive'];
const SIGNAL_ROLES = ['focus', 'action-primary'];

it('상태·본문·보조 텍스트와 focus token이 지정 대비를 충족한다', () => {
  const css = readFileSync('apps/web/src/app/globals.css', 'utf8');
  const tokens = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})/g)].map(match => [match[1], match[2]]));
  for (const [roles, minimum] of [[TEXT_ROLES, 4.5], [SIGNAL_ROLES, 3]] as const) {
    for (const role of roles) {
      const foreground = tokens[role];
      if (!foreground) throw new Error(`누락된 token: ${role}`);
      for (const background of [tokens.surface, tokens.canvas]) {
        if (!background) throw new Error('surface·canvas token이 필요합니다.');
        const contrast = (luminance(background) + 0.05) / (luminance(foreground) + 0.05);
        expect(contrast, `${role} on ${background}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  }
});
