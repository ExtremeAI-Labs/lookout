import type { Metadata } from 'next';
import ReconstructionView from '@/components/reconstruction/ReconstructionView';
import '../reconstruction.css';

export const metadata: Metadata = { title: 'Lookout — Case Reconstruction' };

export default async function ReconstructionPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ReconstructionView caseId={caseId} />;
}
