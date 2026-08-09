# Codex Agent

MCP personal, monousuario y local para delegar tareas a la instalación de
Codex de este Mac mediante `codex app-server`.

## Arquitectura

```text
ChatGPT
  -> MCP Streamable HTTP (/mcp)
  -> Codex Agent
  -> codex app-server --stdio (JSONL)
  -> Codex local
```

El servidor no expone shell, filesystem ni comandos arbitrarios como tools
MCP. Codex es quien opera la máquina.

## Requisitos e instalación

- Node.js 20 o posterior.
- `codex-cli 0.147.0` en `PATH` y autenticado localmente.

La V0.1 fija explícitamente cada thread/turn en el modelo `gpt-5.6-luna` con
`reasoning effort: high`, también al usar `codex_continue`.

```bash
npm install
npm run build
npm start
```

Por defecto escucha sólo en `http://127.0.0.1:8787`:

- MCP: `http://127.0.0.1:8787/mcp`
- salud: `http://127.0.0.1:8787/healthz`
- readiness: `http://127.0.0.1:8787/readyz`

`HOST`, `PORT` y `CODEX_BIN` son overrides opcionales; no hacen falta para la
instalación normal. No hay `.env.example` porque V0.1 no necesita secretos ni
variables obligatorias.

## Protocolo Codex observado

En esta instalación:

```text
codex --version                         -> codex-cli 0.147.0
codex app-server --help                 -> --stdio / --listen stdio://
codex app-server generate-ts            -> exit 2: requiere --out <DIR>
codex app-server generate-json-schema   -> exit 2: requiere --out <DIR>
```

Los comandos corregidos generaron los artefactos versionados de esta versión:

```bash
codex app-server generate-ts --out protocol/codex-0.147.0-ts
codex app-server generate-json-schema --out protocol/codex-0.147.0-json-schema
```

El handshake real es `initialize` seguido de la notificación `initialized`.
Por stdio, app-server usa mensajes JSON-RPC sobre JSONL y omite el campo
`jsonrpc` en el cable. V0.1 usa el protocolo v2: `thread/start`, `turn/start`,
`turn/interrupt`, notificaciones `turn/*`/`item/*` y requests de aprobación.

Referencias oficiales: [app-server README de openai/codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) y [MCP interface de openai/codex](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md).

## Tools MCP

- `codex_start({ workspace, prompt })`: valida el workspace, crea un thread
  persistente en el almacenamiento de Codex y comienza un turn.
- `codex_get({ job_id })`: devuelve sólo el resumen estructurado del job.
- `codex_continue({ job_id, prompt })`: continúa el mismo thread cuando no hay
  un turn activo.
- `codex_interrupt({ job_id })`: llama al `turn/interrupt` real.
- `codex_respond_approval({ job_id, decision })`: responde approvals de
  comandos, cambios de archivo o permisos con los valores del schema generado
  por Codex 0.147.0.

Los jobs y su índice viven en memoria. Cada job corresponde a un thread; no hay
Redis, Postgres, cola, worker, Docker, OAuth ni usuarios.

## Flujo mínimo

```text
start = codex_start({
  workspace: "/Users/joseanu/workspace/mi-repo",
  prompt: "Inspecciona el repositorio en solo lectura y resume su estado."
})

codex_get({ job_id: start.job_id })
codex_continue({ job_id: start.job_id, prompt: "Continúa con el mismo contexto." })
codex_get({ job_id: start.job_id })
```

`codex_get` entrega `status`, `thread_id`, `turn_id`, `final_message`,
`latest_diff`, `files_changed`, `commands_executed`, `error` y
`pending_approval`, sin volcar eventos ni logs crudos.

## Límites y seguridad V0.1

- Sólo acepta workspaces existentes bajo `/Users/joseanu/workspace`.
- Rechaza rutas relativas, segmentos `..` y destinos canónicos fuera del root;
  la validación usa `realpath` para evitar escapes por symlink.
- Cada thread inicia con `approvalPolicy: "on-request"`,
  `approvalsReviewer: "user"` y `sandbox: "workspace-write"`; no usa acceso
  irrestricto por defecto.
- El proceso HTTP enlaza a loopback por defecto.
- Los threads son persistentes: reiniciar el MCP pierde los `job_id` en memoria,
  pero el `thread_id` y su historial permanecen en el almacenamiento de Codex
  (`~/.codex/sessions/...`). V0.1 todavía no implementa `thread/list`,
  `thread/read`, `thread/resume`, `codex_list_recent` ni `codex_attach` para
  reconstruir jobs automáticamente.
- Requests de app-server que no son las approvals soportadas se rechazan; V0.1
  no implementa elicitation, dynamic tools ni OAuth.

## QA

```bash
npm test                 # 5 pruebas unitarias enfocadas
npm run typecheck
npm run build
```

También se probó contra el Codex real: start de sólo lectura, polling con get,
continuación en el mismo `thread_id`, interrupt real y una approval de lectura
de `/etc/hosts` que se rechazó sin ejecutar cambios.

## Siguiente paso: Secure MCP Tunnel

Mantén este proceso ejecutándose y verifica `/healthz` y `/readyz`. Después crea
un Secure MCP Tunnel en la cuenta OpenAI siguiendo el flujo/documentación que
muestre la instalación actual del tunnel client, apuntándolo a
`http://127.0.0.1:8787/mcp`; no hace falta publicar este servidor en internet.
En ChatGPT, el siguiente paso es Developer mode → Apps → Create → Connection:
Tunnel, seleccionar ese túnel, revisar las cinco actions y probar la app.

La documentación oficial de ChatGPT indica que un servidor local no se conecta
directamente y que Secure MCP Tunnel es el mecanismo previsto; también advierte
que el MCP completo y las acciones write/modify dependen de la disponibilidad
del plan/workspace. [Ver requisitos y flujo oficial](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).
