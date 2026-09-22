/**
 * A local memory vault, and the recall that makes it useful.
 *
 * Anuma's API is stateless on purpose. The SDK carries the memory engine
 * client-side (`src/lib/memory/` in anuma-ai/sdk: extraction, decay, RRF, MMR,
 * salience, graph traversal, consolidation) over a local encrypted vault, and
 * `assembleMemoryContext()` builds the prompt before the request is sent. The
 * server never holds the history, which is the point of a private AI layer.
 *
 * This is a reimplementation of that SHAPE, not a port of that engine. It keeps
 * the three parts that make memory behave like memory rather than like a log:
 *
 *   store    facts, typed, with a time-to-live that depends on the type
 *   decay    unused facts expire; recalled facts survive longer
 *   recall   score by term overlap, recency and use, then drop near-duplicates
 *
 * Deliberately NOT encrypted. The SDK encrypts because it syncs. This vault
 * never leaves the machine, so encrypting it here would trade real
 * inspectability for the appearance of security. It is a plain JSON file you
 * can read, diff and delete.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Fact types, ordered by how long they stay true.
 *
 * The distinction that matters is durable-versus-perishable, not
 * important-versus-unimportant. "My name is X" outlives "I am in London this
 * week" however much the second matters today.
 */
export type FactType = "identity" | "preference" | "project" | "event";

/** Time-to-live per type. `identity` does not expire on its own. */
export const TTL_MS: Record<FactType, number> = {
  identity: Number.POSITIVE_INFINITY,
  preference: 365 * 24 * 60 * 60 * 1000,
  project: 90 * 24 * 60 * 60 * 1000,
  event: 14 * 24 * 60 * 60 * 1000,
};

export interface Fact {
  id: string;
  text: string;
  type: FactType;
  createdAt: number;
  /** Last time recall surfaced it. Use extends life; neglect ends it. */
  lastUsedAt: number;
  uses: number;
}

export interface Vault {
  version: 1;
  facts: Fact[];
}

export function vaultPath(): string {
  return process.env.ANUMA_MEMORY_PATH ?? join(homedir(), ".anuma-mcp", "memory.json");
}

export function load(path = vaultPath()): Vault {
  if (!existsSync(path)) return { version: 1, facts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Vault;
    return Array.isArray(parsed?.facts) ? parsed : { version: 1, facts: [] };
  } catch {
    // A corrupt vault is not a reason to crash the server, and not a reason to
    // silently delete someone's memory either. Read it as empty and leave the
    // file alone so it can be inspected.
    return { version: 1, facts: [] };
  }
}

export function save(v: Vault, path = vaultPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2));
}

/** Expired = past its TTL measured from last use, not from creation. */
export function isExpired(f: Fact, now: number): boolean {
  const ttl = TTL_MS[f.type];
  if (!Number.isFinite(ttl)) return false;
  return now - f.lastUsedAt > ttl;
}

export function prune(v: Vault, now = Date.now()): { vault: Vault; dropped: number } {
  const kept = v.facts.filter((f) => !isExpired(f, now));
  return { vault: { ...v, facts: kept }, dropped: v.facts.length - kept.length };
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "but", "of", "to", "in", "on",
  "for", "with", "my", "your", "i", "you", "it", "that", "this", "what", "who", "when", "me",
]);

export function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Score one fact against a query.
 *
 * Overlap dominates, because a memory that is not about the question is not
 * worth surfacing however recent it is. Recency and familiarity only break
 * ties, which is what stops one heavily-used fact from answering everything.
 */
export function score(f: Fact, queryTerms: string[], now: number): number {
  if (queryTerms.length === 0) return 0;
  const ft = new Set(terms(f.text));
  const hits = queryTerms.filter((t) => ft.has(t)).length;
  if (hits === 0) return 0;

  const overlap = hits / queryTerms.length;
  const ageDays = (now - f.lastUsedAt) / (24 * 60 * 60 * 1000);
  const recency = 1 / (1 + ageDays / 30);
  const familiarity = Math.min(f.uses, 5) / 5;

  return overlap * 0.7 + recency * 0.2 + familiarity * 0.1;
}

/**
 * Recall, with diversity.
 *
 * Plain top-k returns near-duplicates when several facts say the same thing in
 * different words, which wastes the context it exists to save. Dropping a
 * candidate that mostly repeats one already chosen is the cheap version of what
 * MMR does in the SDK.
 */
export function recall(v: Vault, query: string, k = 5, now = Date.now()): Fact[] {
  const qt = terms(query);
  const ranked = v.facts
    .filter((f) => !isExpired(f, now))
    .map((f) => ({ f, s: score(f, qt, now) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const chosen: Fact[] = [];
  for (const { f } of ranked) {
    if (chosen.length >= k) break;
    const ft = new Set(terms(f.text));
    const duplicate = chosen.some((c) => {
      const ct = terms(c.text);
      const shared = ct.filter((t) => ft.has(t)).length;
      return shared / Math.max(ct.length, 1) > 0.6;
    });
    if (!duplicate) chosen.push(f);
  }
  return chosen;
}

export function remember(
  v: Vault,
  text: string,
  type: FactType,
  now = Date.now(),
): { vault: Vault; fact: Fact; created: boolean } {
  const trimmed = text.trim();
  const existing = v.facts.find((f) => f.text.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    // Re-stating a fact refreshes it rather than duplicating it.
    const updated = { ...existing, lastUsedAt: now, uses: existing.uses + 1, type };
    return {
      vault: { ...v, facts: v.facts.map((f) => (f.id === existing.id ? updated : f)) },
      fact: updated,
      created: false,
    };
  }
  const fact: Fact = {
    id: `m_${now.toString(36)}_${v.facts.length.toString(36)}`,
    text: trimmed,
    type,
    createdAt: now,
    lastUsedAt: now,
    uses: 0,
  };
  return { vault: { ...v, facts: [...v.facts, fact] }, fact, created: true };
}

export function forget(v: Vault, id: string): { vault: Vault; removed: boolean } {
  const kept = v.facts.filter((f) => f.id !== id);
  return { vault: { ...v, facts: kept }, removed: kept.length !== v.facts.length };
}

/** Mark recalled facts as used, so recall itself keeps them alive. */
export function touch(v: Vault, ids: string[], now = Date.now()): Vault {
  const set = new Set(ids);
  return {
    ...v,
    facts: v.facts.map((f) => (set.has(f.id) ? { ...f, lastUsedAt: now, uses: f.uses + 1 } : f)),
  };
}

/** The block prepended to a prompt. Empty string when nothing is relevant. */
export function assembleContext(facts: Fact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => `- (${f.type}) ${f.text}`).join("\n");
  return `What you already know about this user:\n${lines}\n\n`;
}
