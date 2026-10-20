export function orderedConcurrentMap(
  input,
  mapper,
  {
    concurrency = Number.POSITIVE_INFINITY,
    backpressure = concurrency,
  } = {},
) {
  validate(input, mapper, concurrency);

  if (!((Number.isSafeInteger(backpressure) && backpressure >= concurrency) || backpressure === Number.POSITIVE_INFINITY)) {
    throw new TypeError(`Expected \`backpressure\` to be an integer from \`concurrency\` (${concurrency}) and up or \`Infinity\`, got \`${backpressure}\` (${typeof backpressure})`);
  }

  return {
    [Symbol.asyncIterator]() {
      let isDone = false;

      const generator = (async function * () {
        const iterator = getIterator(input);
        let promises = [];
        let headIndex = 0;
        let pendingPromisesCount = 0;
        let isIterableDone = false;
        let index = 0;

        const pull = createPuller(iterator);

        function trySpawn() {
          if (isDone || isIterableDone || !(pendingPromisesCount < concurrency && promises.length - headIndex < backpressure)) {
            return;
          }

          pendingPromisesCount++;
          const currentIndex = index++;

          const promise = (async () => {
            try {
              const {done, value} = await pull();

              if (done) {
                isIterableDone = true;
                pendingPromisesCount--;
                return {done: true};
              }

              trySpawn();

              const element = await value;

              if (isDone) {
                pendingPromisesCount--;
                return {done: true};
              }

              const returnValue = await mapper(element, currentIndex);

              pendingPromisesCount--;
              return {done: false, value: returnValue};
            } catch (error) {
              pendingPromisesCount--;
              isDone = true;
              return {error};
            }
          })();

          promises.push(promise);
          promise.then(() => {
            trySpawn();
          });
        }

        trySpawn();

        try {
          while (headIndex < promises.length) {
            const result = await promises[headIndex];
            const {done, value} = result;

            promises[headIndex] = undefined;
            headIndex++;

            if (headIndex * 2 >= promises.length) {
              promises = promises.slice(headIndex);
              headIndex = 0;
            }

            if (Object.hasOwn(result, "error")) {
              throw result.error;
            }

            if (done) {
              return;
            }

            trySpawn();
            yield value;
          }
        } finally {
          isDone = true;

          if (!isIterableDone) {
            closeIterator(iterator);
          }
        }
      })();

      const {return: generatorReturn, throw: generatorThrow} = generator;

      generator.return = value => {
        isDone = true;
        return generatorReturn.call(generator, value);
      };

      generator.throw = error => {
        isDone = true;
        return generatorThrow.call(generator, error);
      };

      return generator;
    },
  };
}

function validate(input, mapper, concurrency) {
  if (input?.[Symbol.iterator] === undefined && input?.[Symbol.asyncIterator] === undefined) {
    throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof input})`);
  }

  if (typeof mapper !== "function") {
    throw new TypeError("Mapper function is required");
  }

  if (!((Number.isSafeInteger(concurrency) && concurrency >= 1) || concurrency === Number.POSITIVE_INFINITY)) {
    throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
  }
}

function getIterator(input) {
  return input[Symbol.asyncIterator] === undefined ? input[Symbol.iterator]() : input[Symbol.asyncIterator]();
}

async function closeIterator(iterator) {
  try {
    await iterator.return?.();
  } catch {}
}

function createPuller(iterator) {
  let isSourceDone = false;

  const markDone = item => {
    if (item?.done) {
      isSourceDone = true;
    }
  };

  return () => {
    if (isSourceDone) {
      return {done: true};
    }

    const result = iterator.next();
    markDone(result);

    if (typeof result?.then !== "function") {
      return result;
    }

    result.then(markDone, () => {});
    return result;
  };
}
