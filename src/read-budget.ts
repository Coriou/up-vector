import { ValidationError } from "./errors"
import { requestContext } from "./request-context"
import { MAX_DATA_LENGTH, MAX_METADATA_BYTES } from "./routes/upsert"

// Conservative serialized projection budget, not an RSS guarantee. Reserve
// before Redis transfers fields and before decoding vectors. Use the stored
// field limits, so a small request cannot retrieve arbitrarily fat rows.
export const MAX_PROJECTED_READ_BYTES = 64 * 1024 * 1024
export function reserveReadProjection(
	count: number,
	opts: { includeVectors: boolean; includeMetadata: boolean; includeData: boolean },
	dimension = 16384,
): void {
	// IDs/data may need six JSON bytes per UTF-16 code unit (e.g. controls).
	// A finite float32 rendered as a JS number fits in 25 bytes including comma.
	const perRow =
		1024 * 6 +
		128 +
		(opts.includeVectors ? dimension * 25 : 0) +
		(opts.includeMetadata ? MAX_METADATA_BYTES : 0) +
		(opts.includeData ? MAX_DATA_LENGTH * 6 : 0)
	const request = requestContext.getStore()
	const total = (request?.projectedReadBytes ?? 0) + count * perRow
	if (total > MAX_PROJECTED_READ_BYTES) {
		throw new ValidationError(
			"Projected read exceeds 64 MiB; reduce result count, batch size or include flags",
		)
	}
	if (request) request.projectedReadBytes = total
}
