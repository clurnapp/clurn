// Entrada do Workers (o `main` do wrangler.toml). Só liga as peças: o pedido vai para handle() (worker.ts) e o
// Durable Object Cotas delega para o contador de cotas.ts. Este arquivo importa cloudflare:workers, que só existe no
// Workers; por isso a lógica fica nos outros dois, que os testes rodam no Node (test/proxy/).

import { DurableObject } from 'cloudflare:workers';
import { Cotas as CotasCore, type CotasStorage } from './cotas.ts';
import worker from './worker.ts';

export class Cotas extends DurableObject {
  core: CotasCore;
  constructor(ctx: { storage: CotasStorage }, env: unknown) {
    // @ts-ignore: o tipo do ctx é o DurableObjectState do Workers (sem @cloudflare/workers-types aqui)
    super(ctx, env);
    this.core = new CotasCore({ storage: ctx.storage });
  }
  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
  alarm(): Promise<void> {
    return this.core.alarm();
  }
}

export default worker;
