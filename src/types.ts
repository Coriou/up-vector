export type DistanceMetric = "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT"

export type Vector = {
	id: string
	vector?: number[]
	metadata?: Record<string, unknown>
	data?: string
}

export type UpsertVector = {
	id: string | number
	vector: number[]
	metadata?: Record<string, unknown>
	data?: string
}

export type SuccessResponse<T> = { result: T }
export type ErrorResponse = { error: string; status: number }

export type RangeResult = {
	nextCursor: string
	vectors: Vector[]
}

export type QueryResult = {
	id: string
	score: number
	vector?: number[]
	metadata?: Record<string, unknown>
	data?: string
}

export type InfoResult = {
	vectorCount: number
	pendingVectorCount: number
	indexSize: number
	dimension: number
	similarityFunction: string
	namespaces: Record<string, { vectorCount: number; pendingVectorCount: number }>
}
