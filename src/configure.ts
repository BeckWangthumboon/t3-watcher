import {
  DEFAULT_CONFIG_DIR,
  exchangeT3PairingUrl,
  saveT3Connection,
  namedBackendDirectory,
} from "./t3-connection.ts";

const args = Bun.argv.slice(2);
let name: string | undefined;
if (args[0] === "--name") {
  name = args[1];
  args.splice(0, 2);
  if (!name) throw new Error("--name requires a backend name.");
}
const configDir = Bun.env.WATCHER_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;
const directory = name ? namedBackendDirectory(name, configDir) : configDir;
const pairingUrl = args[0]?.trim();
if (!pairingUrl) {
  console.error("Usage: bun run configure [--name <backend-name>] '<T3 pairing URL>'");
  console.error("Create one on the T3 host with: npx t3 pair");
  process.exit(1);
}
if (args.length !== 1) throw new Error("Expected exactly one T3 pairing URL.");

const connection = await exchangeT3PairingUrl(pairingUrl);
await saveT3Connection(connection, directory);

console.log(`Connected T3 Watcher to ${connection.label} (${connection.t3HttpUrl}).`);
console.log(`Saved connection details under ${directory} with owner-only permissions.`);
console.log("Restart the watcher service to load the saved connection.");
