import { AuthBoundary } from '../../../features/auth';
import { DocumentScreen } from '../../../features/documents';

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ materialId: string }>;
  searchParams: Promise<{ revision?: string }>;
}) {
  const { materialId } = await params;

  return (
    <AuthBoundary>
      <DocumentScreen materialId={materialId} expectedRevisionId={(await searchParams).revision} />
    </AuthBoundary>
  );
}
