// items에는 요청한 페이지의 항목만 담고, 다음 페이지 유무는 저장소가 판정한다.
export interface PageResult<T> {
  items: T[];
  hasNext: boolean;
}
