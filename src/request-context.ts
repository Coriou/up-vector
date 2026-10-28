import { AsyncLocalStorage } from "node:async_hooks"
import { HTTPException } from "hono/http-exception"

export const requestContext = new AsyncLocalStorage<{
	deadline: number
	expired: boolean
	projectedReadBytes?: number
}>()

export function assertRequestActive(): void {
	const request = requestContext.getStore()
	if (request && (request.expired || Date.now() >= request.deadline)) {
		throw new HTTPException(504, { message: "Request Timeout" })
	}
}

/** Guard at invocation, including handles acquired before an awaited command. */
export function guardRedisCommands<T extends object>(client: T): T {
	return new Proxy(client, {
		get(target, property) {
			const value = Reflect.get(target, property, target)
			if (typeof value !== "function") return value
			return (...args: unknown[]) => {
				assertRequestActive()
				return Reflect.apply(value, target, args)
			}
		},
	})
}
