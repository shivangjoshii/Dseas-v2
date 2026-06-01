export function dotProduct(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  let total = 0;

  for (let index = 0; index < length; index += 1) {
    total += left[index] * right[index];
  }

  return total;
}

export function l2Normalize(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));

  if (norm <= 1e-6) {
    return vector;
  }

  return vector.map((value) => value / norm);
}

export function faceDistance(knownEncodings: number[][], candidate: number[]) {
  return knownEncodings.map((encoding) => 1 - dotProduct(encoding, candidate));
}

export function compareFaces(knownEncodings: number[][], candidate: number[], tolerance = 0.55) {
  return faceDistance(knownEncodings, candidate).map((distance) => distance <= tolerance);
}

export function findBestEmbeddingMatch(
  database: Record<string, { name: string; embeddings: number[][] }>,
  candidate: number[],
  minimumSimilarity = 0.45,
) {
  let bestMatch: { person_id: string; name: string; similarity: number } | null = null;

  for (const [personId, record] of Object.entries(database)) {
    for (const embedding of record.embeddings) {
      const similarity = dotProduct(embedding, candidate);

      if (similarity >= minimumSimilarity && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = {
          person_id: personId,
          name: record.name,
          similarity,
        };
      }
    }
  }

  return bestMatch;
}
