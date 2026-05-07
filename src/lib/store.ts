export class Store<T> {
	private value: T;
	private subs = new Set<(v: T) => void>();
	constructor(initial: T) {
		this.value = initial;
	}
	get(): T {
		return this.value;
	}
	set(patch: Partial<T> | ((v: T) => T)): void {
		this.value =
			typeof patch === "function"
				? (patch as (v: T) => T)(this.value)
				: { ...this.value, ...patch };
		this.subs.forEach((fn) => fn(this.value));
	}
	subscribe(fn: (v: T) => void): () => void {
		this.subs.add(fn);
		fn(this.value);
		return () => this.subs.delete(fn);
	}
}
