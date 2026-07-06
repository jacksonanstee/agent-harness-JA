import type { InjectionRule } from './types.js';

/**
 * Heuristic text-pattern rules (ADR-0005 families, ADR-0012 implementation).
 * Every pattern MUST stay linear-time: single-level quantifiers, bounded
 * repetition over broad classes, no backreferences, no lookbehind — enforced
 * by the ReDoS guard in rules.test.ts.
 *
 * Hidden-unicode detection (unicode-tag-chars, zero-width-run) is NOT here:
 * it needs occurrence counting and strip-and-rescan, so it lives in the scan
 * pipeline (scan.ts) with the same id/confidence contract.
 */
export const DEFAULT_INJECTION_RULES: readonly InjectionRule[] = [
  // --- direct-instruction ---
  {
    id: 'ignore-previous',
    family: 'direct-instruction',
    confidence: 'high',
    pattern:
      /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)\b/i,
    description: 'classic "ignore previous instructions" override',
  },
  {
    id: 'disregard-instructions',
    family: 'direct-instruction',
    confidence: 'high',
    pattern:
      /\bdisregard\s+(?:(?:all|any|the|your)\s+){0,2}(?:previous|prior|above)?\s{0,2}(?:instructions?|rules?|prompts?|guidelines?)\b/i,
    description: '"disregard the rules" override variant',
  },
  {
    id: 'you-are-now',
    family: 'direct-instruction',
    confidence: 'medium',
    // Article (a/an/the/in) or a capitalized role token (DAN, STAN, …); a
    // lowercase continuation ("you are now ready") stays benign.
    pattern: /\b[Yy]ou\s+are\s+now\s+(?:(?:a|an|the|in)\b|[A-Z])/,
    description: 'role reassignment phrase (also occurs in benign narrative)',
  },
  {
    id: 'new-instructions',
    family: 'direct-instruction',
    confidence: 'medium',
    pattern: /\b(?:new|updated|real|true)\s+instructions?\s*:/i,
    description: 'inline "new instructions:" header',
  },
  {
    id: 'system-prompt-line',
    family: 'direct-instruction',
    confidence: 'medium',
    pattern: /(?:^|\n)\s{0,8}system\s*:/i,
    description: 'line starting with "system:" (chat logs quote this too)',
  },
  {
    id: 'do-not-tell-user',
    family: 'direct-instruction',
    confidence: 'high',
    pattern: /\bdo\s+not\s+(?:tell|inform|alert|warn)\s+the\s+user\b/i,
    description: 'concealment instruction aimed at the agent',
  },
  {
    id: 'reveal-system-prompt',
    family: 'direct-instruction',
    confidence: 'high',
    pattern:
      /\b(?:reveal|print|show|repeat|output)\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+instructions)\b/i,
    description: 'system-prompt extraction attempt',
  },
  // --- role-impersonation ---
  {
    id: 'chatml-token',
    family: 'role-impersonation',
    confidence: 'high',
    pattern: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/,
    description: 'ChatML / special chat-template token',
  },
  {
    id: 'llama-inst-token',
    family: 'role-impersonation',
    confidence: 'high',
    pattern: /\[\/?INST\]|<<\/?SYS>>/,
    description: 'Llama chat-template separators',
  },
  {
    id: 'anthropic-turn-token',
    family: 'role-impersonation',
    confidence: 'medium',
    pattern: /(?:^|\n)(?:Human|Assistant):\s/,
    description: 'Anthropic-style turn prefix (transcripts quote these)',
  },
  {
    id: 'special-token-generic',
    family: 'role-impersonation',
    confidence: 'medium',
    pattern: /<\|[a-z_]{2,30}\|>/,
    description: 'generic <|token|> chat-template shape',
  },
  // --- encoded-blob ---
  {
    id: 'base64-blob',
    family: 'encoded-blob',
    confidence: 'medium',
    pattern: /[A-Za-z0-9+/]{60,}={0,2}/,
    description: 'long base64 run (≥60 chars ≈ ≥45 decoded bytes)',
  },
  {
    id: 'hex-blob',
    family: 'encoded-blob',
    confidence: 'medium',
    pattern: /(?:0x)?[0-9a-fA-F]{80,}/,
    description: 'long hex run (≥80 chars — above sha256, at sha512 scale)',
  },
  // --- exfil ---
  {
    id: 'markdown-image-exfil',
    family: 'exfil',
    confidence: 'high',
    pattern: /!\[[^\]]{0,100}\]\(\s{0,8}https?:\/\/[^)\s]{1,500}[?&][^)\s]{1,500}\)/i,
    description: 'remote markdown image with a query string — exfil beacon',
  },
  {
    id: 'markdown-image-remote',
    family: 'exfil',
    confidence: 'medium',
    pattern: /!\[[^\]]{0,100}\]\(\s{0,8}https?:\/\/[^)]{1,500}\)/i,
    description: 'remote markdown image (no query string) — possible beacon',
  },
];
