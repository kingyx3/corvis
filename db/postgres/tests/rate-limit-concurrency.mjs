import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const sql = "select allowed from corvis_control.consume_api_rate_limit('11111111-1111-1111-1111-111111111111','concurrent',7)";
const results = await Promise.all(Array.from({ length: 30 }, () => exec('psql', ['-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql])));
assert.equal(results.filter(({ stdout }) => stdout.trim() === 't').length, 7);
assert.equal(results.filter(({ stdout }) => stdout.trim() === 'f').length, 23);
console.log('30 independent connections: exactly 7 admitted and 23 denied');
