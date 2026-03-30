import type { DistanceMetric } from "../types"

export function normalizeScore(rawDistance: number, metric: DistanceMetric): number {
	switch (metric) {
		case "COSINE":
			// Redis: 1 - cos_sim (0 = identical, 2 = opposite)
			// Upstash: (1 + cos_sim) / 2 (1 = identical, 0 = opposite)
			return 1 - rawDistance / 2
		case "EUCLIDEAN":
			// Redis: squared L2 distance (0 = identical)
			// Upstash: 1 / (1 + squared_distance) (1 = identical, 0 = far)
			return 1 / (1 + rawDistance)
		case "DOT_PRODUCT":
			// Redis: negative dot product (more negative = more similar)
			// Upstash: (1 + dot_product) / 2
			return (1 - rawDistance) / 2
	}
}
