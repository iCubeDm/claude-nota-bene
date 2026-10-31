import readline from 'node:readline';
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
let initialized = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  else if (m.method === 'initialized') initialized = true;
  else if (m.method === 'echo') send({ id: m.id, result: { ...m.params, initialized } });
  else if (m.method === 'delayed') setTimeout(() => send({ id: m.id, result: m.params.value }), m.params.ms);
  else if (m.method === 'serverAsk') {
    send({ id: 200, method: 'item/commandExecution/requestApproval', params: { command: 'echo fixture' } });
    send({ id: m.id, result: true });
  } else if (m.id === 200 && !m.method) send({ method: 'approved', params: m.result });
  else if (m.method === 'fragment') {
    const data = JSON.stringify({ id: m.id, result: 'Привет' }) + '\n';
    const bytes = Buffer.from(data);
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
  } else if (m.method === 'oversized') process.stdout.write('x'.repeat(2000));
  else if (m.method === 'malformed') process.stdout.write('not json\n');
  else if (m.method === 'exit') process.exit(7);
}
