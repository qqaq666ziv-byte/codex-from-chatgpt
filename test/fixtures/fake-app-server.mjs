import readline from "node:readline";

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let pendingUnknownRequest = null;

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && message.error && pendingUnknownRequest !== null) {
    output({ id: pendingUnknownRequest, result: { code: message.error.code } });
    pendingUnknownRequest = null;
    return;
  }
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (message.method === "triggerUnknown") {
    pendingUnknownRequest = message.id;
    output({ id: 900, method: "future/serverRequest", params: {} });
    return;
  }
  if (message.method === "badJson") {
    process.stdout.write("this is not JSON\n");
    return;
  }
  if (message.method === "crash") {
    process.exit(23);
    return;
  }
  if (message.method === "slow") return;
  if (message.id !== undefined) output({ id: message.id, result: {} });
});
