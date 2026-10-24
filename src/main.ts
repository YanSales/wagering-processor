import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3000;

function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`PORT inválida: "${raw}". Use um inteiro entre 1 e 65535.`);
  }
  return port;
}

async function bootstrap(): Promise<void> {
  const port = resolvePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(port);
}

await bootstrap();
