export function shouldUseNativeBbTodo(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.BB_THREAD_ID);
}
