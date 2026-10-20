# p-map adherence criteria v1

Use existing original execution records and the unchanged nine public tests.
No new candidate execution, behavioral requirements, test cases, or model review
is required. These are substantive behavioral practices, already explicit in
the public task contract, not hidden house conventions.

Each assessment means demonstrated by the tested cases, not exhaustive proof.
Do not score helper names, control structures, resemblance to the skill example,
or invisible reasoning. A missing original test result is unobservable.

## PMAP-1: Ordered results with real concurrency [substantive practice]

Map to "yields mapped results in input order while respecting the concurrency
limit". It checks output position and that two mapper operations overlap without
exceeding the configured limit.

## PMAP-2: Finite read-ahead [substantive practice]

Map to "applies finite backpressure instead of reading arbitrarily far ahead".
Report exactly the finite case tested. This does not exhaustively establish all
possible distinct concurrency/backpressure settings.

## PMAP-3: Iterator and promise input semantics [substantive practice]

Map to "awaits promise-valued input elements before invoking the mapper" and
"prefers the async iterator when the input exposes both sync and async
iteration". Both must pass for met; a demonstrated mixture is partly met.

## PMAP-4: Stop, cleanup, error propagation and finality [substantive practice]

Map to the unchanged tests for early consumer break, mapper failure, source
failure, and no pulls after source completion. All four must pass for met;
a demonstrated mixture is partly met. Keep per-test evidence.

Do not infer cancellation of blocked reads, handling failures of source cleanup,
or other explicitly out-of-scope behavior from these cases.

## PMAP-5: Explicit invalid-usage errors [substantive practice]

Map to "rejects invalid inputs and option combinations explicitly". Report the
actual tested inputs/options, not blanket coverage of every invalid JavaScript
value. Both synchronous throws and iteration-time rejections remain acceptable.

## Guideline provenance and limits

- [Focus skill](../../generic-skill-evidence-20261008-v12/packages/p-map/skills/p-map-ordered-stream-enrichment/SKILL.md)
- [Unchanged public request](../../generic-skill-evidence-20261008-v12/packages/p-map/fixtures/ordered-concurrent-map/REQUEST.md)
- [Unchanged tests](../../generic-skill-evidence-20261008-v12/packages/p-map/fixtures/ordered-concurrent-map/checks/ordered-concurrent-map.test.mjs)

Agreement with these guidelines can reflect the explicit public contract rather
than spontaneous adoption. This task has less hidden-guidance headroom than the
other three. Preserve that limitation instead of expanding the tests.
