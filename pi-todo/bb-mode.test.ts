import { test } from "node:test";
import { strict as assert } from "node:assert";
import { shouldUseNativeBbTodo } from "./bb-mode.ts";

test("standalone Pi keeps its todo extension", () => {
	assert.equal(shouldUseNativeBbTodo({}), false);
});

test("BB-launched Pi defers Todo to the native BB tool", () => {
	assert.equal(shouldUseNativeBbTodo({ BB_THREAD_ID: "thr_bb" }), true);
});
