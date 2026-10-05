export type ArtifactDiffLine = { kind: "same" | "added" | "removed"; text: string };

const maxComparedLines = 400;

export function compareArtifactText(oldText: string, currentText: string): ArtifactDiffLine[] | undefined {
  const oldLines = oldText.split("\n");
  const currentLines = currentText.split("\n");
  if (oldLines.length > maxComparedLines || currentLines.length > maxComparedLines) return undefined;

  const lengths = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(currentLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let currentIndex = currentLines.length - 1; currentIndex >= 0; currentIndex--) {
      lengths[oldIndex][currentIndex] = oldLines[oldIndex] === currentLines[currentIndex]
        ? lengths[oldIndex + 1][currentIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][currentIndex], lengths[oldIndex][currentIndex + 1]);
    }
  }

  const result: ArtifactDiffLine[] = [];
  let oldIndex = 0;
  let currentIndex = 0;
  while (oldIndex < oldLines.length || currentIndex < currentLines.length) {
    if (oldIndex < oldLines.length && currentIndex < currentLines.length && oldLines[oldIndex] === currentLines[currentIndex]) {
      result.push({ kind: "same", text: oldLines[oldIndex] });
      oldIndex++;
      currentIndex++;
    } else if (oldIndex < oldLines.length && (currentIndex === currentLines.length || lengths[oldIndex + 1][currentIndex] >= lengths[oldIndex][currentIndex + 1])) {
      result.push({ kind: "removed", text: oldLines[oldIndex++] });
    } else {
      result.push({ kind: "added", text: currentLines[currentIndex++] });
    }
  }
  return result;
}
