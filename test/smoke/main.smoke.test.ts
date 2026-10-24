import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';

const MAIN_PATH = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const STARTUP_TIMEOUT_MS = 10_000;

function findFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) {
    throw new Error('Não foi possível reservar uma porta livre.');
  }
  return port;
}

async function waitUntilLive(url: string, child: Subprocess): Promise<Response> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`O processo encerrou durante o boot (código ${child.exitCode}).`);
    }
    try {
      return await fetch(url);
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Aplicação não respondeu em ${STARTUP_TIMEOUT_MS} ms.`);
}

describe('smoke: bun src/main.ts', () => {
  const port = findFreePort();
  let child: Subprocess;

  beforeAll(() => {
    child = Bun.spawn([process.execPath, MAIN_PATH], {
      env: { ...process.env, PORT: String(port) },
      stdout: 'ignore',
      stderr: 'inherit',
    });
  });

  afterAll(async () => {
    child.kill();
    await child.exited;
  });

  test(
    'sobe a aplicação e responde GET /health/live',
    async () => {
      const response = await waitUntilLive(`http://127.0.0.1:${port}/health/live`, child);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    },
    STARTUP_TIMEOUT_MS + 2_000,
  );
});
