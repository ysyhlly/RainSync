// Intentional behavior-fix inverse, NOT an equivalence transform. It removes
// exactly the new final authority fence before applying older extraction proofs.
// Pure text only; callers provide source. No filesystem/process/database/network.
import assert from "node:assert/strict";
import { rustFunction, replaceOnce } from "./bilibili-login-source-inverse.mjs";

export const oauthDisableFinalLoginGuard = `    // Account-lock waits and local token work can outlive this exact login.
    // Keep existing error priority; an expired login rolls back this whole write.
    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;
`;

export function undoOAuthDisableFinalLoginGuard(source) {
  const operation = rustFunction(source.split("#[cfg(test)]")[0], "set_renewal");
  assert.equal((operation.match(/guard_login_live\(/g) ?? []).length, 1,
    "the behavior fix adds exactly one final live fence to disable");
  assert.ok(operation.endsWith(`    .await?;
${oauthDisableFinalLoginGuard}    let value = status_value(registry, p, Some(&row), &login);
    maintenance::commit(tx).await?;
    Ok(value)
}`), "the new exact-login fence must follow the final read and precede projection/commit");
  return replaceOnce(source, operation, replaceOnce(operation, oauthDisableFinalLoginGuard, ""));
}
