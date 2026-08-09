# Codex Agent MCP V0.2

Puente MCP personal y monousuario para delegar tareas a la instalación local
de Codex. La frontera del producto es deliberadamente pequeña:

```text
ChatGPT web
  -> Secure MCP Tunnel
  -> MCP Streamable HTTP (/mcp)
  -> API compacta de jobs
  -> codex app-server --stdio (JSONL)
  -> Codex local
```

Este proyecto no usa `codex mcp-server`, no expone shell ni filesystem como
tools MCP y no implementa broker, worker farm, multiagente ni almacenamiento
externo.

## Requisitos y ejecución

- Node.js 20 o posterior.
- `codex-cli 0.147.0` en `PATH`, instalado y autenticado localmente.

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

El servicio escucha por defecto en `http://127.0.0.1:8787`:

- MCP: `http://127.0.0.1:8787/mcp`
- salud: `http://127.0.0.1:8787/healthz`
- readiness: `http://127.0.0.1:8787/readyz`

El smoke test del cliente app-server contra el binario instalado puede
ejecutarse después del build con:

```bash
node --input-type=module -e 'import { CodexAppServer } from "./dist/src/codex-app-server.js"; void (async () => { const c = new CodexAppServer(); await c.start(); console.log(c.isReady()); console.log(await c.request("thread/list", { limit: 1, useStateDbOnly: true })); await c.stop(); })();'
```

## Tools MCP

La superficie pública es exactamente esta:

| Tool | Schema | Semántica |
| --- | --- | --- |
| `codex_start` | `{ workspace: string, prompt: string }` | Valida el workspace, crea un thread persistente y comienza un turn. |
| `codex_get` | `{ job_id: string }` | Devuelve un resumen compacto del job. |
| `codex_continue` | `{ job_id: string, prompt: string }` | Reutiliza el mismo thread y crea otro turn cuando el anterior terminó. |
| `codex_interrupt` | `{ job_id: string }` | Ejecuta `turn/interrupt` sobre el turn activo. |
| `codex_respond_approval` | `{ job_id: string, request_id: string | number, decision: ... }` | Responde una approval concreta del app-server. |

`decision` sólo admite los valores/objetos del protocolo Codex 0.147.0 para
command execution, file changes, permissions y las approvals legacy del mismo
protocolo. `request_id` es obligatorio:
dos approvals pendientes pueden coexistir y nunca se responde una por
posición o por “la última recibida”.

`codex_get` entrega `status`, `job_id`, `thread_id`, `turn_id`,
`final_message`, `latest_diff`, `files_changed`, `commands_executed`, `error`,
`pending_approvals` y, por compatibilidad, `pending_approval` como alias de la
primera approval. No devuelve el stream JSONL crudo.

## Lifecycle y concurrencia

Los estados son `starting`, `running`, `awaiting_approval`, `interrupting`,
`completed`, `interrupted`, `failed` y `recovery_required`.

Un turn sólo termina con una respuesta terminal de `turn/start` o una
notificación `turn/completed` del mismo `threadId` y `turnId`. No se usa
`thread/status: idle` como heurística. Si una notificación llega antes de que
`turn/start` devuelva el `turnId`, queda bufferizada y se aplica después sólo si
corresponde a ese turn.

V0.2 permite un único turn activo por proceso/app-server. Un `start` o
`continue` concurrente devuelve un error semántico de backend ocupado;
`interrupt` sigue disponible para el turn activo. Un fallo del proceso o un
timeout cuyo resultado sea incierto deja el job en `recovery_required`, nunca
en `completed` inventado.

## Persistencia y recuperación

El índice mínimo `job_id -> thread_id`, workspace, último turn y resumen se
guarda atómicamente en:

```text
~/.codex-agent-mcp/state.json
```

Se puede cambiar sólo como configuración administrativa local con
`CODEX_AGENT_STATE_FILE`. El state puede contener `final_message`, diff,
archivos, comandos y mensajes de error, por lo que debe tratarse como
información potencialmente sensible. No guarda prompts completos, logs ni el
historial de Codex. Las escrituras son temp-file + rename y el archivo queda
con permisos `0600`. Un JSON corrupto o ambiguo (por ejemplo, `job_id` o
`thread_id` duplicados) no tumba el servicio: se rechaza completo con
diagnóstico en stderr y el servicio arranca con un índice vacío.

