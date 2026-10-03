import { acceptanceCLI } from "../scripts/acceptance-runtime.mjs";
import { runSoak } from "../scripts/acceptance-soak.mjs";
await acceptanceCLI("soak", runSoak);
