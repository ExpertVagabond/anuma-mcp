/**
 * Tests for the memory vault.
 *
 * The interesting behaviour is not "can it store a string". It is whether
 * decay, ranking and de-duplication do what memory is supposed to do: keep
 * what stays true, surface what is relevant, and not repeat itself.
 *
 *   node --test --experimental-strip-types src/memory.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  type Fact,
  type Vault,
  TTL_MS,
  assembleContext,
  forget,
  isExpired,
  prune,
  recall,
  remember,
  score,
  terms,
  touch,
} from "./memory.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function vault(...facts: Fact[]): Vault {
  return { version: 1, facts };
}

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: over.id ?? "m_1",
    text: over.text ?? "my project codename is Kestrel",
    type: over.type ?? "project",
    createdAt: over.createdAt ?? T0,
    lastUsedAt: over.lastUsedAt ?? T0,
    uses: over.uses ?? 0,
  };
}

test("identity never expires on its own; everything else does", () => {
  const ancient = 10 * 365 * DAY;
  assert.equal(isExpired(fact({ type: "identity" }), T0 + ancient), false);
  for (const type of ["preference", "project", "event"] as const) {
    assert.equal(isExpired(fact({ type }), T0 + ancient), true, `${type} should expire`);
  }
  assert.equal(TTL_MS.identity, Number.POSITIVE_INFINITY);
});

test("decay is measured from last use, so recall keeps a fact alive", () => {
  const f = fact({ type: "event" }); // 14-day TTL
  const twentyDays = T0 + 20 * DAY;
  assert.equal(isExpired(f, twentyDays), true, "untouched for 20 days");

  // Same fact, recalled on day 15. It survives day 20, because the clock
  // restarts on use. This is the whole point of storing lastUsedAt.
  const used = touch(vault(f), [f.id], T0 + 15 * DAY).facts[0];
  assert.equal(isExpired(used, twentyDays), false);
});

test("prune drops expired facts and reports how many", () => {
  const v = vault(
    fact({ id: "a", type: "identity" }),
    fact({ id: "b", type: "event", text: "in London this week" }),
  );
  const { vault: after, dropped } = prune(v, T0 + 30 * DAY);
  assert.equal(dropped, 1);
  assert.deepEqual(after.facts.map((f) => f.id), ["a"]);
});

test("relevance beats recency: an old on-topic fact outranks a fresh off-topic one", () => {
  const qt = terms("what is my project codename");
  const onTopic = fact({ text: "my project codename is Kestrel", lastUsedAt: T0 - 200 * DAY });
  const offTopic = fact({ text: "I prefer dark roast coffee", lastUsedAt: T0 });
  assert.ok(
    score(onTopic, qt, T0) > score(offTopic, qt, T0),
    "a memory that is not about the question should lose, however recent",
  );
});

test("a fact sharing no terms with the query scores zero and is never recalled", () => {
  const v = vault(fact({ text: "I prefer dark roast coffee" }));
  assert.equal(score(v.facts[0], terms("what is my codename"), T0), 0);
  assert.deepEqual(recall(v, "what is my codename", 5, T0), []);
});

test("recall drops near-duplicates instead of spending context on them", () => {
  const v = vault(
    fact({ id: "a", text: "my project codename is Kestrel" }),
    fact({ id: "b", text: "the project codename is Kestrel indeed" }),
    fact({ id: "c", text: "project Kestrel ships in November" }),
  );
  const hits = recall(v, "project codename Kestrel", 5, T0);
  const ids = hits.map((f) => f.id);
  assert.ok(ids.includes("a"), "the best match is kept");
  assert.ok(!ids.includes("b"), "a restatement of the same fact is dropped");
});

test("recall respects the limit and returns nothing for an empty vault", () => {
  const v = vault(
    fact({ id: "a", text: "codename Kestrel one" }),
    fact({ id: "b", text: "codename Falcon two" }),
    fact({ id: "c", text: "codename Osprey three" }),
  );
  assert.equal(recall(v, "codename", 2, T0).length, 2);
  assert.deepEqual(recall(vault(), "anything", 5, T0), []);
});

test("re-stating a known fact refreshes it rather than duplicating it", () => {
  const first = remember(vault(), "My name is Matthew", "identity", T0);
  assert.equal(first.created, true);

  const again = remember(first.vault, "  my name is matthew  ", "identity", T0 + DAY);
  assert.equal(again.created, false, "case and whitespace should not create a second copy");
  assert.equal(again.vault.facts.length, 1);
  assert.equal(again.fact.uses, 1, "restating counts as a use");
  assert.equal(again.fact.lastUsedAt, T0 + DAY);
});

test("forget removes one fact by id, and says so when the id is unknown", () => {
  const v = vault(fact({ id: "a" }), fact({ id: "b", text: "second" }));
  const hit = forget(v, "a");
  assert.equal(hit.removed, true);
  assert.deepEqual(hit.vault.facts.map((f) => f.id), ["b"]);
  assert.equal(forget(v, "nope").removed, false);
});

test("assembleContext is empty when there is nothing to say", () => {
  // An empty block would otherwise prepend a header promising knowledge that
  // does not follow, which is worse than sending nothing.
  assert.equal(assembleContext([]), "");
  const block = assembleContext([fact({ text: "codename is Kestrel", type: "project" })]);
  assert.match(block, /^What you already know/);
  assert.match(block, /\(project\) codename is Kestrel/);
  assert.ok(block.endsWith("\n\n"), "must separate cleanly from the prompt that follows");
});

test("terms drops stopwords and single characters so overlap means something", () => {
  assert.deepEqual(terms("What is my project codename?"), ["project", "codename"]);
});
