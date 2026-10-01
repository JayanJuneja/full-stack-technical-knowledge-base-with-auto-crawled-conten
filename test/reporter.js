/**
 * Plain-text node:test reporter (no ANSI colours) that ends with a pytest-style
 * summary line, e.g. "29 passed, 0 failed in 0.68s", so CI logs are easy to grep.
 */
export default async function* reporter(source) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const start = Date.now();
  const failures = [];
  for await (const event of source) {
    // Only count leaf tests (nesting 0 here since the suite uses top-level tests).
    if (event.type === 'test:pass' && event.data.details?.type !== 'suite') {
      if (event.data.skip || event.data.todo) {
        skipped++;
        yield `- SKIP ${event.data.name}\n`;
      } else {
        passed++;
        yield `ok   ${event.data.name}\n`;
      }
    } else if (event.type === 'test:fail' && event.data.details?.type !== 'suite') {
      failed++;
      const err = event.data.details?.error;
      failures.push(`${event.data.name} (${event.data.file ?? ''}:${event.data.line ?? ''})\n  ${err?.cause?.message ?? err?.message ?? err}`);
      yield `FAIL ${event.data.name}\n`;
    } else if (event.type === 'test:stderr' || event.type === 'test:stdout') {
      yield event.data.message;
    }
  }
  if (failures.length) yield `\nFailures:\n${failures.join('\n')}\n`;
  yield `\n# pass ${passed}\n# fail ${failed}\n`;
  yield `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} in ${((Date.now() - start) / 1000).toFixed(2)}s\n`;
}
