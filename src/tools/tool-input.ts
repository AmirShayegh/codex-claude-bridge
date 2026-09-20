import { z } from 'zod';
import { RECOMMENDED_MODELS, TIER_MODELS, isReviewTier } from '../config/types.js';
import { ErrorCode, err, ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import { escapeTerminalControls } from '../utils/terminal.js';

// Tool arguments are written by a MODEL that never reads stderr, so a key the
// schema would otherwise strip must be answered in the RESULT. Each unknown key
// gets exactly one disposition (ISS-054):
//   fold   — an alias/near-miss of an accepted parameter whose value validates:
//            rewritten into it, recorded in argument_corrections.
//   echo   — anything else: the review proceeds, the key is named in
//            ignored_arguments next to accepted_arguments.
//   refuse — the value is a model selector (tier word, known id, "latest") and
//            no model/tier was given: proceeding would review at the default
//            tier, so a pre-provider refusal is the cheaper outcome.

export interface ArgumentCorrection {
  from: string;
  to: string;
}

export interface ArgumentReport {
  argument_corrections?: ArgumentCorrection[];
  ignored_arguments?: string[];
  accepted_arguments?: string[];
}

export interface ClassifyOptions {
  // False for lookup tools: nothing there can be the wrong review.
  refuseSelectorIntent: boolean;
}

// A loose object keeps unknown keys through the SDK's parse instead of
// stripping them, which is what let `tier: "max"` vanish silently.
export function toolInputSchema<S extends Record<string, z.ZodType>>(shape: S) {
  return z.looseObject(shape);
}

const SELECTOR_KEYS = ['model', 'tier'];
const ALIASES: Record<string, string> = {
  session: 'session_id',
  working_directory: 'cwd',
  working_dir: 'cwd',
  directory: 'cwd',
  model_tier: 'tier',
  review_tier: 'tier',
};
const KEY_DISPLAY_LIMIT = 64;

function displayKey(key: string): string {
  return escapeTerminalControls(key).slice(0, KEY_DISPLAY_LIMIT);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = next;
  }
  return prev[b.length];
}

// Alias, camelCase spelling, or the unique nearest accepted name. Short names
// tolerate one edit, longer ones two: `cw` must not become `cwd` on a guess.
function foldTarget(key: string, accepted: string[]): string | undefined {
  const alias = ALIASES[key];
  if (alias && accepted.includes(alias)) return alias;
  const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (snake !== key && accepted.includes(snake)) return snake;
  let best: { name: string; distance: number; tied: boolean } | undefined;
  for (const name of accepted) {
    const distance = levenshtein(key, name);
    if (distance > (name.length <= 4 ? 1 : 2)) continue;
    if (!best || distance < best.distance) best = { name, distance, tied: false };
    else if (distance === best.distance) best.tied = true;
  }
  return best && !best.tied ? best.name : undefined;
}

const KNOWN_MODELS = new Set(
  [
    ...Object.values(TIER_MODELS).flatMap((tiers) => Object.values(tiers)),
    ...Object.values(RECOMMENDED_MODELS).flat(),
  ].map((m) => m.toLowerCase()),
);

// The hint a refusal carries: how the caller should have said it.
function selectorHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (isReviewTier(v)) return `tier: "${v}"`;
  if (v === 'latest' || KNOWN_MODELS.has(v)) return `model: "${escapeTerminalControls(v)}"`;
  return undefined;
}

function refusal(key: string, hint: string, accepted: string[]): string {
  return (
    `${ErrorCode.INVALID_INPUT}: Unrecognized argument "${displayKey(key)}" looks like a model ` +
    `selector, but no model or tier was given, so the review would run at the default tier. ` +
    `Did you mean ${hint}? Accepted arguments: ${accepted.join(', ')}.`
  );
}

export function classifyToolArguments<S extends Record<string, z.ZodType>>(
  shape: S,
  raw: Record<string, unknown>,
  options: ClassifyOptions,
): Result<{ args: z.output<z.ZodObject<S>>; report: ArgumentReport }> {
  const accepted = Object.keys(shape);
  const args: Record<string, unknown> = {};
  for (const name of accepted) if (raw[name] !== undefined) args[name] = raw[name];
  const corrections: ArgumentCorrection[] = [];
  const pending: string[] = [];
  for (const key of Object.keys(raw)) {
    if (accepted.includes(key)) continue;
    const target = foldTarget(key, accepted);
    const parsed = target && args[target] === undefined ? shape[target].safeParse(raw[key]) : null;
    if (target && parsed?.success) {
      args[target] = parsed.data;
      corrections.push({ from: displayKey(key), to: target });
    } else pending.push(key);
  }
  const hasSelector = SELECTOR_KEYS.some((k) => args[k] !== undefined);
  const ignored: string[] = [];
  for (const key of pending) {
    const hint = options.refuseSelectorIntent && !hasSelector ? selectorHint(raw[key]) : undefined;
    if (hint) return err(refusal(key, hint, accepted));
    ignored.push(displayKey(key));
  }
  const report: ArgumentReport = {};
  if (corrections.length > 0) report.argument_corrections = corrections;
  if (ignored.length > 0) report.ignored_arguments = ignored;
  if (corrections.length > 0 || ignored.length > 0) report.accepted_arguments = [...accepted];
  return ok({ args: args as z.output<z.ZodObject<S>>, report });
}

// `tier` is the documented way to pick by capability; `model` still takes an
// id, "latest", or (for compatibility) a tier word. Backends take one selector.
export function selectModel(args: { model?: string; tier?: string }): Result<string | undefined> {
  if (args.model !== undefined && args.tier !== undefined) {
    return err(
      `${ErrorCode.INVALID_INPUT}: pass either model or tier, not both — they select the same thing.`,
    );
  }
  return ok(args.model ?? args.tier);
}

export function withArgumentReport<T extends object>(data: T, report: ArgumentReport): T {
  return { ...data, ...report };
}

// The MCP error shape every tool answers with for a refused call.
export function invalidInputResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}
