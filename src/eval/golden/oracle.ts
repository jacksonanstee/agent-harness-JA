import { pathToFileURL } from 'node:url';
import type { SessionResult } from '../../session/index.js';

export interface OracleVerdict {
  pass: boolean;
  reason?: string;
}

/**
 * The task author's contract: pure, deterministic, no model calls, no I/O.
 * Judges the SessionResult surface only (final text, resultSubtype, denied[],
 * usage) — not filesystem side effects (ADR-0017 named limitation). Author
 * `.mjs` oracles with: @type {import('agent-harness-ja').OracleFn}
 */
export type OracleFn = (result: SessionResult) => OracleVerdict | Promise<OracleVerdict>;

export type LoadOracleFn = (path: string) => Promise<OracleFn>;

/**
 * Dynamic-imports the sibling oracle module (file URL — Windows-safe). This
 * executes arbitrary in-process code from the task directory: security-model
 * R-10; the CLI warns before the first load. ESM caches by path — irrelevant
 * for the one-shot CLI, relevant if a watch mode ever lands.
 */
export async function loadOracle(path: string): Promise<OracleFn> {
  const mod: unknown = await import(pathToFileURL(path).href);
  const oracle = (mod as Record<string, unknown>).oracle;
  if (typeof oracle !== 'function') {
    throw new Error(`oracle module must have a named export 'oracle' that is a function: ${path}`);
  }
  return oracle as OracleFn;
}

/**
 * Boundary validation of an oracle's return value. Strict: `pass` must be a
 * real boolean (truthy coercion rejected — a broken oracle that returns
 * objects/strings must never silently pass everything), `reason` if present
 * must be a string.
 */
export function validateVerdict(value: unknown): OracleVerdict {
  if (value === null || typeof value !== 'object') {
    throw new Error(`oracle must return an object { pass: boolean }, got ${typeof value}`);
  }
  const pass = (value as { pass?: unknown }).pass;
  if (typeof pass !== 'boolean') {
    throw new Error(
      `oracle must return a strict boolean 'pass' (truthy coercion is rejected), got ${typeof pass}`,
    );
  }
  const reason = (value as { reason?: unknown }).reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error(`oracle 'reason' must be a string when present, got ${typeof reason}`);
  }
  return reason === undefined ? { pass } : { pass, reason };
}
