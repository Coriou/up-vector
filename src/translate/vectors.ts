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
	const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
	return Array.from(f32)
}
