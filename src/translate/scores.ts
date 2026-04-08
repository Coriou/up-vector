import type { DistanceMetric } from "../types"

/**
 * Convert a Redis distance value into the [0, 1] similarity score that Upstash
 * Vector exposes (1 = identical, 0 = farthest). Each metric has its own
 * conversion because Redis reports different distance functions, and several
 * of them can produce out-of-range values for non-unit vectors — we clamp the
 * final score to [0, 1] to keep API consumers from seeing values like 1.5.
 *
 * - COSINE      Redis returns `1 - cos_sim` (range 0..2). Upstash wants
 *               `(1 + cos_sim) / 2` = `1 - dist/2`.
 * - EUCLIDEAN   Redis returns squared L2 distance (>= 0). Upstash wants a
 *               bounded similarity, so we use `1 / (1 + dist)`.
 * - DOT_PRODUCT Redis returns the negative dot product. For unit vectors that
 *               sits in [-1, 1] and `(1 + dot)/2` is well-defined; for
 *               non-unit vectors it can exceed [0, 1], so we clamp.
 */
export function normalizeScore(rawDistance: number, metric: DistanceMetric): number {
	if (Number.isNaN(rawDistance)) return Number.NaN

	let score: number
	switch (metric) {
		case "COSINE":
			score = 1 - rawDistance / 2
			break
		case "EUCLIDEAN":
			score = 1 / (1 + rawDistance)
			break
		case "DOT_PRODUCT":
			score = (1 - rawDistance) / 2
			break
	}

	if (score < 0) return 0
	if (score > 1) return 1
	return score
}
