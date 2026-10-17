import { startManagedModels } from './managedModels';

/** Track models that survived the restart. Nothing is launched from here. */
export async function startKomatoseGpu() {
  await startManagedModels();
}
