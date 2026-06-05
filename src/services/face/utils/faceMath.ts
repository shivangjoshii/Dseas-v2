export function dotProduct(left: Float32Array | number[], right: Float32Array | number[]) {
  const count = Math.min(left.length, right.length);
  let sum = 0;

  const end = count & ~3;
  for (let i = 0; i < end; i += 4) {
    sum +=
      left[i] * right[i] +
      left[i + 1] * right[i + 1] +
      left[i + 2] * right[i + 2] +
      left[i + 3] * right[i + 3];
  }

  for (let i = end; i < count; i++) {
    sum += left[i] * right[i];
  }

  return sum;
}

export function l2Normalize(vector: number[] | Float32Array) {
  let sumSq = 0;
  const count = vector.length;

  for (let i = 0; i < count; i++) {
    sumSq += vector[i] * vector[i];
  }

  const norm = Math.sqrt(sumSq);
  if (norm <= 1e-6) return vector instanceof Float32Array ? vector : new Float32Array(vector);

  const result = new Float32Array(count);
  const invNorm = 1 / norm;

  for (let i = 0; i < count; i++) {
    result[i] = vector[i] * invNorm;
  }

  return result;
}

export function faceDistance(database: (Float32Array | number[])[], vector: Float32Array | number[]) {
  return database.map((ref) => 1 - dotProduct(ref, vector));
}

export function compareFaces(database: (Float32Array | number[])[], vector: Float32Array | number[], tolerance = 0.55) {
  return faceDistance(database, vector).map((dist) => dist <= tolerance);
}

export function findBestEmbeddingMatch(
  database: Record<string, { name: string; embeddings: (Float32Array | number[])[] }>,
  candidate: Float32Array | number[],
  minSimilarity = 0.45,
) {
  let best: { person_id: string; name: string; similarity: number } | null = null;
  const candArr = candidate instanceof Float32Array ? candidate : new Float32Array(candidate);

  for (const [id, record] of Object.entries(database)) {
    for (const emb of record.embeddings) {
      const embArr = emb instanceof Float32Array ? emb : new Float32Array(emb);
      const similarity = dotProduct(embArr, candArr);

      if (similarity >= minSimilarity && (!best || similarity > best.similarity)) {
        best = { person_id: id, name: record.name, similarity: similarity };
      }
    }
  }

  return best;
}
