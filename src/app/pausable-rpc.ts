// RPC que espera em vez de falhar: quando o RPC morre (créditos esgotados ou rede fora, já depois das
// novas tentativas do cliente de dentro), toda chamada fica esperando até a pessoa trocar o RPC (replace)
// ou desistir (stop). Os erros daqui não levam URL (a chave do RPC nunca aparece).
import { CodedError } from '../core/limpeza/errors.ts';
import { isFatalRpcError, RpcError, type RpcClient } from '../core/solana/rpc.ts';

export type PauseReason = 'rpc-quota' | 'network-down';

// Não é RpcError de propósito: quem trata RpcError (ex.: laço de envio) insistiria; este erro encerra a tarefa.
export class StopRequested extends CodedError {
  constructor() {
    super('parado pelo usuário', 'stopped-by-user');
    this.name = 'StopRequested';
  }
}

export type PausableRpc = RpcClient & {
  replace(next: RpcClient): void;
  stop(): void;
  paused(): PauseReason | null;
  stopped(): boolean;
};

export function createPausableRpc(inner: RpcClient, onPause: (r: PauseReason) => void): PausableRpc {
  let current = inner;
  let stopped = false;
  let pause: { reason: PauseReason; wake: () => void; wait: Promise<void> } | null = null;

  function startPause(reason: PauseReason) {
    let wake!: () => void;
    const wait = new Promise<void>((r) => { wake = r; });
    pause = { reason, wake, wait };
    try {
      onPause(reason); // quem escuta nunca derruba a chamada
    } catch { /* aviso é só informação */ }
  }

  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      for (;;) {
        if (stopped) throw new StopRequested();
        if (pause) {
          await pause.wait;
          continue;
        }
        const used = current;
        try {
          return await used.call<T>(method, params);
        } catch (e) {
          if (!isFatalRpcError(e)) throw e;
          if (stopped) throw new StopRequested();
          // Chamadas já na fila do RPC antigo continuam tentando a URL antiga até falhar (RpcClient não tem abort):
          // custa tempo, mas não duplica envio.
          if (used !== current) continue; // o RPC já foi trocado enquanto esta chamada falhava: repete no novo
          if (!pause) startPause((e as RpcError).kind === 'quota' ? 'rpc-quota' : 'network-down');
          // volta ao topo do laço e espera a pausa acabar
        }
      }
    },
    replace(next: RpcClient) {
      current = next;
      const p = pause;
      pause = null;
      p?.wake();
    },
    stop() {
      stopped = true;
      const p = pause;
      pause = null;
      p?.wake();
    },
    paused: () => pause?.reason ?? null,
    stopped: () => stopped,
  };
}
