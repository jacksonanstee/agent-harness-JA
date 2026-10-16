export function machinePathRegex(): RegExp;
export function findMachinePaths(value: unknown, where?: string): string[];
export function applyLiterals<T>(value: T, literals: ReadonlyArray<readonly [string, string]>): T;
export interface FixtureEvents {
  pre?: Record<string, unknown>;
  post?: Record<string, unknown>;
  fail?: Record<string, unknown>;
  readPre?: Record<string, unknown>;
  readPost?: Record<string, unknown>;
}
export interface FixtureConfig {
  marker: string;
  markerFail: string;
  readMarker: string;
  readPlaceholder: string;
  literals: ReadonlyArray<readonly [string, string]>;
  volatile: Record<string, unknown>;
  sdkVersion: string;
}
export type BuildResult =
  | { ok: true; fixture: Record<string, unknown> }
  | { ok: false; kind: 'bad' | 'leaks'; problems: string[] };
export function buildFixture(events: FixtureEvents, cfg: FixtureConfig): BuildResult;
