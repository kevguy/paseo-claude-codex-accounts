import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

process.stdout.write('\u001b[32mOpen https://claude.ai/oauth/authorize?client_id=fake&state=xyz\u001b[0m\n');
if (process.env.FAKE_LOCAL_URL === '1') {
  const browser = spawn(process.env.BROWSER, ['http://localhost:54545/callback'], { stdio: 'ignore' });
  browser.unref();
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once('line', (line) => {
  if (line === 'good#state') process.exit(0);
  process.stderr.write('Invalid code\n');
  setTimeout(() => process.exit(1), 25);
});
