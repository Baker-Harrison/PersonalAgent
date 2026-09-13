import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDirectory, atomicJson, ensureDirectory } from './credentials.ts';
import { createPi, providerId } from './pi.ts';
import { parseReasoning, reasoningForModel, type ReasoningLabel } from './reasoning.ts';

async function readSettings(): Promise<{ modelId?: string; reasoning?: ReasoningLabel }> {
  try { return JSON.parse(await readFile(join(appDirectory, 'settings.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read Eve Pi settings. Check settings.json in the application-support directory.');
  }
}

export async function selectedModel() {
  const modelId = process.env.EVE_PI_MODEL ?? (await readSettings()).modelId;
  if (!modelId) throw new Error('Choose a model first: npm run model -- <model-id>. List choices with npm run models.');
  const model = modelId && createPi().getModel(providerId, modelId);
  if (!model) throw new Error('The selected model is not in Pi’s Codex catalog. Run npm run models and choose one with npm run model -- <model-id>.');
  return model;
}

export async function saveModel(modelId: string) {
  const model = createPi().getModel(providerId, modelId);
  if (!model) throw new Error('Unknown Codex model. Run npm run models.');
  const settings = await readSettings();
  reasoningForModel(model, settings.reasoning ?? 'Light');
  await ensureDirectory(appDirectory);
  await atomicJson(join(appDirectory, 'settings.json'), { ...settings, modelId });
}

export async function selectedReasoning() {
  return parseReasoning(process.env.EVE_PI_REASONING ?? (await readSettings()).reasoning ?? 'Light');
}

export async function saveReasoning(value: string) {
  const reasoning = parseReasoning(value);
  reasoningForModel(await selectedModel(), reasoning);
  await ensureDirectory(appDirectory);
  await atomicJson(join(appDirectory, 'settings.json'), { ...await readSettings(), reasoning });
  return reasoning;
}
