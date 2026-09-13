import { randomInt } from 'node:crypto';

export const workerNames = ['Ada', 'Alex', 'Arlo', 'Avery', 'Blair', 'Casey', 'Cleo', 'Drew', 'Eden', 'Ellis', 'Emery', 'Finn', 'Harper', 'Hazel', 'Jade', 'Jamie', 'Jules', 'Kai', 'Lane', 'Leo', 'Luca', 'Maya', 'Milo', 'Morgan', 'Nico', 'Noah', 'Nova', 'Olive', 'Quinn', 'Reese', 'Remy', 'Riley', 'Robin', 'Rowan', 'Sage', 'Sam', 'Sky', 'Theo', 'Wren', 'Zoe'];

// Keep names stable across reloads and unique across every project's saved workers.
// Exhausting the pool adds a numbered round instead of reusing an existing name.
export function assignWorkerNames(projects: { workers: { displayName?: string }[] }[]) {
  const workers = projects.flatMap(p => p.workers), used = new Set<string>();
  for (const worker of workers) {
    if (worker.displayName) used.add(worker.displayName);
  }
  for (const worker of workers) if (!worker.displayName) {
    let round = 1, available: string[] = [];
    while (!available.length) {
      available = workerNames.map(name => round === 1 ? name : `${name} ${round}`).filter(name => !used.has(name));
      round++;
    }
    worker.displayName = available[randomInt(available.length)];
    used.add(worker.displayName);
  }
}
