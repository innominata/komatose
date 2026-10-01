import { komatoseGpuEnabled } from './gpuMode';
import { warmupLocalReviewModels } from './localReview';
import { warmupWorkflow } from './localWorker';
import { startManagedModels } from './managedModels';

/** Chat services are independent of the legacy OCR/cleaning GPU layout. */
export async function startKomatoseGpu(abort = new AbortController().signal) {
  const chat = startManagedModels();
  const specialists = komatoseGpuEnabled() ? (async () => {
    await warmupLocalReviewModels(abort);
    await warmupWorkflow();
  })() : Promise.resolve();
  await Promise.allSettled([chat, specialists]);
}
