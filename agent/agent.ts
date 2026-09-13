import { defineAgent } from 'eve';
import { createPiModel } from './lib/pi-model.ts';
import { selectedModel, selectedReasoning } from './lib/settings.ts';
import { reasoningForModel } from './lib/reasoning.ts';

// Static model selection also covers manual compaction between turns.
// Restart Eve after changing account settings to load the new selection.
const model = await selectedModel();
const reasoningEffort = reasoningForModel(model, await selectedReasoning());

export default defineAgent({
  defaultTools: false,
  model: createPiModel(model.id),
  modelContextWindowTokens: model.contextWindow,
  modelOptions: { providerOptions: { pi: { reasoningEffort } } },
  build: { externalDependencies: ['@earendil-works/pi-ai', 'proper-lockfile'] },
});
