export function encodeVector(vec: number[]): Buffer {
	const f32 = new Float32Array(vec)
	return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

// Bun.redis decodes all responses as UTF-8, which destroys bytes >= 0x80.
// We store a base64 copy (_vec field) alongside the raw binary (vec field).
// The raw binary is for RediSearch HNSW indexing; base64 is for reading back.

export function encodeVectorBase64(vec: number[]): string {
	return encodeVector(vec).toString("base64")
}

export function decodeVectorBase64(b64: string): number[] {
	const buf = Buffer.from(b64, "base64")
	// Float32Array silently truncates non-multiple-of-4 byte lengths, which would
	// silently corrupt vectors. Reject explicitly so callers get a clear error.
	if (buf.byteLength % 4 !== 0) {
		throw new Error(`Vector buffer length must be a multiple of 4 bytes (got ${buf.byteLength})`)
	}
	// Float32Array also requires byteOffset to be a multiple of 4. Buffer.from(b64)
	// returns a view into Bun's pool, so the offset can be arbitrary — copy into a
	// fresh ArrayBuffer to guarantee alignment.
	const aligned = new Uint8Array(buf.byteLength)
	aligned.set(buf)
	const f32 = new Float32Array(aligned.buffer)
	return Array.from(f32)
}
