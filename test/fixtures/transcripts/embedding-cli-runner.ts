/** Isolated real CLI/engine/gateway fixture; the parent test spawns this program. */
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { runTranscripts } from '../../../src/commands/transcripts.ts';
import { runTranscriptsIngest } from '../../../src/core/transcripts/ingest.ts';
import { configureGateway, __setEmbedTransportForTests } from '../../../src/core/ai/gateway.ts';
import { currentExitCode } from '../../../src/core/cli-force-exit.ts';

const [path, unrelated, mode, initial] = Bun.argv.slice(2);
const shouldFail = mode === 'fail';
const initialEmbed = initial === 'embed';
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN fixture_embedding vector(1024)');
await engine.setConfig('search_embedding_column','fixture_embedding');
await engine.setConfig('embedding_columns',JSON.stringify({fixture_embedding:{type:'vector',dimensions:1024,provider:'openai:text-embedding-3-small'}}));
configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1024,env:{OPENAI_API_KEY:'sk-test-fake'}});
let calls=0, fail=false;
__setEmbedTransportForTests(async ({values}) => {
  calls++;
  if (fail) throw new Error('deliberate non-transient provider failure');
  return {embeddings:values.map(() => new Array(1024).fill(0.001)),usage:{tokens:values.length}} as never;
});
const logs: string[]=[];
const print=console.log.bind(console);
console.log=(msg)=>logs.push(String(msg));
const args=['ingest',path,'--format','codex','--source-id','default','--json','--quiet'];
const run=async(embed: boolean)=>{
  await runTranscripts(engine, embed?[...args,'--embed']:args);
  const output = logs.pop();
  if (!output) throw new Error('Native transcript command produced no JSON result');
  return JSON.parse(output);
};
const first=await run(initialEmbed);
await runTranscriptsIngest(engine,{paths:[unrelated],format:'codex',sourceId:'default'});
await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other','other')");
await runTranscriptsIngest(engine,{paths:[path],format:'codex',sourceId:'other'});
await engine.executeRaw("UPDATE op_checkpoints SET updated_at='2000-01-01T00:00:00Z' WHERE op='transcripts-ingest'");
const checkpointBefore=await engine.executeRaw("SELECT completed_keys,updated_at::text FROM op_checkpoints WHERE op='transcripts-ingest'");
const missing=async()=>await engine.executeRaw(
  "SELECT p.source_id,p.slug,count(*)::int AS count FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE cc.fixture_embedding IS NULL GROUP BY p.source_id,p.slug ORDER BY p.source_id,p.slug"
);
const before=await missing();
fail=shouldFail;
const second=await run(true);
const callsAfterSecond=calls;
const after=await missing();
const checkpointAfter=await engine.executeRaw("SELECT completed_keys,updated_at::text FROM op_checkpoints WHERE op='transcripts-ingest'");
const third=shouldFail ? null : await run(true);
const facts=await engine.executeRaw('SELECT count(*)::int AS count FROM facts');
const legacy=await engine.executeRaw('SELECT count(*)::int AS count FROM content_chunks WHERE embedding IS NULL');
await engine.disconnect();
print(JSON.stringify({first,second,third,calls,callsAfterSecond,before,after,checkpointBefore,checkpointAfter,facts,legacy}));
process.exit(currentExitCode());
