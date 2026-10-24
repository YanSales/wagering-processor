// biome-ignore lint/style/useImportType: o Nest precisa da classe em runtime para injetar o MikroORM.
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { createOrmConfig } from './orm.config';

/**
 * No MikroORM 7, `connect()` apenas inicializa o pool; a primeira conexão real ocorre na primeira
 * query. Validar com `select 1` no bootstrap faz a aplicação falhar logo na inicialização quando o
 * banco está inacessível ou as credenciais estão erradas.
 */
@Injectable()
class DatabaseConnector implements OnModuleInit {
  constructor(private readonly orm: MikroORM) {}

  async onModuleInit(): Promise<void> {
    await this.orm.connect();
    const check = await this.orm.checkConnection();
    if (!check.ok) {
      throw new Error(`Falha ao conectar ao PostgreSQL: ${check.reason}`);
    }
  }
}

@Module({
  imports: [
    // `forRootAsync` lê o ambiente durante o bootstrap, e não na importação do módulo.
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      useFactory: () => createOrmConfig(),
    }),
  ],
  providers: [DatabaseConnector],
})
export class DatabaseModule {}
