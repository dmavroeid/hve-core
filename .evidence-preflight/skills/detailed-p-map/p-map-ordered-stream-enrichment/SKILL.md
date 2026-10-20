---
name: p-map-ordered-stream-enrichment
description: Use when implementing or reviewing a Node.js helper that enriches items from a lazy Iterable or AsyncIterable concurrently while preserving input order, bounding read-ahead, and cleaning up correctly on error or early consumer stop.
---

# p-map ordered stream enrichment

Use this skill for **built-ins-only** or custom-helper tasks where a caller needs **streamed, ordered output** from a lazy sync or async source. It is not aimed at ordinary array mapping, trivial `Promise.all` fan-out, or tasks where output order does not matter.

This guidance is grounded in public `p-map` commit
`2c0934b8312b637f933b752c6054845c2d2d5533`. The [source references](references/provenance.md)
are attribution for publisher inspection, not extra task inputs. Follow the
task's restrictions on external access; this skill does not require reading or
copying the upstream implementation.

## Apply when

- The input may be a lazy `Iterable` or `AsyncIterable`.
- The mapper should run concurrently, but the **consumer still wants input order**.
- The source must not be read arbitrarily far ahead of the consumer.
- Cleanup matters when the **consumer stops early**, the **mapper throws**, or the **source throws**.

## Working rules

1. **Validate the contract up front.** Reject a non-iterable input, a non-function mapper, `concurrency < 1`, or `backpressure < concurrency` with explicit errors. This is public behavior in the [readme and tests](references/provenance.md), including `pMapIterable - enforce the options`.

2. **Treat async iteration like `for await` does.** If the input exposes both `Symbol.iterator` and `Symbol.asyncIterator`, prefer the async iterator. This is implemented in `getIterator` and pinned by the `prefers the async iterator when the input has both` test in the [source and tests](references/provenance.md).

3. **Await each input element before mapping it.** The source may yield promises, not just plain values. The public API allows promise-valued items in both sync and async inputs; see the `input` contract and promise-valued-input tests in the [readme and tests](references/provenance.md).

4. **Assign the input index when the pull starts, not when it settles.** A lazy async source can resolve `next()` calls out of order. If the task exposes an `index`, or if your bookkeeping depends on input position, capture it at spawn time. This is called out in comments around `currentIndex` and exercised by the out-of-order source tests in the [source and tests](references/provenance.md).

5. **Separate concurrency from read-ahead.** `concurrency` limits active mapper work; `backpressure` limits how many not-yet-consumed results can sit ahead of the consumer. The key user benefit is bounded resource use, not just parallelism. See the `backpressure` section, the spawn guard in `pMapIterable`, and the `pMapIterable - backpressure` tests in the [pinned references](references/provenance.md).

6. **Keep ordered output with an index-ordered buffer.** Mapper completions can settle in any order, but default streamed output should still come out in input order. The readme states this default, and the ordered behavior is covered by the main `pMapIterable` tests in the [readme and tests](references/provenance.md).

7. **Stop pulling immediately when the consumer is done or an error path wins.** Set a stop flag outside the generator’s normal `finally`, because a pending `next()` can otherwise keep pulling and mapping work for nobody. This is the reason for the outer `isDone` flag and overridden `return()`/`throw()`, exercised by early-stop tests such as `stops pulling input when return() is called while a next() is pending` and `does not call the mapper for input that arrives after the consumer breaks` in the [source and tests](references/provenance.md).

8. **Close the source on early stop and failures.** Call `iterator.return?.()` when the consumer breaks, the mapper throws, or the source throws, so a queue/stream-like source can release resources. Do not let a stuck cleanup block the caller. This behavior is implemented by `closeIterator` and covered by closure tests in the [source and tests](references/provenance.md).

9. **Once the source reports `done`, treat that as final.** Do not keep pulling after `done`, even if other pending pulls or work complete later. The `createPuller` helper and done-related tests in the [source and tests](references/provenance.md) show why this matters for queue-like sources.

## Pitfalls to avoid

- **Do not collect the whole input first.** That destroys lazy-source behavior, defeats backpressure, and makes early consumer stop impossible.
- **Do not use `Promise.all` as a shortcut** when the task requires ordered streaming or early cleanup.
- **Do not silently default invalid options** like `concurrency: 0` or `backpressure: 1` under `concurrency: 2`; reject them explicitly.
- **Do not keep mapping items that arrive only after stop/error.** Already-started work may settle, but no new pulls or mapper calls should start after the winning stop condition.
- **Do not assume this task wants unordered throughput.** The upstream source exposes an unordered mode, but ordered enrichment is the default and the relevant need here.

## Assumptions for this evaluation

- The evaluation task measures the **ordered** streaming case only.
- The task uses **Node built-ins only**, so the point is to reconstruct the behavior, not to import `p-map`.
- `AbortSignal`, `pMapSkip`, and unordered yield mode are intentionally out of scope unless the task explicitly asks for them.
