import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNativePageContent } from '../src/takeoff-v2/native-content-classifier.ts';

test('classifies vector-native plan sheets and readable native text', () => {
  assert.deepEqual(classifyNativePageContent({ textCharacters: 420, vectorOperations: 900, imageOperations: 0, replacementCharacters: 0 }), {
    contentKind: 'vector', textQuality: 'good',
  });
});

test('classifies scanned sheets as raster with no native text', () => {
  assert.deepEqual(classifyNativePageContent({ textCharacters: 0, vectorOperations: 0, imageOperations: 2, replacementCharacters: 0 }), {
    contentKind: 'raster', textQuality: 'none',
  });
});

test('classifies hybrid pages as mixed and sparse text as partial', () => {
  assert.deepEqual(classifyNativePageContent({ textCharacters: 32, vectorOperations: 20, imageOperations: 1, replacementCharacters: 0 }), {
    contentKind: 'mixed', textQuality: 'partial',
  });
});

test('flags heavily corrupted extracted text as unreadable', () => {
  assert.deepEqual(classifyNativePageContent({ textCharacters: 100, vectorOperations: 5, imageOperations: 0, replacementCharacters: 30 }), {
    contentKind: 'vector', textQuality: 'unreadable',
  });
});

test('blank pages are distinguished from unknown low-signal content', () => {
  assert.deepEqual(classifyNativePageContent({ textCharacters: 0, vectorOperations: 0, imageOperations: 0, replacementCharacters: 0 }), {
    contentKind: 'blank', textQuality: 'none',
  });
  assert.deepEqual(classifyNativePageContent({ textCharacters: 1, vectorOperations: 0, imageOperations: 0, replacementCharacters: 0 }), {
    contentKind: 'vector', textQuality: 'partial',
  });
});

test('invalid stats fail closed', () => {
  assert.throws(() => classifyNativePageContent({ textCharacters: -1, vectorOperations: 0, imageOperations: 0, replacementCharacters: 0 }), /non-negative integers/i);
  assert.throws(() => classifyNativePageContent({ textCharacters: 10, vectorOperations: 0, imageOperations: 0, replacementCharacters: 11 }), /replacement/i);
});
