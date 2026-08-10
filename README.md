# codex-from-chatgpt

Usa Codex local desde ChatGPT. Este proyecto es un puente MCP personal y
monousuario: ChatGPT envía una instrucción, el servicio local la traduce a un
thread de `codex app-server --stdio` y devuelve un resumen compacto del
trabajo de Codex.

> **Proyecto comunitario y no oficial:** no es una integración oficial de
> OpenAI ni de ChatGPT.

La frontera del producto es deliberadamente pequeña:

```text
ChatGPT (a través de un Secure MCP Tunnel)
  -> MCP Streamable HTTP (/mcp)
  -> API compacta de jobs
  -> codex app-server --stdio (JSONL)
  -> Codex local
```

No usa `codex mcp-server`, no expone shell ni filesystem como tools MCP y no
implementa broker, worker farm, multiagente ni almacenamiento externo.

La documentación oficial de OpenAI describe [MCP](https://learn.chatgpt.com/docs/extend/mcp)
y [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
Para los detalles del protocolo subyacente, consulta la referencia de
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Requisitos

- Node.js 20 o posterior.
- `codex-cli 0.147.0` en `PATH`.
- Codex instalado y autenticado localmente.
- Un workspace existente bajo la raíz administrativa permitida. Por defecto esa
  raíz es `~/workspace` (el `workspace` de tu home) y debe existir; se puede
  cambiar con `CODEX_WORKSPACE_ROOT`. Si no existe, créala:

  ```bash
  mkdir -p ~/workspace
  ```

Comprueba la instalación local antes de conectar ChatGPT:

```bash
codex --version
```

## Instalar y ejecutar

```bash
git clone https://github.com/<usuario>/codex-from-chatgpt.git
cd codex-from-chatgpt
npm install
npm run build
npm start
```

El proceso escucha por defecto sólo en loopback:

- MCP: `http://127.0.0.1:8787/mcp`
- salud: `http://127.0.0.1:8787/healthz`
- readiness: `http://127.0.0.1:8787/readyz`

Verifica que el servicio y el app-server estén listos:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

Para usar otra raíz administrativa o puerto:

```bash
CODEX_WORKSPACE_ROOT=/ruta/absoluta/a/workspaces PORT=8787 npm start
```

## Conexión paso a paso desde ChatGPT

ChatGPT no se conecta directamente a `127.0.0.1`. El único camino documentado
desde ChatGPT hacia este servicio local es:

```text
ChatGPT
  -> URL HTTPS del Secure MCP Tunnel
  -> http://127.0.0.1:8787/mcp (upstream local del túnel)
  -> codex-from-chatgpt
  -> codex app-server --stdio
```

1. Instala, construye e inicia `codex-from-chatgpt` con `npm start` y deja el
   proceso local abierto.
2. Confirma localmente `/healthz` y `/readyz`.
3. Configura un **Secure MCP Tunnel** para reenviar una ruta HTTPS protegida
   hacia `http://127.0.0.1:8787/mcp`. El túnel debe exigir autenticación y
   controles de acceso; no publiques directamente el puerto `8787`.
4. Conecta ChatGPT usando la URL HTTPS del túnel en el mecanismo de MCP remoto
   disponible para tu cuenta o workspace. No uses la URL `127.0.0.1` en
   ChatGPT.
5. Comprueba que el servidor exponga las tools
   `codex_start`, `codex_get`, `codex_continue`, `codex_interrupt` y
   `codex_respond_approval`.
6. Prueba una tarea con un workspace absoluto permitido, por ejemplo:

   ```text
   Usa codex_start en el workspace "/Users/you/workspace/mi-proyecto"
   para inspeccionar el estado de Git sin modificar archivos. Devuélveme el
   job_id y luego consulta el resultado con codex_get.
   ```

El flujo normal es:

1. `codex_start` crea el thread persistente y comienza el primer turn.
2. `codex_get` consulta el snapshot compacto del job.
3. Si el turno termina, `codex_continue` envía la siguiente instrucción al
   mismo thread.
4. Si Codex solicita una aprobación, `codex_respond_approval` responde usando
   el `request_id` exacto que aparece en `pending_approvals`.
5. `codex_interrupt` detiene un turno activo cuando sea necesario.

> **Disponibilidad actual:** el MCP completo, especialmente las write actions,
> depende del plan, la cuenta, el workspace y las capacidades habilitadas de
> ChatGPT. Este proyecto no promete soporte universal; sólo estarán disponibles
> las capacidades que exponga el entorno de ChatGPT conectado.

El túnel no forma parte de este repositorio. El bind no loopback requiere el
opt-in explícito `CODEX_AGENT_ALLOW_NON_LOOPBACK=1` y sólo debe usarse cuando
el túnel cubra todo el transporte.

## Tools MCP

La superficie pública es exactamente esta:

| Tool | Schema | Semántica |
| --- | --- | --- |
| `codex_start` | `{ workspace: string, prompt: string }` | Valida el workspace, crea un thread persistente y comienza un turn. |
| `codex_get` | `{ job_id: string }` | Devuelve un resumen compacto del job. |
| `codex_continue` | `{ job_id: string, prompt: string }` | Reutiliza el mismo thread y crea otro turn cuando el anterior terminó. |
| `codex_interrupt` | `{ job_id: string }` | Ejecuta `turn/interrupt` sobre el turn activo. |
| `codex_respond_approval` | `{ job_id: string, request_id: string \| number, decision: ... }` | Responde una aprobación concreta del app-server. |

`codex_get` entrega `status`, `job_id`, `thread_id`, `turn_id`,
`final_message`, `latest_diff`, `files_changed`, `commands_executed`, `error`,
`pending_approvals` y, por compatibilidad, `pending_approval` como alias de la
primera aprobación. No devuelve el stream JSONL crudo.

Las aprobaciones aceptan únicamente los valores y objetos definidos por el
protocolo instalado para command execution, file changes, permissions y las
aprobaciones legacy. `request_id` es obligatorio: dos aprobaciones pendientes
pueden coexistir y nunca se responde una por posición o por “la última
recibida”.

## Lifecycle, persistencia y recuperación

Los estados son `starting`, `running`, `awaiting_approval`, `interrupting`,
`completed`, `interrupted`, `failed` y `recovery_required`.

V0.2 permite un único turn activo por proceso/app-server. Un `start` o
`continue` concurrente devuelve un error semántico de backend ocupado;
`interrupt` sigue disponible para el turn activo. Un fallo del proceso o un
timeout cuyo resultado sea incierto deja el job en `recovery_required`, nunca
en `completed` inventado.

El índice mínimo `job_id → thread_id`, workspace, último turn y resumen se
guarda atómicamente en un archivo local. Su ubicación se puede definir con
`CODEX_AGENT_STATE_FILE`; el contenido puede incluir mensajes finales, diffs,
archivos, comandos y errores, por lo que debe tratarse como información
potencialmente sensible.

Al inicializar el app-server, los jobs persistidos se rehidratan mediante
`thread/read` y, cuando corresponde, `thread/resume`. Si no se puede probar el
estado, el job queda en `recovery_required`; no se convierte silenciosamente
en `completed`.

## Seguridad y límites

- El servicio enlaza a `127.0.0.1` por defecto.
- `/mcp` valida la cabecera `Host` contra el `HOST:PORT` configurado y responde
  `403` a cualquier otro valor. Esto cierra el DNS rebinding: una web que el
  usuario visite no puede resolver su propio dominio a `127.0.0.1` y hablar con
  el servicio local. Si el túnel reescribe `Host`, añade su hostname con
  `CODEX_AGENT_ALLOWED_HOSTS`.
- El workspace debe ser absoluto, existente y estar bajo la raíz permitida.
- Se rechazan NUL, segmentos `..`, raíces inválidas y escapes por symlink
  después de `realpath`.
- El cliente remoto no puede elegir arbitrariamente `config`, modelo,
  sandbox ni permisos; los overrides de entorno son administrativos del
  proceso local.
- Las tools de cambios no son read-only. Revisa las aprobaciones de Codex
  antes de aceptar comandos, cambios de archivos o permisos.

## Configuración administrativa

- `HOST` y `PORT`: por defecto `127.0.0.1:8787`.
- `CODEX_AGENT_ALLOW_NON_LOOPBACK=1`: permite un bind no loopback sólo con una
  protección externa equivalente.
- `CODEX_AGENT_ALLOWED_HOSTS`: lista separada por comas de hostnames extra
  aceptados en la cabecera `Host` de `/mcp`. Sólo es necesaria si el Secure MCP
  Tunnel reenvía su propio `Host` en lugar del upstream loopback.
- `CODEX_BIN`: binario local; por defecto `codex`.
- `CODEX_RPC_TIMEOUT_MS`: timeout genérico de RPC; por defecto `30 000` ms.
- `CODEX_SHUTDOWN_TIMEOUT_MS`: espera graceful; por defecto `2 000` ms.
- `CODEX_AGENT_STATE_FILE`: ubicación opcional del state JSON.
- `CODEX_WORKSPACE_ROOT`: raíz administrativa opcional; por defecto
  `~/workspace`. Debe ser una ruta absoluta existente.
- `CODEX_AGENT_MODEL` y `CODEX_AGENT_REASONING_EFFORT`: overrides locales
  opcionales; si no se definen, Codex usa su configuración local.

## Compatibilidad del protocolo

La implementación está fijada contra el protocolo observado de
`codex-cli 0.147.0`, app-server v2. El binario instalado es la autoridad:
OpenAI/Codex puede cambiar independientemente del CLI local.

El cliente usa `initialize` → `initialized`, JSONL bidireccional y los RPC
necesarios `thread/start`, `thread/resume`, `thread/list`, `thread/read`,
`turn/start` y `turn/interrupt`, además de las aprobaciones iniciadas por el
servidor.

Los bindings TypeScript generados en `protocol/codex-0.147.0-ts/` están
versionados porque el código los importa: aportan type-safety durante el build.

Los JSON schemas **no** están versionados. No los consume ni el runtime ni el
build, así que el repositorio no arrastra cientos de archivos derivados. Si los
necesitas como referencia del protocolo, genéralos localmente contra el binario
instalado:

```bash
codex app-server generate-json-schema --out protocol/codex-0.147.0-json-schema
```

Ese directorio está en `.gitignore`. Para actualizar el pin a otra versión,
instala y verifica el nuevo CLI y regenera los bindings:

```bash
codex app-server generate-ts --out protocol/codex-<version>-ts
```

Después hay que revisar imports, aprobaciones y tests contra el binario
instalado.

## Validación local

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

La integración opcional contra el binario instalado se ejecuta así:

```bash
CODEX_REAL_APP_SERVER=1 npm test -- --test-name-pattern='installed codex'
```

## Built using itself

`codex-from-chatgpt` se construyó y validó usando el mismo circuito que
expone: ChatGPT coordinó tareas mediante MCP, el puente creó threads de
Codex local y el app-server devolvió snapshots para revisar el resultado. El
flujo se usó para la implementación, follow-ups, revisiones independientes y
para responder approvals de Codex.

Ese flujo sirve también para mantener el proyecto:

1. Usa `codex_start` para investigar una modificación y sus riesgos.
2. Usa `codex_continue` para implementar o corregir una parte concreta.
3. Usa `codex_get` para revisar diff, archivos, comandos, errores y
   aprobaciones pendientes.
4. Usa `codex_respond_approval` para responder approvals concretas mediante su
   `request_id` exacto.
5. Ejecuta revisiones independientes y después `npm run typecheck`, `npm test`
   y `git diff --check` antes de dar por terminado el cambio.

La idea es que el puente sea a la vez la herramienta de desarrollo y el
artefacto que documenta cómo se utiliza.
