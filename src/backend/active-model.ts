// set-active-model change detection (pure, no Express deps).
//
// Why: the native backend disposes its whole project instance on EVERY
// PUT config (ConfigHttpApi.update has no changed-check), aborting
// in-flight session work. The proxy used to PUT set-active-model on every
// request; under concurrent/rapid traffic that is a self-inflicted abort
// storm. Only PUT when the model actually changed for that backend client.
// Failures are never cached so the next request retries the PUT.

/** Minimal client surface needed for the active-model PUT. */
export interface ActiveModelClient {
  config: {
    update: (args: unknown) => Promise<unknown>;
  };
}

let lastActiveModelByClient = new WeakMap<object, string>();

export function activeModelKey(providerID: unknown, modelID: unknown): string {
  return `${String(providerID ?? '')}/${String(modelID ?? '')}`;
}

/**
 * Drop all cached entries. Call when the backend (re)spawns: a fresh backend
 * reverts to its default model, so a stale skip would run the wrong default.
 */
export function resetActiveModelCache(): void {
  lastActiveModelByClient = new WeakMap<object, string>();
}

/** PUT set-active-model iff changed since the last successful PUT. Throws on failure (callers keep their existing catch semantics). */
export async function ensureActiveModel(
  client: ActiveModelClient,
  providerID: unknown,
  modelID: unknown,
): Promise<void> {
  const key = activeModelKey(providerID, modelID);
  if (lastActiveModelByClient.get(client as object) === key) return;
  // Record intent synchronously: concurrent same-model callers share one PUT
  // instead of each missing the cache mid-flight and re-admitting the storm.
  lastActiveModelByClient.set(client as object, key);
  try {
    await client.config.update({
      body: {
        activeModel: { providerID, modelID },
      },
    });
  } catch (error: unknown) {
    // Roll back only if still ours: a concurrent newer model must keep its
    // intent; failures are never cached so the next request retries the PUT.
    if (lastActiveModelByClient.get(client as object) === key) {
      lastActiveModelByClient.delete(client as object);
    }
    throw error;
  }
}
