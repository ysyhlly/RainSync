// Explicit bounded native entry; never routes to the formal image verifier.
import { acceptanceCLI } from "../scripts/acceptance-runtime.mjs";
import { runNativeSoakQualification } from "../scripts/acceptance-soak.mjs";
await acceptanceCLI("soak-native-qualification", runNativeSoakQualification);
