# Task: implement ordered concurrent enrichment

Implement **`deliverable/ordered-concurrent-map.mjs`** as a built-ins-only Node.js module.

## Required export

Export exactly one named function:

```js
export function orderedConcurrentMap(input, mapper, options = {})
```

## Required behavior

`orderedConcurrentMap(...)` must return an **`AsyncIterable`** that:

1. accepts either a sync `Iterable` or an `AsyncIterable`,
2. prefers `Symbol.asyncIterator` when an input exposes both,
3. awaits promise-valued input elements before calling `mapper`,
4. calls `mapper(element, index)` with the input position,
5. yields mapped results in **input order** even when mapper work settles out of order,
6. respects `options.concurrency`,
7. respects `options.backpressure` so the source is not read arbitrarily far ahead of the consumer,
8. stops pulling and closes the source when the consumer stops early,
9. closes the source when the mapper throws or the source throws,
10. stops pulling once the source reports `done`.

## Option validation

Reject invalid usage with explicit errors:

- `input` must be an `Iterable` or `AsyncIterable`,
- `mapper` must be a function,
- `concurrency` must be an integer `>= 1` or `Infinity`,
- `backpressure` must be an integer `>= concurrency` or `Infinity`.

Default `concurrency` to `Infinity` and default `backpressure` to `concurrency`.

Validation may throw at the call or reject during iteration. Error wording is not
prescribed. Backpressure bounds admitted items not yet yielded; either batching
or incremental refill is valid. Concurrency must allow overlapping mapper work.
Already admitted work may settle after early stop, but no new work should start.
Cancellation of blocked source reads and failures of source cleanup are out of scope.

## Constraints

- Use **only Node built-ins and your own code**.
- Do **not** import the pinned `p-map` source or any third-party package.
- Save the implementation to `deliverable/ordered-concurrent-map.mjs`.

## Public checker

Run:

```powershell
node task-fixture/check.mjs
```

Visible tests live in:

- `task-fixture/checks/ordered-concurrent-map.test.mjs`

Valid implementations may differ internally as long as they satisfy the public contract above.
