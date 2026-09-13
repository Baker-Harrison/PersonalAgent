import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { FileCredentialStore } from './credentials.ts';

export const providerId = 'openai-codex';
export function createPi() {
  const models = createModels({ credentials: new FileCredentialStore() });
  models.setProvider(openaiCodexProvider());
  return models;
}
