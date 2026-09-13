import { getSupportedThinkingLevels, type Model, type Api } from '@earendil-works/pi-ai';

export const reasoningChoices = {
  Light: 'low',
  Medium: 'medium',
  High: 'high',
  'Extra High': 'xhigh',
  Max: 'max',
} as const;
export type ReasoningLabel = keyof typeof reasoningChoices;
export type ReasoningEffort = (typeof reasoningChoices)[ReasoningLabel];

export function parseReasoning(value: string): ReasoningLabel {
  const entry = Object.entries(reasoningChoices).find(([label, wire]) => label.toLowerCase() === value.toLowerCase() || wire === value.toLowerCase());
  if (!entry) throw new Error('Choose Light, Medium, High, Extra High, or Max.');
  return entry[0] as ReasoningLabel;
}

export function reasoningForModel(model: Model<Api>, label: ReasoningLabel): ReasoningEffort {
  const effort = reasoningChoices[label];
  if (!getSupportedThinkingLevels(model).includes(effort)) throw new Error(`${model.id} does not support ${label} reasoning. Choose a supported level with npm run reasoning.`);
  return effort;
}
