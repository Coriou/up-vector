// Kept separate from the client and index modules to avoid a circular import.
let generation = 0
export function redisGeneration(): number {
	return generation
}
export function advanceRedisGeneration(): void {
	generation++
}
