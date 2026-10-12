const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// 외부 origin이나 미구현 화면은 복원하지 않는다. callback query는 이 값의 근거가 아니다.
export function loginReturnTo(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input.startsWith('/') ||
    input.startsWith('//') ||
    [...input].some((character) => character === '\\' || character.charCodeAt(0) <= 32)
  ) {
    return '/library';
  }

  let url: URL;

  try {
    url = new URL(input, 'https://return.invalid');
  } catch {
    return '/library';
  }

  const document = new RegExp(`^/documents/${uuid}$`, 'i').test(url.pathname);

  if (
    url.origin !== 'https://return.invalid' ||
    (!document && !['/library', '/search'].includes(url.pathname))
  ) {
    return '/library';
  }

  const allowed = document
    ? ['revision']
    : url.pathname === '/search'
      ? ['q', 'page', 'mode']
      : ['page'];

  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      return '/library';
    }
  }

  const page = url.searchParams.get('page');
  const revision = url.searchParams.get('revision');
  const query = url.searchParams.get('q');
  const mode = url.searchParams.get('mode');

  if (
    (mode !== null && !['keyword', 'vector', 'hybrid'].includes(mode)) ||
    (page !== null && (!/^\d+$/u.test(page) || Number(page) < 1 || Number(page) > 100000)) ||
    (revision !== null && !new RegExp(`^${uuid}$`, 'i').test(revision)) ||
    (query !== null &&
      (query.length > 200 || [...query].some((character) => character.charCodeAt(0) < 32))) ||
    (url.hash &&
      !(document ? ['#main-content', '#note-title', '#source-title'] : ['#main-content']).includes(
        url.hash,
      ))
  ) {
    return '/library';
  }

  return url.pathname + url.search + url.hash;
}
