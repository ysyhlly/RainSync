import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const password = randomBytes(18).toString("base64url");
const db = randomBytes(24).toString("hex");
await mkdir("media", { recursive: true });
await mkdir(".runtime", { recursive: true });
try {
  await writeFile(
    ".env",
    `POSTGRES_PASSWORD=${db}\nADMIN_PASSWORD=${password}\nSOURCE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nMEDIA_PATH=./media\nPUBLIC_ORIGIN=http://localhost:8088\nSITE_ADDRESS=:80\nHTTP_PORT=8088\nHTTPS_PORT=8443\n`,
    { flag: "wx" },
  );
  await writeFile(
    ".runtime/login.txt",
    `Local development login\nURL: http://localhost:8088\nUsername: admin\nPassword: ${password}\n`,
    { mode: 0o600 },
  );
  console.log(
    "Created .env and .runtime/login.txt. Existing configurations are never overwritten.",
  );
} catch (e) {
  if (e.code === "EEXIST") console.log(".env already exists; unchanged.");
  else throw e;
}