Al inicializar el app-server, los jobs se rehidratan mediante `thread/read` con
turns y, si el último turn sigue `inProgress`, `thread/resume`. El historial
canónico continúa siendo el de Codex. Si no se puede probar el estado, el job
queda `recovery_required`; un job `running` persistido no se transforma
silenciosamente en `completed`. Tras un crash/timeout, un `recovery_required`
con thread y turn conocidos sólo vuelve a `running` si `thread/read` prueba que
ese mismo turn está `inProgress` y `thread/resume` devuelve ese mismo thread y
turn todavía `inProgress`. Si hay más de un recovery potencialmente activo,
se aplica un fence global y no se aceptan nuevos `start`/`continue`.

Si `thread/start` vence antes de devolver su id, el job queda persistido con
`thread_id: null` y `recovery_required`. V0.2 no intenta adivinar qué thread
creó usando preview, timestamps u otras heurísticas; el backend queda
bloqueado y conserva el diagnóstico para revisión manual. No existe un tool
`attach` ni una adopción automática de ese thread incierto.

## Configuración y seguridad

Variables administrativas locales:

- `HOST` y `PORT`: por defecto `127.0.0.1:8787`.
- `CODEX_AGENT_ALLOW_NON_LOOPBACK=1`: opt-in explícito requerido para bind no
  loopback. No se recomienda cuando el único transporte previsto es Secure MCP
  Tunnel.
- `CODEX_BIN`: binario local, por defecto `codex`.
- `CODEX_RPC_TIMEOUT_MS`: timeout genérico de RPC, por defecto 30 000 ms.
- `CODEX_SHUTDOWN_TIMEOUT_MS`: espera graceful, por defecto 2 000 ms.
- `CODEX_AGENT_STATE_FILE`: ubicación local opcional del state JSON.
- `CODEX_WORKSPACE_ROOT`: raíz administrativa opcional; por defecto
  `/Users/joseanu/workspace`.
- `CODEX_AGENT_MODEL` y `CODEX_AGENT_REASONING_EFFORT`: overrides locales
  opcionales. Si no se definen, Codex usa su configuración local.

Sin `CODEX_AGENT_ALLOW_NON_LOOPBACK=1`, cualquier `HOST` externo falla closed
antes de escuchar. Si se habilita, el operador debe garantizar una protección
equivalente (por ejemplo Secure MCP Tunnel con controles de acceso); este
servidor no añade autenticación HTTP propia.

El workspace debe ser absoluto, existente y un directorio. Se rechazan NUL,
segmentos `..`, raíces inválidas y escapes por symlink después de canonicalizar
con `realpath`. Sólo se pasa a Codex la ruta canónica bajo la raíz allowlist.
El cliente remoto no puede elegir `config`, modelo, sandbox ni permisos
arbitrarios; los overrides de entorno son administrativos del proceso local.

## Compatibilidad del protocolo

La implementación está fijada contra el protocolo observado de `codex-cli
0.147.0`, app-server v2. El binario instalado es la autoridad: `main` de
OpenAI/Codex puede cambiar independientemente del CLI local. El cliente usa
`initialize` → `initialized`, JSONL bidireccional y soporta los RPC necesarios
`thread/start`, `thread/resume`, `thread/list`, `thread/read`, `turn/start` y
`turn/interrupt`, además de las approvals server-initiated soportadas.

Los bindings TypeScript generados en
`protocol/codex-0.147.0-ts/` sólo aportan type-safety durante el build; no se
cargan en runtime. Los JSON schemas en
`protocol/codex-0.147.0-json-schema/` son referencia versionada y tampoco
forman parte del runtime. Para actualizar el pin, instala/verifica el nuevo
CLI y regenera ambos conjuntos con:

```bash
codex app-server generate-ts --out protocol/codex-<version>-ts
codex app-server generate-json-schema --out protocol/codex-<version>-json-schema
```

Después hay que revisar imports, approvals y tests contra el binario instalado.

La regresión completa se ejecuta con `npm test`; incluye fakes sin sleeps
largos y una integración opcional contra el binario instalado:

```bash
CODEX_REAL_APP_SERVER=1 npm test -- --test-name-pattern='installed codex'
```

También son válidos `npm run typecheck`, `npm run build` y `git diff --check`.

## Referencia de diseño

Se revisaron los patrones de lifecycle, rechazo de RPC pendientes, respuesta
JSON-RPC a server requests no soportados, captura de turn y estado persistido de
`openai/codex-plugin-cc`. Se reimplementaron en TypeScript sólo las invariantes
útiles para este puente; no se copió la integración de Claude Code ni su
arquitectura de jobs/logs.
