import { Hono } from "hono"
import { z } from "zod"
import { getEmbeddingProvider } from "../embedding"
import { EmbeddingProviderError } from "../errors"
import { getClient } from "../redis"
import { EMBEDDING_NS_REGISTRY, validateNamespace } from "../translate/keys"
import { type DenseQuery, executeQuery } from "./query"
import { upsertDenseVectors } from "./upsert"

const MAX_BATCH_SIZE = 1000
const MAX_BATCH_QUERIES = 100
const MAX_TOP_K = 1000
const MAX_DATA_LENGTH = 1_000_000
const UnsupportedField = z.never().optional()

const idSchema = z
	.union([
		z.string(),
		z.number().refine((n) => Number.isFinite(n), "Vector ID must be a finite number"),
	])
	.transform(String)

const dataSchema = z
	.string()
	.min(1, "Data must not be empty")
	.max(MAX_DATA_LENGTH, `Data must not exceed ${MAX_DATA_LENGTH} characters`)

const UpsertDataItem = z.object({
	id: idSchema,
	data: dataSchema,
	metadata: z.record(z.string(), z.unknown()).optional(),
	vector: UnsupportedField,
	sparseVector: UnsupportedField,
})

const UpsertDataBody = z.union([
	UpsertDataItem,
	z
		.array(UpsertDataItem)
		.min(1, "Batch must contain at least one item")
		.max(MAX_BATCH_SIZE, `Batch size must not exceed ${MAX_BATCH_SIZE}`),
])

const DataQuerySchema = z.object({
	data: dataSchema,
	vector: UnsupportedField,
	sparseVector: UnsupportedField,
	topK: z.number().int().positive().max(MAX_TOP_K).default(10),
	includeMetadata: z.boolean().default(false),
	includeVectors: z.boolean().default(false),
	includeData: z.boolean().default(false),
	weightingStrategy: UnsupportedField,
	fusionAlgorithm: UnsupportedField,
	queryMode: UnsupportedField,
	filter: z.string().min(1, "Filter must not be empty").optional(),
})

const QueryDataBody = z.union([
	DataQuerySchema,
	z
		.array(DataQuerySchema)
		.min(1, "Batch must contain at least one query")
		.max(MAX_BATCH_QUERIES, `Batch must not exceed ${MAX_BATCH_QUERIES} queries`),
])

export const dataRoutes = new Hono()

dataRoutes.post("/upsert-data/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = UpsertDataBody.parse(body)
	const items = Array.isArray(parsed) ? parsed : [parsed]
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)

	const embeddings = await embedText(items.map((item) => item.data))
	const vectors = items.map((item, index) => ({
		id: item.id,
		vector: embeddings[index],
		metadata: item.metadata,
		data: item.data,
	}))
	await upsertDenseVectors(ns, vectors)
	await getClient().sadd(EMBEDDING_NS_REGISTRY, ns)

	return c.json({ result: "Success" })
})

dataRoutes.post("/query-data/:namespace?", async (c) => {
	const body = await c.req.json()
	const parsed = QueryDataBody.parse(body)
	const ns = c.req.param("namespace") ?? ""
	validateNamespace(ns)

	const isBatch = Array.isArray(parsed)
	const queries = isBatch ? parsed : [parsed]
	const embeddings = await embedText(queries.map((query) => query.data))

	const results = await Promise.all(
		queries.map((query, index) => executeQuery(ns, toDenseQuery(query, embeddings[index]))),
	)

	if (isBatch && queries.length > 1) {
		return c.json({ result: results })
	}
	return c.json({ result: results[0] })
})

async function embedText(inputs: string[]): Promise<number[][]> {
	const embeddings = await getEmbeddingProvider().embedMany(inputs)
	if (embeddings.length !== inputs.length) {
		throw new EmbeddingProviderError(
			`Embedding provider returned ${embeddings.length} embeddings for ${inputs.length} inputs`,
			502,
		)
	}
	return embeddings
}

type ParsedDataQuery = z.infer<typeof DataQuerySchema>

function toDenseQuery(query: ParsedDataQuery, vector: number[]): DenseQuery {
	return {
		vector,
		topK: query.topK,
		includeMetadata: query.includeMetadata,
		includeVectors: query.includeVectors,
		includeData: query.includeData,
		filter: query.filter,
	}
}
