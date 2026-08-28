# TaskForge

[English](#english) | [Português](#português)

---

<a name="english"></a>
# English

**A resilient background job queue engine for Node.js — built entirely on the standard library.**

Priority scheduling · exponential backoff with jitter · crash-safe persistence via a write-ahead log · real OS-level parallelism with `worker_threads` · a token-bucket rate limiter · a live dashboard. **Zero runtime dependencies.**

[![CI](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success)

---

## Why this exists

Every backend system eventually needs to run work outside the request/response cycle — send an email, resize an upload, call a flaky third-party API, generate a report. In production this almost always means reaching for a job queue library (Sidekiq, BullMQ, Celery...) and trusting it to handle retries, crashes, and backpressure correctly.

TaskForge is what's underneath that trust. Instead of wrapping one of those libraries, this is a job queue engine built from first principles on nothing but Node's standard library, so every guarantee it makes is one I implemented and can explain:

- *"What happens if the process dies mid-job?"* → it's requeued, because the write-ahead log recorded that it started before it ran.
- *"What stops a CPU-heavy job from freezing everything else?"* → nothing shares a thread with it; each job runs in an isolated `worker_thread`.
- *"What stops 200 failed jobs from retrying at the exact same instant and hammering a struggling API?"* → jittered exponential backoff.
- *"What happens to a job that fails forever?"* → it lands in a dead-letter queue instead of disappearing or retrying infinitely.

## What it does

- **Priority scheduling** — a binary heap orders ready jobs by priority, then by age.
- **Delayed & scheduled jobs** — run a job now, or `delayMs` from now.
- **Automatic retries** — exponential backoff with jitter, configurable per queue.
- **Dead-letter queue** — jobs that exhaust their attempts are quarantined, inspectable, and redrivable — from the CLI or the dashboard.
- **True parallelism** — jobs execute in a pool of `worker_threads`, not just concurrently on one thread. A crashing worker is replaced automatically, exactly once per crash, without losing pool capacity.
- **Crash-safe persistence** — a write-ahead log + snapshot compaction means a `kill -9` mid-run loses nothing (a truncated final log line from a crash mid-write is tolerated, not fatal); restart and the queue picks up where it left off.
- **Rate limiting** — an optional token bucket caps how fast a queue dispatches jobs, for protecting a downstream API with its own limits.
- **Live dashboard** — a dark, dependency-free web UI showing the job pipeline, throughput, p50/p95/p99 latency, a live job manifest, and a dead-letter "scrap bin" with one-click redrive.
- **Deduplication** — an optional `dedupeKey` makes `add()` a no-op if a job with that key was ever seen.
- **Bounded memory** — completed job history older than a configurable retention window is pruned during compaction, so a long-running process doesn't accumulate every job it's ever processed forever.

## Quick start

```bash
git clone <this-repo>
cd taskforge
npm start &
```

Open **http://localhost:4000** — the dashboard starts pre-wired with three simulated job types (a welcome email, an image resize, a flaky API call) and a steady trickle of synthetic traffic, so there's something to look at immediately. No `npm install` step: there are no runtime dependencies.

Other things to try:

```bash
npm test                    # 18 tests, node's built-in test runner, no test framework dependency
npm run example:basic       # minimal library usage
npm run example:cpu         # why worker_threads matter: 20 CPU-bound jobs, main thread never blocks
npm run example:retries     # retries + backoff + rate limiting + a dead-letter queue, from the terminal

npm run cli stats           # while the dashboard is running, in another terminal
npm run cli jobs --status dead
npm run cli dlq:redrive <jobId>
```

### See the crash recovery for yourself

This is the best way to see what the write-ahead log is actually for:

```bash
npm start &                    # let it run for ~5 seconds so a few jobs complete
# in another terminal:
kill -9 $(lsof -ti:4000)       # simulate a hard crash — no graceful shutdown
npm start &                    # restart
```

The restart logs `[wal] restored N job(s) from disk (M log entries replayed)`, and `GET /api/stats` shows the same completed-job count it had before the crash — nothing was lost.

## Architecture

```
┌──────────────┐   add()    ┌─────────────────┐   dispatch()   ┌──────────────┐
│   Your code   │ ─────────▶│      Queue       │ ──────────────▶│  WorkerPool   │
│ (or the demo  │            │  (orchestrator)  │                │ (worker_thr.) │
│  HTTP server) │◀───────────│                  │◀───────────────│               │
└──────────────┘   events   └───────┬──────────┘   jobFinished  └──────┬───────┘
                                     │                                  │
                          ┌──────────┼──────────┐                      │
                          ▼          ▼           ▼                     ▼
                   PriorityHeap  delayed[]  WriteAheadLog      workerRunner.js
                   (ready jobs) (scheduled/  (crash recovery)   dynamically imports
                                 retrying)                      your handler module
                                     │
                                     ▼
                              RetryPolicy (backoff)
                              TokenBucket (rate limit)
                              Metrics (p50/p95/p99, throughput)
```

`Queue#tick()`, on a plain `setInterval`, is the *only* code path that dispatches a job: promote any delayed job whose time has come into the ready heap, then hand ready jobs to idle workers (respecting the rate limiter, if configured). Every other state change — a job completing, failing, retrying, dying — arrives asynchronously as a message from a worker thread and is handled by one function, `#onJobFinished`. Centralizing dispatch and completion each into a single path is what makes the concurrency tractable to reason about, even though jobs genuinely finish out of order, from different OS threads.

### Project structure

```
src/
  core/
    Job.js              job state machine (waiting → active → completed | dead)
    PriorityHeap.js      binary heap backing the ready queue
    RetryPolicy.js        exponential backoff with jitter
    RateLimiter.js         token bucket
    Metrics.js               rolling p50/p95/p99 + throughput
    WriteAheadLog.js          append-only log + snapshot compaction
    DeadLetterQueue.js         inspect/redrive permanently-failed jobs
    WorkerPool.js                self-healing pool of worker_threads
    Queue.js                       ties it all together
  workers/
    workerRunner.js       lives inside each worker thread; imports handlers by path
  dashboard/
    server.js             REST API + static file server (node:http, no framework)
    public/                vanilla HTML/CSS/canvas dashboard, no build step
  cli.js                 REST client for the running server
  index.js               public library entrypoint
examples/                runnable, narrated usage demos
test/                    node:test suite (unit + real end-to-end with real threads)
```

## Design decisions & trade-offs

Documenting these honestly is more useful than pretending the design has no edges:

- **Handlers are files, not functions.** A worker thread can't receive a JS closure from the main thread — only structured-cloneable data crosses that boundary. So `queue.process('name', './handler.js')` takes a *path*, dynamically imported inside the worker. This is exactly the constraint real systems like Sidekiq and Celery live with, and it's what actually buys the isolation: a handler that hangs, leaks, or throws synchronously can only take down its own worker thread.
- **Every WAL append is a synchronous `fs.appendFileSync`, not a buffered stream.** An earlier version used a long-lived `fs.createWriteStream`, which is faster but opened a real hazard: a buffered write still in flight when `compact()` truncates the same file through a separate file descriptor is a genuine race. Synchronous per-line appends make that impossible — at a throughput cost that doesn't matter at this scale. It's still not a full `fsync`-per-write guarantee (the OS may briefly hold a write in its page cache before it reaches physical disk); a system with stronger durability requirements would close that gap with an explicit `fsync`/`fdatasync`. This project's 400-job / 240-compaction-cycle stress test shows zero corruption or loss under the current approach.
- **A worker crash is handled exactly once, even though Node reports it twice.** An uncaught exception inside a worker thread fires *both* `'error'` and `'exit'` on the parent `Worker` object for the same crash (verified directly, not assumed) — without a guard, that double-requeues the in-flight job and leaks an orphaned replacement worker. `WorkerPool` tracks a per-worker `crashHandled` flag so only the first of the two events does anything.
- **The WAL assumes a single writer per queue name.** Two processes cannot safely append to the same queue's log concurrently. That's why the CLI talks to the running server over HTTP instead of opening the WAL files directly.
- **Delayed jobs are a plain array, scanned every tick.** At the volume a project like this actually runs, O(n) per 100ms tick is invisible. A second min-heap keyed by `processAt` would be the fix if that stopped being true.
- **Percentiles are computed by sorting the rolling window on read**, not with a streaming structure like a t-digest. Simple, correct, and fast enough at dashboard-poll rates; a real high-throughput system would reach for a proper histogram.
- **Completed-job retention prunes its own dedupe keys, but only its own.** Pruning a stale completed job also frees its `dedupeKey`, which keeps that specific leak in check — but a `dedupeKey` attached to a job that's still waiting, active, delayed, or dead outlives the job itself with no TTL of its own. Documented, not hidden, under "Known limitations".
- **No distributed mode.** Everything here — the queue, the workers, the WAL — lives in one process. A Redis- or Postgres-backed queue lets multiple machines share one queue; TaskForge deliberately doesn't solve that problem, because solving *this* one (durability, retries, isolation, backpressure, on a single node) is what the project is about.

## Using it as a library

```js
import { Queue } from './src/index.js';

const queue = new Queue('emails', { concurrency: 4 });
queue.process('welcome-email', './handlers/sendWelcomeEmail.js');

queue.on('job:completed', (job) => console.log('done:', job.id));
queue.on('job:retrying', (job) => console.log('retrying:', job.id, 'in', job.nextDelayMs, 'ms'));
queue.on('job:dead', (job) => console.log('gave up:', job.id, job.error));

queue.add('welcome-email', { to: 'ada@example.com' }, {
  priority: 5,       // higher runs first
  delayMs: 0,        // or schedule for later
  maxAttempts: 3,
  dedupeKey: null,   // set to avoid double-enqueuing the same logical job
});
```

A handler module (loaded inside a worker thread) is just:

```js
// handlers/sendWelcomeEmail.js
export default async function sendWelcomeEmail(payload, job) {
  // ... do the work ...
  return { sentTo: payload.to };
}
```

## Known limitations

- Single-process, single-writer-per-queue-name — see trade-offs above.
- The dashboard has no authentication; it's a local development tool, not something to expose publicly as-is.
- `dedupeKey`s for jobs still waiting, active, delayed, or dead are never evicted from memory — only a completed job's key is freed, and only once that job ages past the retention window. A process that runs indefinitely while adding unique dedupe keys for jobs that never complete will still grow that index unboundedly; a full fix would give each key its own TTL independent of job history.

## License

MIT — see [LICENSE](./LICENSE).

---

<a name="português"></a>
# Português

**Um mecanismo de fila de tarefas em segundo plano resiliente para Node.js — construído inteiramente com a biblioteca padrão.**

Agendamento por prioridade · backoff exponencial com jitter · persistência segura contra falhas por meio de um write-ahead log · paralelismo real em nível de SO com `worker_threads` · limitador de taxa token-bucket · um painel ao vivo. **Zero dependências em tempo de execução.**

[![CI](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success)

---

## Por que isso existe

Todo sistema backend eventualmente precisa executar tarefas fora do ciclo de requisição/resposta — enviar um e-mail, redimensionar um upload, chamar uma API de terceiros instável, gerar um relatório. Em produção, isso quase sempre significa recorrer a uma biblioteca de fila de tarefas (Sidekiq, BullMQ, Celery...) e confiar que ela gerencie tentativas, falhas e contrapressão de forma correta.

O TaskForge é o que está por baixo dessa confiança. Em vez de envolver uma dessas bibliotecas, este é um mecanismo de fila de tarefas construído a partir de princípios básicos usando apenas a biblioteca padrão do Node, para que cada garantia que ele faça seja uma que eu implementei e possa explicar:

- *"O que acontece se o processo morrer no meio de uma tarefa?"* → ela é recolocada na fila, porque o log write-ahead registrou que ela começou antes de ser executada.
- *"O que impede que uma tarefa pesada de CPU congele todo o resto?"* → nada compartilha uma thread com ela; cada tarefa é executada em uma `worker_thread` isolada.
- *"O que impede que 200 tarefas com falha tentem novamente exatamente no mesmo instante e sobrecarreguem uma API já com dificuldades?"* → backoff exponencial com jitter (variação aleatória).
- *"O que acontece com uma tarefa que falha para sempre?"* → ela vai parar em uma fila de mensagens mortas (dead-letter queue) em vez de desaparecer ou tentar infinitamente.

## O que ele faz

- **Agendamento por prioridade** — um heap binário ordena tarefas prontas por prioridade, em seguida por idade.
- **Tarefas atrasadas e agendadas** — executa uma tarefa agora, ou daqui a `delayMs`.
- **Tentativas automáticas** — backoff exponencial com jitter, configurável por fila.
- **Fila de mensagens mortas (Dead-letter queue)** — tarefas que esgotam suas tentativas são colocadas em quarentena, inspecionáveis e reenviáveis — pela CLI ou pelo painel.
- **Paralelismo verdadeiro** — tarefas executam em um pool de `worker_threads`, não apenas concorrentemente em uma thread. Um worker que falha é substituído automaticamente, exatamente uma vez por falha, sem perder capacidade do pool.
- **Persistência segura contra falhas** — um write-ahead log + compactação de snapshot significa que um `kill -9` no meio da execução não perde nada (uma linha final de log truncada de uma falha durante a gravação é tolerada, não fatal); reinicie e a fila continuará de onde parou.
- **Limitação de taxa (Rate limiting)** — um token bucket opcional limita a velocidade com que uma fila despacha tarefas, para proteger uma API downstream com seus próprios limites.
- **Painel ao vivo (Live dashboard)** — uma interface web escura e sem dependências mostrando o pipeline de tarefas, taxa de transferência, latência p50/p95/p99, um manifesto de tarefas ao vivo e uma "lixeira" de mensagens mortas com reenvio em um clique.
- **Desduplicação** — uma `dedupeKey` opcional torna `add()` uma operação nula se uma tarefa com essa chave já foi vista antes.
- **Memória limitada** — histórico de tarefas concluídas mais antigas que uma janela de retenção configurável é limpo durante a compactação, para que um processo de longa duração não acumule eternamente cada tarefa que já processou.

## Início rápido

```bash
git clone <este-repositorio>
cd taskforge
npm start &
```

Abra **http://localhost:4000** — o painel inicia pré-configurado com três tipos de tarefas simuladas (um e-mail de boas-vindas, um redimensionamento de imagem, uma chamada de API instável) e um fluxo constante de tráfego sintético, para que haja algo a se ver imediatamente. Não há etapa de `npm install`: não há dependências em tempo de execução.

Outras coisas para experimentar:

```bash
npm test                    # 18 testes, executor de testes embutido no node, nenhuma dependência de framework de testes
npm run example:basic       # uso mínimo da biblioteca
npm run example:cpu         # por que worker_threads importam: 20 tarefas limitadas por CPU, a thread principal nunca bloqueia
npm run example:retries     # tentativas + backoff + limitador de taxa + uma fila de mensagens mortas, do terminal

npm run cli stats           # enquanto o painel estiver em execução, em outro terminal
npm run cli jobs --status dead
npm run cli dlq:redrive <jobId>
```

### Veja a recuperação de falhas por si mesmo

Esta é a melhor maneira de ver para que serve realmente o write-ahead log:

```bash
npm start &                    # deixe-o rodar por ~5 segundos para que algumas tarefas sejam concluídas
# em outro terminal:
kill -9 $(lsof -ti:4000)       # simule uma falha grave — nenhum desligamento suave
npm start &                    # reinicie
```

A reinicialização exibe os logs `[wal] restored N job(s) from disk (M log entries replayed)`, e `GET /api/stats` mostra a mesma contagem de tarefas concluídas que tinha antes da falha — nada foi perdido.

## Arquitetura

```
┌──────────────┐   add()    ┌─────────────────┐   dispatch()   ┌──────────────┐
│  Seu código  │ ─────────▶│       Fila      │ ──────────────▶│  WorkerPool  │
│(ou o servidor │            │ (orquestrador)  │                │(worker_thr.) │
│ HTTP de demo) │◀───────────│                 │◀───────────────│              │
└──────────────┘   eventos  └───────┬──────────┘  jobFinished   └──────┬───────┘
                                     │                                 │
                          ┌──────────┼──────────┐                      │
                          ▼          ▼           ▼                     ▼
                   PriorityHeap  delayed[]  WriteAheadLog      workerRunner.js
                (tarefas prontas)(agendadas/ (recup. falhas)     importa dinam.
                                 tentativas)                   seu mód. manipulador
                                     │
                                     ▼
                              RetryPolicy (backoff)
                              TokenBucket (limite taxa)
                              Metrics (p50/p95/p99, vazão)
```

`Queue#tick()`, em um `setInterval` comum, é o *único* caminho de código que despacha uma tarefa: promove qualquer tarefa atrasada cujo tempo chegou para o heap de prontos, depois entrega tarefas prontas aos workers ociosos (respeitando o limitador de taxa, se configurado). Qualquer outra mudança de estado — uma tarefa concluindo, falhando, tentando novamente, morrendo — chega de forma assíncrona como uma mensagem de uma thread de worker e é tratada por uma função, `#onJobFinished`. Centralizar o despacho e a conclusão, cada um em um único caminho, é o que torna a concorrência tratável de se raciocinar, mesmo que as tarefas terminem genuinamente fora de ordem, em diferentes threads do sistema operacional.

### Estrutura do projeto

```
src/
  core/
    Job.js              máquina de estados da tarefa (waiting → active → completed | dead)
    PriorityHeap.js      heap binário que suporta a fila de prontos
    RetryPolicy.js        backoff exponencial com jitter
    RateLimiter.js         token bucket
    Metrics.js               p50/p95/p99 contínuo + taxa de transferência
    WriteAheadLog.js          log apenas de acréscimo + compactação de snapshot
    DeadLetterQueue.js         inspecionar/reenviar tarefas permanentemente falhas
    WorkerPool.js                pool autocurativo de worker_threads
    Queue.js                       une tudo isso
  workers/
    workerRunner.js       vive dentro de cada thread worker; importa manipuladores pelo caminho
  dashboard/
    server.js             API REST + servidor de arquivos estáticos (node:http, sem framework)
    public/                painel em HTML/CSS/canvas puros, sem etapa de build
  cli.js                 cliente REST para o servidor em execução
  index.js               ponto de entrada da biblioteca pública
examples/                demonstrações narradas e executáveis de uso
test/                    suíte node:test (unidade + e2e real com threads reais)
```

## Decisões de design e compensações

Documentar essas honestamente é mais útil do que fingir que o design não tem arestas:

- **Manipuladores são arquivos, não funções.** Uma worker thread não pode receber um fechamento JS (closure) da thread principal — apenas dados estruturados cruzam esse limite. Então `queue.process('name', './handler.js')` aceita um *caminho*, importado dinamicamente dentro do worker. Esta é exatamente a restrição com a qual sistemas reais como Sidekiq e Celery convivem, e é o que de fato proporciona o isolamento: um manipulador que trava, tem vazamento, ou lança erros síncronos só pode derrubar sua própria worker thread.
- **Cada anexo ao WAL é um `fs.appendFileSync` síncrono, não um stream em buffer.** Uma versão anterior usava um `fs.createWriteStream` de longa duração, que é mais rápido, mas abria um risco real: uma gravação em buffer ainda em andamento quando `compact()` trunca o mesmo arquivo através de um descritor de arquivo separado é uma corrida genuína. Anexos por linha síncronos tornam isso impossível — a um custo de vazão que não importa nesta escala. Ainda não é uma garantia total de `fsync`-por-gravação (o SO pode reter brevemente uma gravação no cache de páginas antes de atingir o disco físico); um sistema com requisitos mais rigorosos de durabilidade preencheria essa lacuna com um `fsync`/`fdatasync` explícito. O teste de estresse deste projeto com 400 tarefas / 240 ciclos de compactação mostra zero corrupção ou perda com a abordagem atual.
- **Uma falha de worker é tratada exatamente uma vez, embora o Node relate isso duas vezes.** Uma exceção não capturada dentro de uma worker thread dispara *ambos* `'error'` e `'exit'` no objeto pai `Worker` para a mesma falha (verificado diretamente, não presumido) — sem uma guarda, isso recoloca a tarefa em andamento duas vezes na fila e vaza um worker substituto órfão. `WorkerPool` rastreia um sinalizador `crashHandled` por worker, para que apenas o primeiro dos dois eventos faça algo.
- **O WAL assume um único gravador por nome de fila.** Dois processos não podem anexar ao log da mesma fila com segurança concorrentemente. É por isso que a CLI se comunica com o servidor em execução via HTTP, em vez de abrir os arquivos WAL diretamente.
- **As tarefas atrasadas são um array comum, verificado em cada tick.** No volume que um projeto como este realmente executa, O(n) por tick de 100ms é invisível. Um segundo min-heap indexado por `processAt` seria a correção caso isso deixasse de ser verdade.
- **Os percentis são calculados classificando a janela rolante na leitura**, não com uma estrutura de streaming como um t-digest. Simples, correto, e rápido o suficiente nas taxas de polling do painel; um sistema real de alta vazão usaria um histograma apropriado.
- **A retenção de tarefas concluídas limpa suas próprias dedupe keys, mas apenas as suas próprias.** Limpar uma tarefa concluída desatualizada também libera sua `dedupeKey`, o que mantém esse vazamento específico sob controle — mas uma `dedupeKey` anexada a uma tarefa que ainda está aguardando, ativa, atrasada ou morta sobrevive à própria tarefa, sem um TTL (Tempo de Vida) próprio. Documentado, não oculto, sob "Limitações conhecidas".
- **Sem modo distribuído.** Tudo aqui — a fila, os workers, o WAL — vive em um único processo. Uma fila baseada em Redis ou Postgres permite que múltiplas máquinas compartilhem uma fila; o TaskForge deliberadamente não resolve esse problema, porque resolver *este* (durabilidade, retentativas, isolamento, contrapressão, em um único nó) é o objetivo do projeto.

## Utilizando como biblioteca

```js
import { Queue } from './src/index.js';

const queue = new Queue('emails', { concurrency: 4 });
queue.process('welcome-email', './handlers/sendWelcomeEmail.js');

queue.on('job:completed', (job) => console.log('concluido:', job.id));
queue.on('job:retrying', (job) => console.log('tentando novamente:', job.id, 'em', job.nextDelayMs, 'ms'));
queue.on('job:dead', (job) => console.log('desistiu:', job.id, job.error));

queue.add('welcome-email', { to: 'ada@example.com' }, {
  priority: 5,       // maior executa primeiro
  delayMs: 0,        // ou agende para mais tarde
  maxAttempts: 3,
  dedupeKey: null,   // defina para evitar empilhar duas vezes a mesma tarefa lógica
});
```

Um módulo de manipulador (carregado dentro de uma worker thread) é apenas:

```js
// handlers/sendWelcomeEmail.js
export default async function sendWelcomeEmail(payload, job) {
  // ... faz o trabalho ...
  return { sentTo: payload.to };
}
```

## Limitações conhecidas

- Processo único, um único gravador por nome de fila — consulte decisões de design e compensações acima.
- O painel não possui autenticação; é uma ferramenta de desenvolvimento local, não algo para ser exposto publicamente no estado em que se encontra.
- `dedupeKey`s para tarefas que ainda aguardam, ativas, atrasadas ou mortas nunca são removidas da memória — apenas a chave de uma tarefa concluída é liberada e, mesmo assim, só depois de a tarefa envelhecer além da janela de retenção. Um processo que roda indefinidamente ao mesmo tempo em que adiciona dedupe keys únicas a tarefas que nunca terminam, continuará crescendo esse índice sem limite; uma solução completa daria a cada chave seu próprio TTL, independente do histórico das tarefas.

## Licença

MIT — veja [LICENSE](./LICENSE).
