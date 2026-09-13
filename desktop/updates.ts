export const releaseRepository = 'Baker-Harrison/PersonalAgent';
export type AvailableUpdate = { version: string; url: string };
function versionParts(value: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}
export function availableUpdate(current: string, release: any): AvailableUpdate | null {
  const before = versionParts(current), after = versionParts(release?.tag_name ?? '');
  if (!before || !after || release.draft || release.prerelease) return null;
  const different = after.findIndex((part, index) => part !== before[index]);
  if (different < 0 || after[different] < before[different]) return null;
  const version = after.join('.');
  const asset = `PersonalAgent-${version}-darwin-arm64.dmg`;
  if (!Array.isArray(release.assets) || !release.assets.some((item: any) => item.name === asset && item.state === 'uploaded' && item.size > 0)) return null;
  return { version, url: `https://github.com/${releaseRepository}/releases/tag/v${version}` };
}
export async function checkForUpdate(current: string, request: typeof fetch = fetch): Promise<AvailableUpdate | null> {
  const response = await request(`https://api.github.com/repos/${releaseRepository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PersonalAgent' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
  return availableUpdate(current, await response.json());
}
