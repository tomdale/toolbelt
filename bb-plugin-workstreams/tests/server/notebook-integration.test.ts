import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { Notebooks } from "../../src/server/notebooks.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | undefined;
afterEach(async () => { await world?.harness.lifecycle.dispose(); world = undefined; vi.restoreAllMocks(); });
describe("notebook integration", () => {
  it("exposes plain notebooks and brief without structured account APIs", async () => {
    world = await fakeWorld({ settings: { understandingAutomatic: false } });
    const overview = await world.harness.behavior.callRpc("notebookOverview",{});
    expect(overview).toMatchObject({ brief: {text:""},notebooks:[],runs:[] });
    const cli = await world.harness.behavior.runCli(["understanding","--json"]);
    expect(JSON.parse(cli.stdout)).toMatchObject({ notebooks:[] });
  });
  it("passes shared brief into triage without waiting for learning", async () => {
    let release!:()=>void;
    vi.spyOn(Notebooks.prototype,"observe").mockReturnValue(new Promise<void>(r=>{release=r;}));
    vi.spyOn(Notebooks.prototype,"context").mockReturnValue("Recap belongs to Workstreams.");
    world = await fakeWorld({ settings: {understandingAutomatic:true} });
    world.addThread("t1");
    const result=await world.harness.behavior.runCli(["analyze","t1"]);
    expect(result.exitCode).toBe(0);
    expect(world.completions.some(c=>c.prompt.includes("Recap belongs to Workstreams."))).toBe(true);
    release();
  });
  it("asking is explicit, and learning and asking cannot be requested together", async () => {
    world=await fakeWorld({settings:{understandingAutomatic:false}});
    const invalid=await world.harness.behavior.runCli(["understanding","--learn","t","--ask","why"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(world.completions).toHaveLength(0);
  });
});
