import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";

const candidatePath = path.resolve(process.cwd(), "deliverable", "ordered-concurrent-map.mjs");

async function loadCandidate() {
  const module = await import(pathToFileURL(candidatePath).href + `?cachebust=${Date.now()}`);
  assert.equal(typeof module.orderedConcurrentMap, "function", "Expected named export `orderedConcurrentMap`");
  return module.orderedConcurrentMap;
}

async function collect(asyncIterable) {
  const values = [];
  for await (const value of asyncIterable) {
    values.push(value);
  }

  return values;
}

const drainEventLoop = () => new Promise(resolve => {
  setImmediate(resolve);
});

test("yields mapped results in input order while respecting the concurrency limit", async () => {
  const orderedConcurrentMap = await loadCandidate();
  let running = 0;
  let peak = 0;

  const result = [];
  for await (const value of orderedConcurrentMap([30, 10, 20, 0], async (milliseconds, index) => {
    running++;
    peak = Math.max(peak, running);
    await delay(milliseconds);
    running--;
    return `${index}:${milliseconds}`;
  }, {concurrency: 2, backpressure: 2})) {
    result.push(value);
  }

  assert.deepEqual(result, ["0:30", "1:10", "2:20", "3:0"]);
  assert.equal(peak, 2);
});

test("awaits promise-valued input elements before invoking the mapper", async () => {
  const orderedConcurrentMap = await loadCandidate();

  const input = [
    Promise.resolve("alpha"),
    delay(5, "beta"),
  ];

  const seen = [];
  const result = await collect(orderedConcurrentMap(input, async (value, index) => {
    seen.push([value, index]);
    return value.toUpperCase();
  }, {concurrency: 2, backpressure: 2}));

  assert.deepEqual(seen.sort((a, b) => a[1] - b[1]), [["alpha", 0], ["beta", 1]]);
  assert.deepEqual(result, ["ALPHA", "BETA"]);
});

test("prefers the async iterator when the input exposes both sync and async iteration", async () => {
  const orderedConcurrentMap = await loadCandidate();

  const input = {
    [Symbol.iterator]() {
      throw new Error("sync iteration should not be used");
    },
    async * [Symbol.asyncIterator]() {
      yield 1;
      yield 2;
    },
  };

  const result = await collect(orderedConcurrentMap(input, async value => value * 10, {
    concurrency: 2,
    backpressure: 2,
  }));

  assert.deepEqual(result, [10, 20]);
});

test("rejects invalid inputs and option combinations explicitly", async () => {
  const orderedConcurrentMap = await loadCandidate();

  for (const args of [
    [null, async () => {}],
    [[], "not-a-function"],
    [[], async () => {}, {concurrency: 0}],
    [[], async () => {}, {concurrency: 1.5}],
    [[], async () => {}, {concurrency: 2, backpressure: 1}],
  ]) {
    await assert.rejects(async () => collect(orderedConcurrentMap(...args)));
  }
});

test("applies finite backpressure instead of reading arbitrarily far ahead", async () => {
  const orderedConcurrentMap = await loadCandidate();

  const started = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });

  const iterator = orderedConcurrentMap([10, 20, 30, 40, 50], async value => {
    started.push(value);
    await gate;
    return value;
  }, {concurrency: 2, backpressure: 2})[Symbol.asyncIterator]();

  const first = iterator.next();
  await drainEventLoop();
  assert.deepEqual(started, [10, 20]);

  release();
  const firstValue = await first;
  assert.deepEqual(firstValue, {done: false, value: 10});
  await drainEventLoop();
  assert.ok(started.length >= 2 && started.length <= 3);
  assert.deepEqual(started, [10, 20, 30].slice(0, started.length));

  await iterator.return();
});

test("stops pulling and closes the source when the consumer breaks early", async () => {
  const orderedConcurrentMap = await loadCandidate();

  let closed = false;
  const mapped = [];

  async function * source() {
    try {
      yield 0;
      yield 1;
      yield 2;
    } finally {
      closed = true;
    }
  }

  for await (const value of orderedConcurrentMap(source(), async value => {
    mapped.push(value);
    return value;
  }, {concurrency: 2, backpressure: 2})) {
    assert.equal(value, 0);
    break;
  }

  const admittedAtStop = [...mapped];
  await delay(20);

  assert.equal(closed, true);
  assert.deepEqual(mapped, admittedAtStop);
  assert.ok(mapped.length <= 2);
});

test("closes the source when the mapper throws", async () => {
  const orderedConcurrentMap = await loadCandidate();

  let closed = false;
  async function * source() {
    try {
      yield 0;
      yield 1;
      yield 2;
    } finally {
      closed = true;
    }
  }

  await assert.rejects(
    collect(orderedConcurrentMap(source(), async value => {
      if (value === 1) {
        throw new Error("mapper failed");
      }

      return value;
    }, {concurrency: 2, backpressure: 2})),
    /mapper failed/,
  );

  await delay(20);
  assert.equal(closed, true);
});

test("rejects when the source itself throws", async () => {
  const orderedConcurrentMap = await loadCandidate();

  const input = {
    closed: false,
    [Symbol.iterator]() {
      return {
        next() {
          throw new Error("source failed");
        },
        return() {
          input.closed = true;
          return {done: true};
        },
      };
    },
  };

  await assert.rejects(
    collect(orderedConcurrentMap(input, async value => value, {concurrency: 2, backpressure: 2})),
    /source failed/,
  );
  await drainEventLoop();
  assert.equal(input.closed, true);
});

test("does not pull again after the source reports done", async () => {
  const orderedConcurrentMap = await loadCandidate();

  const source = {
    nextCallsAfterDone: 0,
    [Symbol.asyncIterator]() {
      let index = 0;
      let exhausted = false;
      return {
        async next() {
          if (exhausted) {
            source.nextCallsAfterDone++;
            return {done: true, value: undefined};
          }

          if (index < 3) {
            return {done: false, value: index++};
          }

          exhausted = true;
          return {done: true, value: undefined};
        },
      };
    },
  };

  const result = await collect(orderedConcurrentMap(source, async value => {
    await delay(5);
    return value;
  }, {concurrency: 2, backpressure: 2}));

  assert.deepEqual(result, [0, 1, 2]);
  assert.equal(source.nextCallsAfterDone, 0);
});
