// Explicit adapter required for execution; --dry-run never loads one.
import { acceptanceCLI } from "../scripts/acceptance-runtime.mjs";
import { runNetwork } from "../scripts/acceptance-network.mjs";
await acceptanceCLI("network", runNetwork);
