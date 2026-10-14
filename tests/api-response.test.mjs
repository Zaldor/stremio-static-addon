import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiJson } from '../site/api-response.js';

test('reads successful JSON responses', async () => {
  const result = await readApiJson(new Response(JSON.stringify({ candidates: [] }), {
    headers: { 'content-type': 'application/json' }
  }), 'Page analysis');
  assert.deepEqual(result, { candidates: [] });
});

test('uses JSON error details for API failures', async () => {
  await assert.rejects(
    readApiJson(new Response(JSON.stringify({ error: 'Rendered page request returned HTTP 503.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    }), 'Page analysis'),
    /Rendered page request returned HTTP 503\./
  );
});

test('explains an HTML edge error instead of exposing the JSON parse exception', async () => {
  await assert.rejects(
    readApiJson(new Response('<!DOCTYPE html><html><head><title>Worker threw exception</title></head><body>Error code: 1101</body></html>', {
      status: 500,
      headers: { 'content-type': 'text/html; charset=UTF-8' }
    }), 'Page analysis'),
    /Page analysis received an HTML page instead of JSON \(HTTP 500; “Worker threw exception”; error code 1101\)/
  );
});

test('reports other invalid response bodies with their status', async () => {
  await assert.rejects(
    readApiJson(new Response('unexpected gateway payload', { status: 502 }), 'Test & preview'),
    /Test & preview returned an invalid response \(HTTP 502\)\./
  );
});
