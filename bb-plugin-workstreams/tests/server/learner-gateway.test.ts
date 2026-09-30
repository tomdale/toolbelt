import { afterEach, expect, it, vi } from "vitest";
import { gatewayAgentTurn } from "../../src/server/inference/gateway.ts";
afterEach(()=>vi.unstubAllGlobals());
it("uses native tools and conversational messages without imposing JSON facts",async()=>{
  const fetcher=vi.fn(async (_url:unknown,args:RequestInit)=>{
    const body=JSON.parse(args.body as string);
    expect(body.tools[0].name).toBe("read_thread");
    expect(body.messages[0].content[0].text).toBe("Understand this conversation");
    expect(body.system).toBe("Write useful notes.");
    return new Response(JSON.stringify({content:[{type:"tool_use",id:"c1",name:"read_thread",input:{threadId:"t1"}}],stop_reason:"tool_use",usage:{input_tokens:20,output_tokens:5}}),{status:200});
  });
  vi.stubGlobal("fetch",fetcher);
  const turn=await gatewayAgentTurn({system:"Write useful notes.",model:"test/model",messages:[{role:"user",content:[{type:"text",text:"Understand this conversation"}]}],tools:[{name:"read_thread",description:"Read",input_schema:{type:"object",properties:{threadId:{type:"string"}}}}],apiKey:"test"});
  expect(turn.content[0]).toMatchObject({type:"tool_use",name:"read_thread"});
  expect(turn.stopReason).toBe("tool_use");
});
