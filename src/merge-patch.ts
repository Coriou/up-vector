/** RFC 7396 over JSON values, without Lua cjson's array/number conversions. */
export function mergePatch(target: unknown, patch: unknown): unknown {
	if (!isObject(patch)) return patch
	// A null-prototype output makes __proto__/constructor ordinary JSON keys.
	const result: Record<string, unknown> = Object.assign(
		Object.create(null),
		isObject(target) ? target : {},
	)
	// Iterative traversal avoids overflowing the stack on nested legal metadata.
	const pending = [{ target: result, patch }]
	while (pending.length > 0) {
		const item = pending.pop()
		if (!item) break
		for (const [key, value] of Object.entries(item.patch)) {
			if (value === null) {
				delete item.target[key]
			} else if (isObject(value)) {
				const child = Object.assign(
					Object.create(null),
					isObject(item.target[key]) ? item.target[key] : {},
				)
				item.target[key] = child
				pending.push({ target: child, patch: value })
			} else {
				item.target[key] = value
			}
		}
	}
	return result
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
