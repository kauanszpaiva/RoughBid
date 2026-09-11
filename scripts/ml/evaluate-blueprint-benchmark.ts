import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateBlueprintBenchmark } from '../../apps/api/src/ml/benchmark.ts';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node --experimental-strip-types scripts/ml/evaluate-blueprint-benchmark.ts <benchmark.json>');
  process.exitCode = 2;
} else {
  try {
    const raw = await readFile(resolve(inputPath), 'utf8');
    const report = evaluateBlueprintBenchmark(JSON.parse(raw));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Benchmark evaluation failed.');
    process.exitCode = 1;
  }
}
