export type NativePageContentStats = {
  textCharacters: number;
  vectorOperations: number;
  imageOperations: number;
  replacementCharacters: number;
};

export type NativePageContentClassification = {
  contentKind: 'vector' | 'raster' | 'mixed' | 'blank' | 'unknown';
  textQuality: 'good' | 'partial' | 'none' | 'unreadable' | 'unknown';
};

const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function classifyNativePageContent(stats: NativePageContentStats): NativePageContentClassification {
  if (![stats.textCharacters, stats.vectorOperations, stats.imageOperations, stats.replacementCharacters].every(isCount)) {
    throw new RangeError('Native PDF content stats must be non-negative integers.');
  }
  if (stats.replacementCharacters > stats.textCharacters) {
    throw new RangeError('Replacement character count cannot exceed text character count.');
  }

  const hasText = stats.textCharacters > 0;
  const hasVector = stats.vectorOperations > 0 || hasText;
  const hasRaster = stats.imageOperations > 0;
  const contentKind = hasVector && hasRaster ? 'mixed'
    : hasVector ? 'vector'
      : hasRaster ? 'raster'
        : 'blank';

  let textQuality: NativePageContentClassification['textQuality'];
  if (!hasText) textQuality = 'none';
  else {
    const replacementRatio = stats.replacementCharacters / stats.textCharacters;
    if (replacementRatio >= 0.2) textQuality = 'unreadable';
    else if (stats.textCharacters >= 100) textQuality = 'good';
    else textQuality = 'partial';
  }

  return { contentKind, textQuality };
}
